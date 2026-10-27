import type { ExpressionSpecification, Map as MapLibreMap } from 'maplibre-gl'
import { useEffect } from 'react'
import { useMapInstance } from '../../hooks/useMapInstance'
import { useAppStore } from '../../store/useAppStore'
import { selectClock, useSimulationStore } from '../../store/useSimulationStore'
import { nightFactorFor } from '../map/lighting'
import { fetchJson } from '../simulation/network'
import { Scenery, type SceneryFile } from './sceneryData'
import { SceneryLayer } from './sceneryLayer'

const POOLS = 'street-light-pools'
/** A pool of light about 14 m across, at true scale from street level; a warm dot further out. */
const POOL_RADIUS: ExpressionSpecification = ['interpolate', ['exponential', 2], ['zoom'], 10, 1.2, 13, 2.6, 15, 9.6, 18, 77, 20, 307]

function addPools(map: MapLibreMap, scenery: Scenery) {
  map.addSource(POOLS, {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: scenery.lampPositions.map((coordinates) => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: {} })),
    },
  })
  map.addLayer(
    {
      id: POOLS,
      type: 'circle',
      source: POOLS,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': POOL_RADIUS,
        'circle-color': '#ffc870',
        'circle-blur': 1,
        'circle-opacity': 0,
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'map',
      },
    },
    map.getLayer('buildings-3d') ? 'buildings-3d' : undefined,
  )
}

/**
 * Resolves once the simulation has its network (or failed, or after 15 s): the
 * trees wait for it, so on a slow connection the streets and traffic come first.
 */
function afterSimulation() {
  return new Promise<void>((resolve) => {
    const done = (status: string) => status === 'ready' || status === 'error'
    if (done(useSimulationStore.getState().status)) return resolve()
    const timer = window.setTimeout(finish, 15_000)
    const unsubscribe = useSimulationStore.subscribe((s) => done(s.status) && finish())
    function finish() {
      window.clearTimeout(timer)
      unsubscribe()
      resolve()
    }
  })
}

/** Loads trees and street lights, and keeps them in step with the layer toggles and the time of day. */
export function useScenery() {
  const map = useMapInstance()

  useEffect(() => {
    if (!map) return
    let layer: SceneryLayer | null = null
    let cancelled = false
    const unsubscribers: (() => void)[] = []

    const apply = () => {
      if (!layer) return
      const { layerVisibility, lightingMode } = useAppStore.getState()
      const night = Math.round(nightFactorFor(lightingMode, selectClock(useSimulationStore.getState())) * 40) / 40
      layer.setVisible(layerVisibility.trees, layerVisibility.streetLights)
      const { season, weather } = useAppStore.getState()
      layer.setAppearance(season, weather === 'snow')
      layer.setNight(night)
      layer.setTreeOpacity(useAppStore.getState().treeOpacity)
      const pools = layerVisibility.streetLights && night > 0.05
      map.setLayoutProperty(POOLS, 'visibility', pools ? 'visible' : 'none')
      map.setPaintProperty(POOLS, 'circle-opacity', ['interpolate', ['linear'], ['zoom'], 11, 0.5 * night, 15, 0.42 * night])
    }

    const base = new URL(import.meta.env.BASE_URL, window.location.href)
    afterSimulation()
      .then(() => (cancelled ? Promise.reject(new Error('cancelled')) : fetchJson<SceneryFile>(new URL('data/gooi-scenery.json', base).href)))
      .then((file) => {
        if (cancelled || !map.getStyle()) return
        const scenery = new Scenery(file)
        addPools(map, scenery)
        layer = new SceneryLayer(scenery)
        // After the vehicles, so they show through see-through trees.
        map.addLayer(layer, map.getLayer('label-water') ? 'label-water' : undefined)
        apply()
        let lastNight = -1
        unsubscribers.push(
          useAppStore.subscribe((s, prev) => {
            if (
              s.layerVisibility !== prev.layerVisibility ||
              s.lightingMode !== prev.lightingMode ||
              s.season !== prev.season ||
              s.weather !== prev.weather ||
              s.seasonSetting !== prev.seasonSetting ||
              s.treeOpacity !== prev.treeOpacity
            )
              apply()
          }),
          useSimulationStore.subscribe((s) => {
            const night = Math.round(nightFactorFor(useAppStore.getState().lightingMode, selectClock(s)) * 40)
            if (night !== lastNight) {
              lastNight = night
              apply()
            }
          }),
        )
      })
      // Scenery is decoration: the map works without it.
      .catch((error) => cancelled || console.warn('[scenery]', error))

    return () => {
      cancelled = true
      for (const unsubscribe of unsubscribers) unsubscribe()
      if (!map.getStyle()) return
      if (layer && map.getLayer(layer.id)) map.removeLayer(layer.id)
      if (map.getLayer(POOLS)) map.removeLayer(POOLS)
      if (map.getSource(POOLS)) map.removeSource(POOLS)
    }
  }, [map])
}

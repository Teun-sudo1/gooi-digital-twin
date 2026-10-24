import type { Feature, LineString } from 'geojson'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { useEffect } from 'react'
import { useMapInstance } from '../../hooks/useMapInstance'
import { useSimulationStore } from '../../store/useSimulationStore'
import type { Comparison } from '../../types/simulation'

/**
 * Colours streets by how much their (simulated) car traffic changed under the
 * road edits: orange where it grew, blue where it fell, wider for bigger
 * changes. Street geometry arrives once per street and is cached here.
 */

const CHANGES = 'traffic-change'
export const BUSIER = '#f76808'
export const QUIETER = '#3e8eed'

function addLayer(map: MapLibreMap) {
  if (map.getSource(CHANGES)) return
  map.addSource(CHANGES, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  const before = map.getLayer('scenario-edits-casing') ? 'scenario-edits-casing' : map.getLayer('buildings-3d') ? 'buildings-3d' : undefined
  map.addLayer(
    {
      id: CHANGES,
      type: 'line',
      source: CHANGES,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['>', ['get', 'diff'], 0], BUSIER, QUIETER],
        'line-opacity': 0.9,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          11, ['interpolate', ['linear'], ['abs', ['get', 'diff']], 0, 2.5, 200, 4.5, 800, 8],
          16, ['interpolate', ['linear'], ['abs', ['get', 'diff']], 0, 6, 200, 12, 800, 22],
        ],
      },
    },
    before,
  )
}

export function useComparisonLayer() {
  const map = useMapInstance()

  useEffect(() => {
    if (!map) return
    const geometry = new Map<number, [number, number][]>()
    addLayer(map)

    const draw = (comparison: Comparison | null, show: boolean) => {
      const features: Feature<LineString>[] = []
      if (comparison && show) {
        for (const street of comparison.streets) {
          const coordinates = geometry.get(street.segment)
          if (!coordinates) continue
          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates },
            properties: { diff: street.scenario - street.original },
          })
        }
      }
      map.getSource<GeoJSONSource>(CHANGES)?.setData({ type: 'FeatureCollection', features })
    }

    const unsubscribe = useSimulationStore.subscribe((s, prev) => {
      if (s.comparison === prev.comparison && s.showChanges === prev.showChanges) return
      for (const street of s.comparison?.streets ?? []) if (street.coordinates) geometry.set(street.segment, street.coordinates)
      draw(s.comparison, s.showChanges)
    })
    return () => {
      unsubscribe()
      if (!map.getStyle()) return
      if (map.getLayer(CHANGES)) map.removeLayer(CHANGES)
      if (map.getSource(CHANGES)) map.removeSource(CHANGES)
    }
  }, [map])
}

import {
  Map as MapLibreMap,
  ScaleControl,
  setWorkerUrl,
  type ErrorEvent,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { useEffect, useRef } from 'react'
import { GOOI_BOUNDS, REGION_VIEW } from '../../data/places'
import type { CameraView } from '../../types/geo'
import { useAppStore } from '../../store/useAppStore'
import { applyBasemapStyle, applyVisibility } from './layers'
import { useSimulationStore } from '../../store/useSimulationStore'
import { nightFactorFor } from './lighting'
import { buildStyle, paletteFor } from './style'

// MapLibre v6 looks for its tile-parsing worker next to its own module file.
// Vite bundles the library, so the worker would not be found; point MapLibre
// at a copy emitted by Vite instead (this works in dev and under the Pages base path).
setWorkerUrl(workerUrl)

/** Camera from a shared link (#zoom/lat/lng/bearing/pitch), if present. */
function viewFromHash(): Partial<CameraView> {
  const [zoom, lat, lng, bearing = 0, pitch = 0] = window.location.hash.slice(1).split('/').map(Number)
  if (![zoom, lat, lng].every(Number.isFinite)) return {}
  return { zoom, center: [lng, lat], bearing, pitch }
}

// Read once at start-up: MapLibre clears the URL hash when a map is removed,
// which happens when React (StrictMode) mounts the map twice in development.
const SHARED_VIEW = viewFromHash()

function hasWebGL() {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * Owns the single MapLibre map. Camera movement is handled entirely by
 * MapLibre, so panning and zooming never trigger React renders. React only
 * pushes layer visibility changes into the map.
 */
export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const map = useAppStore((s) => s.map)
  const mapStatus = useAppStore((s) => s.mapStatus)
  const layerVisibility = useAppStore((s) => s.layerVisibility)
  const basemap = useAppStore((s) => s.basemap)

  useEffect(() => {
    const { setMap, setMapStatus } = useAppStore.getState()
    if (!containerRef.current) return
    if (!hasWebGL()) {
      setMapStatus('error', 'Your browser does not support WebGL, which the 3D map needs.')
      return
    }

    const instance = new MapLibreMap({
      container: containerRef.current,
      // Start in the right light for the simulated time, so there is no flash on load.
      style: buildStyle(paletteFor(nightFactorFor(useAppStore.getState().lightingMode, useSimulationStore.getState().startClock))),
      ...REGION_VIEW,
      ...SHARED_VIEW,
      minZoom: 10,
      maxZoom: 19,
      maxPitch: 78,
      maxBounds: GOOI_BOUNDS,
      // Keeps the camera in the URL (#zoom/lat/lng/bearing/pitch) so views can be shared.
      hash: true,
      attributionControl: { compact: true },
    })
    instance.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left')

    let loaded = false
    instance.on('load', () => {
      loaded = true
      // On phones the credits start folded behind their (i) button.
      if (window.matchMedia('(max-width: 640px)').matches) {
        instance.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show')
      }
      setMapStatus('ready')
    })
    instance.on('error', (event: ErrorEvent) => {
      // Before the style has loaded an error means the map cannot render at all.
      // Afterwards, errors are usually individual tiles and the map keeps working.
      if (!loaded) {
        setMapStatus('error', 'The map data could not be loaded. Check your connection and try again.')
      }
      console.warn('[map]', event.error?.message ?? event)
    })

    setMap(instance)
    // Handy for debugging in the browser console during development.
    if (import.meta.env.DEV) (window as unknown as { map?: MapLibreMap }).map = instance
    return () => {
      setMap(null)
      setMapStatus('loading')
      instance.remove()
    }
  }, [])

  useEffect(() => {
    if (map && mapStatus === 'ready') applyVisibility(map, layerVisibility, basemap)
  }, [map, mapStatus, layerVisibility, basemap])

  useEffect(() => {
    if (map && mapStatus === 'ready') applyBasemapStyle(map, basemap)
  }, [map, mapStatus, basemap])

  return <div ref={containerRef} className="map" />
}

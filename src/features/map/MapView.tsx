import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type ErrorEvent,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { useEffect, useRef } from 'react'
import { GOOI_BOUNDS, HUIZEN_VIEW } from '../../data/places'
import { useAppStore } from '../../store/useAppStore'
import { applyVisibility } from './layers'
import { buildStyle } from './style'

// MapLibre v6 looks for its tile-parsing worker next to its own module file.
// Vite bundles the library, so the worker would not be found; point MapLibre
// at a copy emitted by Vite instead (this works in dev and under the Pages base path).
setWorkerUrl(workerUrl)

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

  useEffect(() => {
    const { setMap, setMapStatus } = useAppStore.getState()
    if (!containerRef.current) return
    if (!hasWebGL()) {
      setMapStatus('error', 'Your browser does not support WebGL, which the 3D map needs.')
      return
    }

    const instance = new MapLibreMap({
      container: containerRef.current,
      style: buildStyle(),
      ...HUIZEN_VIEW,
      minZoom: 10,
      maxZoom: 19,
      maxPitch: 78,
      maxBounds: GOOI_BOUNDS,
      // Keeps the camera in the URL (#zoom/lat/lng/bearing/pitch) so views can be shared.
      hash: true,
      attributionControl: { compact: true },
    })
    instance.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    instance.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left')

    let loaded = false
    instance.on('load', () => {
      loaded = true
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
    return () => {
      setMap(null)
      setMapStatus('loading')
      instance.remove()
    }
  }, [])

  useEffect(() => {
    if (map && mapStatus === 'ready') applyVisibility(map, layerVisibility)
  }, [map, mapStatus, layerVisibility])

  return <div ref={containerRef} className="map" />
}

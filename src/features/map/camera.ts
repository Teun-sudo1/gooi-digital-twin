import type { Map as MapLibreMap } from 'maplibre-gl'
import type { CameraView } from '../../types/geo'

/** Smooth camera transition to a preset view. */
export function flyToView(map: MapLibreMap, view: CameraView) {
  map.flyTo({ ...view, duration: 2400, curve: 1.4, essential: true })
}

/** Switch between a top-down 2D view and an oblique 3D view, keeping the current location. */
export function togglePitch(map: MapLibreMap) {
  const is3d = map.getPitch() > 10
  map.easeTo({ pitch: is3d ? 0 : 60, bearing: is3d ? 0 : map.getBearing() || -20, duration: 900 })
}

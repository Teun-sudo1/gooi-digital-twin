import { HUIZEN_VIEW } from '../data/places'
import { flyToView, togglePitch } from '../features/map/camera'
import { useMapInstance } from '../hooks/useMapInstance'

export function CameraControls() {
  const map = useMapInstance()

  return (
    <div className="camera-controls panel" role="group" aria-label="Camera">
      <button
        disabled={!map}
        onClick={() => map && flyToView(map, HUIZEN_VIEW)}
        title="Reset view to Huizen"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5v2.5h2.5" />
        </svg>
        Reset
      </button>
      <button disabled={!map} onClick={() => map && togglePitch(map)} title="Toggle 2D / 3D">
        2D / 3D
      </button>
    </div>
  )
}

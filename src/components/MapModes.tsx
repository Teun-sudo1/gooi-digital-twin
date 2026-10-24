import { MAP_MODES, type MapMode } from '../features/map/mapModes'
import { useAppStore } from '../store/useAppStore'

/** A real aerial photo tile over Huizen (PDOK Luchtfoto) for the Satellite thumbnail. */
const AERIAL_TILE = 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/17/67444/43117.jpeg'

/** A small street scene shared by the drawn thumbnails. */
function Streets() {
  return (
    <>
      <rect width="64" height="64" fill="#eef0f3" />
      <rect x="40" y="4" width="20" height="16" rx="2" fill="#cfe5c4" />
      <rect x="6" y="40" width="12" height="9" rx="1.5" fill="#dfe2e7" />
      <rect x="22" y="48" width="10" height="10" rx="1.5" fill="#dfe2e7" />
      <rect x="44" y="40" width="12" height="8" rx="1.5" fill="#dfe2e7" />
      <path d="M-4 24 L68 36" stroke="#ffffff" strokeWidth="5" />
      <path d="M30 -4 L22 68" stroke="#ffffff" strokeWidth="4" />
    </>
  )
}

function Thumbnail({ mode }: { mode: MapMode }) {
  if (mode === 'satellite') return <img src={AERIAL_TILE} alt="" loading="lazy" />
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <Streets />
      {mode === 'explore' && (
        <>
          <path d="M-4 52 L68 8" stroke="#b9c0c9" strokeWidth="7" />
          <path d="M-4 52 L68 8" stroke="#ffffff" strokeWidth="5" />
          <circle cx="12" cy="18" r="2.5" fill="#e5484d" />
          <circle cx="50" cy="28" r="2.5" fill="#f5a524" />
        </>
      )}
      {mode === 'driving' && (
        <>
          <path d="M-4 52 L68 8" stroke="#b9c0c9" strokeWidth="9" />
          <path d="M-4 52 L22 36" stroke="#30a46c" strokeWidth="6" />
          <path d="M22 36 L42 24" stroke="#f76808" strokeWidth="6" />
          <path d="M42 24 L68 8" stroke="#c62a2f" strokeWidth="6" />
          <path d="M-4 24 L68 36" stroke="#e2b203" strokeWidth="3" />
        </>
      )}
      {mode === 'transit' && (
        <>
          <path d="M-4 46 C20 40 40 22 68 18" stroke="#e5484d" strokeWidth="3.5" fill="none" />
          <path d="M-4 51 C20 45 40 27 68 23" stroke="#ffc917" strokeWidth="3.5" fill="none" />
          <path d="M-4 56 C20 50 40 32 68 28" stroke="#3e63dd" strokeWidth="3.5" fill="none" />
          <path d="M36 -4 C38 20 30 40 44 68" stroke="#f76808" strokeWidth="3" fill="none" />
          <path d="M-4 14 C16 20 22 34 30 68" stroke="#30a46c" strokeWidth="3" fill="none" />
          <circle cx="33" cy="33" r="3" fill="#ffffff" stroke="#3e63dd" strokeWidth="1.5" />
        </>
      )}
    </svg>
  )
}

/** One-tap presets for what the map shows. */
export function MapModes() {
  const mapMode = useAppStore((s) => s.mapMode)
  const setMapMode = useAppStore((s) => s.setMapMode)
  return (
    <div className="map-modes" role="radiogroup" aria-label="Map mode">
      {MAP_MODES.map((mode) => (
        <button
          key={mode.id}
          role="radio"
          aria-checked={mapMode === mode.id}
          className={`map-mode ${mapMode === mode.id ? 'active' : ''}`}
          title={mode.description}
          onClick={() => setMapMode(mode.id)}
        >
          <span className="map-mode-thumb">
            <Thumbnail mode={mode.id} />
          </span>
          <span>{mode.label}</span>
        </button>
      ))}
    </div>
  )
}

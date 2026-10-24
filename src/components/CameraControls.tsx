import { useEffect, useRef } from 'react'
import { REGION_VIEW } from '../data/places'
import { flyToView, togglePitch } from '../features/map/camera'
import { getRotator, resetNorth, ROTATE_STEP, rotateBy } from '../features/map/rotation'
import { useMapInstance } from '../hooks/useMapInstance'
import { useAppStore } from '../store/useAppStore'

/** A press shorter than this is a tap (step rotation); longer starts continuous rotation. */
const HOLD_DELAY_MS = 180

function RotateButton({ direction }: { direction: -1 | 1 }) {
  const map = useMapInstance()
  const holdTimer = useRef<number | null>(null)
  const holding = useRef(false)
  const source = `button-${direction}`

  const release = (tap: boolean) => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
      if (tap && map) rotateBy(map, direction * ROTATE_STEP)
    }
    if (holding.current && map) getRotator(map).stop(source)
    holding.current = false
  }

  const label = direction < 0 ? 'Rotate left' : 'Rotate right'
  return (
    <button
      disabled={!map}
      aria-label={label}
      title={`${label} · tap or hold (${direction < 0 ? 'Q' : 'E'})`}
      onPointerDown={(event) => {
        if (!map || event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        holdTimer.current = window.setTimeout(() => {
          holdTimer.current = null
          holding.current = true
          getRotator(map).start(source, direction)
        }, HOLD_DELAY_MS)
      }}
      onPointerUp={() => release(true)}
      onPointerCancel={() => release(false)}
      onClick={(event) => {
        // Keyboard activation (Enter/Space) produces a click without pointer events.
        if (event.detail === 0 && map) rotateBy(map, direction * ROTATE_STEP)
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" style={direction > 0 ? { transform: 'scaleX(-1)' } : undefined}>
        <path d="M13 9.5A5 5 0 1 1 9.5 3.2M9.5 3.2 7.2 1.5M9.5 3.2 7.6 5.3" />
      </svg>
    </button>
  )
}

export function CameraControls() {
  const map = useMapInstance()
  const needleRef = useRef<SVGSVGElement>(null)
  const shortcutsOpen = useAppStore((s) => s.shortcutsOpen)
  const setShortcutsOpen = useAppStore((s) => s.setShortcutsOpen)

  // Keep the compass needle in sync with the map without re-rendering React.
  useEffect(() => {
    if (!map) return
    const update = () => {
      if (needleRef.current) needleRef.current.style.transform = `rotate(${-map.getBearing()}deg)`
    }
    update()
    map.on('rotate', update)
    return () => {
      map.off('rotate', update)
    }
  }, [map])

  return (
    <div className="camera-controls panel" role="group" aria-label="Camera">
      <RotateButton direction={-1} />
      <button
        disabled={!map}
        onClick={() => map && resetNorth(map)}
        aria-label="Face north"
        title="Face north (N)"
      >
        <svg ref={needleRef} viewBox="0 0 16 16" aria-hidden="true" className="compass">
          <path d="M8 1.5 10.5 8h-5z" className="compass-north" />
          <path d="M8 14.5 5.5 8h5z" />
        </svg>
      </button>
      <RotateButton direction={1} />
      <hr />
      <button
        disabled={!map}
        onClick={() => map && togglePitch(map)}
        aria-label="Toggle 2D / 3D"
        title="Toggle 2D / 3D (T)"
        className="text-button"
      >
        3D
      </button>
      <button
        disabled={!map}
        onClick={() => map && flyToView(map, REGION_VIEW)}
        aria-label="Reset view to the region"
        title="Reset view to the region (H)"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5" />
        </svg>
      </button>
      <hr />
      <button disabled={!map} onClick={() => map?.zoomIn()} aria-label="Zoom in" title="Zoom in (+)">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      <button disabled={!map} onClick={() => map?.zoomOut()} aria-label="Zoom out" title="Zoom out (−)">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8h10" />
        </svg>
      </button>
      <hr />
      <button
        onClick={() => setShortcutsOpen(!shortcutsOpen)}
        aria-label="Keyboard shortcuts"
        aria-expanded={shortcutsOpen}
        title="Keyboard shortcuts (?)"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
          <path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6" />
        </svg>
      </button>
    </div>
  )
}

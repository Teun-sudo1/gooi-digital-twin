import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useIsMobile } from '../hooks/useIsMobile'
import { useAppStore } from '../store/useAppStore'

/** Remembered per browser, so the tour opens by itself only on the first visit. */
const SEEN_KEY = 'gooi-tour-seen'
const CARD_WIDTH = 320
const GAP = 14

interface Step {
  title: string
  text: string
  /** The part of the screen to point at (desktop, phone); none for the map itself. */
  target?: [string, string]
  /** Open the map panel first, so there is something to point at. */
  openLayers?: boolean
}

const STEPS: Step[] = [
  {
    title: 'Welcome to the Gooi Digital Twin',
    text: 'A 3D model of the Gooi region. Streets, buildings, trees and the bus and train timetables are real data. Everything that moves is simulated by a model, not measured.',
  },
  {
    title: 'Time and speed',
    text: 'Play or pause, pick a time of day to see the morning rush or a quiet night, speed time up, and set how much traffic there is.',
    target: ['.sim-bar', '.sim-bar'],
  },
  {
    title: 'Follow anything',
    text: 'Click a car, bus or train to follow it with the camera. A bus shows its whole route with waiting passengers; click a stop to see its departures.',
  },
  {
    title: 'Change the roads',
    text: 'Close a road, make it car-free or bus-only, change a speed limit or draw a new cycle path. Traffic reroutes at once, and the statistics compare it with the original.',
    target: ['.scenario-panel', '.mobile-tabs button:nth-child(2)'],
  },
  {
    title: 'Map modes and layers',
    text: 'Driving shows busy streets, Transit the bus and train lines, Satellite aerial photos. Below them: weather, season, traffic lights and how see-through the trees are.',
    target: ['.layer-panel', '.mobile-tabs button:nth-child(3)'],
    openLayers: true,
  },
  {
    title: 'Simulated statistics',
    text: 'Live numbers for the whole region, and a chart of the simulated day against the expected demand.',
    target: ['.dashboard', '.mobile-tabs button:nth-child(1)'],
  },
  {
    title: 'Moving around',
    text: 'Drag to pan, right-drag or Ctrl-drag to turn and tilt, scroll to zoom. W A S D move the map too, faster with Shift. These buttons reset the view and list every shortcut.',
    target: ['.camera-controls', '.camera-controls'],
  },
]

function seen() {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}

function markSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Without storage the tour may open again next time; that's all.
  }
}

/** A short guided tour: a card per feature, with the part of the screen it's about lit up. */
export function Tour() {
  const open = useAppStore((s) => s.tourOpen)
  const ready = useAppStore((s) => s.mapStatus === 'ready')
  const mobile = useIsMobile()
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const next = useRef<HTMLButtonElement>(null)

  // First visit: open once the map is there.
  useEffect(() => {
    if (ready && !seen()) useAppStore.setState({ tourOpen: true })
  }, [ready])

  const current = STEPS[step]
  const selector = current.target?.[mobile ? 1 : 0]

  useLayoutEffect(() => {
    if (!open) return
    if (current.openLayers && !mobile) useAppStore.setState({ layerPanelOpen: true })
    const measure = () => {
      const el = selector ? document.querySelector(selector) : null
      setRect(el ? el.getBoundingClientRect() : null)
    }
    measure()
    // Panels can still be opening or resizing.
    const timer = window.setTimeout(measure, 250)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', measure)
    }
  }, [open, step, selector, mobile, current.openLayers])

  useEffect(() => {
    if (open) next.current?.focus()
  }, [open, step])

  if (!open) return null

  const close = () => {
    markSeen()
    setStep(0)
    useAppStore.setState({ tourOpen: false })
  }
  const last = step === STEPS.length - 1

  // Beside the highlighted part when there's room, otherwise centred.
  let style: React.CSSProperties = {}
  if (rect && !mobile) {
    const left = rect.left + rect.width / 2 > window.innerWidth / 2 ? rect.left - CARD_WIDTH - GAP : rect.right + GAP
    const top = Math.min(Math.max(16, rect.top), window.innerHeight - 260)
    style = { left: Math.max(16, Math.min(left, window.innerWidth - CARD_WIDTH - 16)), top, transform: 'none' }
    // A wide part (the bottom bar): sit above it instead.
    if (rect.width > window.innerWidth / 2) style = { left: '50%', top: 'auto', bottom: window.innerHeight - rect.top + GAP, transform: 'translateX(-50%)' }
  }

  return (
    <div className="tour" onKeyDown={(e) => e.key === 'Escape' && close()}>
      {rect ? (
        <div
          className="tour-spotlight"
          style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }}
          aria-hidden="true"
        />
      ) : (
        <div className="tour-backdrop" aria-hidden="true" />
      )}
      <section className="tour-card panel" style={style} role="dialog" aria-labelledby="tour-title" aria-describedby="tour-text">
        <div className="tour-progress" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <span key={s.title} className={i === step ? 'active' : undefined} />
          ))}
        </div>
        <h2 id="tour-title">{current.title}</h2>
        <p id="tour-text">{current.text}</p>
        <div className="tour-actions">
          <button className="tour-skip" onClick={close}>
            {last ? 'Close' : 'Skip tour'}
          </button>
          <span>
            {step > 0 && (
              <button className="tour-back" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            <button ref={next} className="tour-next" onClick={() => (last ? close() : setStep(step + 1))}>
              {last ? 'Done' : 'Next'}
            </button>
          </span>
        </div>
      </section>
    </div>
  )
}

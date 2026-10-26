import { useEffect, useRef, useState } from 'react'
import { WEATHER_LABELS, type WeatherSetting } from '../features/environment/environment'
import { START_TIMES, type CinematicStyle } from '../features/cinematic/cinematic'
import { useCinematic } from '../features/cinematic/useCinematic'
import { useAppStore } from '../store/useAppStore'
import { useSimulationStore } from '../store/useSimulationStore'

/** Choose the time of day and the weather, then start the flight. */
function CinematicSetup() {
  const current = useAppStore((s) => s.weatherSetting)
  const [time, setTime] = useState(1)
  const [weather, setWeather] = useState<WeatherSetting>(current)
  const [style, setStyle] = useState<CinematicStyle>(useAppStore.getState().cinematicStyle)
  const start = useRef<HTMLButtonElement>(null)

  useEffect(() => start.current?.focus(), [])

  const cancel = () => useAppStore.setState({ cinematic: null })
  const begin = () => {
    const { controller } = useSimulationStore.getState()
    const clock = START_TIMES[time].clock
    if (controller) {
      if (clock !== null) controller.setClock(clock)
      controller.setFollow(null)
      // The drive sets its own speed; the flight watches traffic at its normal pace.
      if (style === 'fly') controller.setSpeed(1)
      controller.setPlaying(true)
    }
    // The sun follows the chosen time; panels and tours make way.
    useAppStore.setState({ cinematic: 'playing', cinematicStyle: style, weatherSetting: weather, lightingMode: 'auto', tourOpen: false, shortcutsOpen: false })
  }

  return (
    <div className="cinematic-backdrop" onKeyDown={(e) => e.key === 'Escape' && cancel()}>
      <section className="cinematic-setup panel" role="dialog" aria-modal="true" aria-labelledby="cinematic-title">
        <h2 id="cinematic-title">Cinematic mode</h2>
        <p>Sit back and watch the Gooi. Press any key or move the map to stop.</p>
        <fieldset>
          <legend>Camera</legend>
          <div className="cinematic-options">
            {(
              [
                ['drive', 'Follow a car through every town'],
                ['fly', 'Fly over the region'],
              ] as const
            ).map(([id, label]) => (
              <label key={id} className={style === id ? 'active' : undefined}>
                <input type="radio" name="cinematic-style" checked={style === id} onChange={() => setStyle(id)} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Time of day</legend>
          <div className="cinematic-options">
            {START_TIMES.map((t, i) => (
              <label key={t.label} className={time === i ? 'active' : undefined}>
                <input type="radio" name="cinematic-time" checked={time === i} onChange={() => setTime(i)} />
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Weather</legend>
          <div className="cinematic-options">
            {(Object.keys(WEATHER_LABELS) as WeatherSetting[]).map((w) => (
              <label key={w} className={weather === w ? 'active' : undefined}>
                <input type="radio" name="cinematic-weather" checked={weather === w} onChange={() => setWeather(w)} />
                {WEATHER_LABELS[w]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="cinematic-actions">
          <button className="cinematic-cancel" onClick={cancel}>
            Cancel
          </button>
          <button ref={start} className="cinematic-start" onClick={begin}>
            Start
          </button>
        </div>
      </section>
    </div>
  )
}

/** Letterbox bars, the place being shown, and a way out. */
function CinematicOverlay() {
  const caption = useCinematic()
  return (
    <div className="cinematic-overlay" aria-live="polite">
      <div className="letterbox top" aria-hidden="true" />
      <div className="letterbox bottom" aria-hidden="true" />
      {caption && (
        <div className="cinematic-caption" key={caption.title}>
          <strong>{caption.title}</strong>
          <span>{caption.subtitle}</span>
        </div>
      )}
      <span className="cinematic-badge">Simulated traffic</span>
      <button className="cinematic-exit" onClick={() => useAppStore.setState({ cinematic: null })}>
        Exit · Esc
      </button>
    </div>
  )
}

export function Cinematic() {
  const mode = useAppStore((s) => s.cinematic)
  if (mode === 'setup') return <CinematicSetup />
  if (mode === 'playing') return <CinematicOverlay />
  return null
}

/** The button in the top bar that opens cinematic mode. */
export function CinematicButton() {
  const ready = useSimulationStore((s) => s.status === 'ready')
  return (
    <button className="cinematic-button" disabled={!ready} onClick={() => useAppStore.setState({ cinematic: 'setup' })} title="Watch the region: follow a car or fly over">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="3.5" width="9" height="9" rx="1.5" />
        <path d="m10.5 7 4-2.5v7l-4-2.5" />
      </svg>
      Cinematic
    </button>
  )
}

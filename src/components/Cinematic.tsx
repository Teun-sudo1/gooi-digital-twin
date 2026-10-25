import { useEffect, useRef, useState } from 'react'
import { WEATHER_LABELS, type WeatherSetting } from '../features/environment/environment'
import { START_TIMES } from '../features/cinematic/cinematic'
import { useCinematic } from '../features/cinematic/useCinematic'
import { useAppStore } from '../store/useAppStore'
import { useSimulationStore } from '../store/useSimulationStore'

/** Choose the time of day and the weather, then start the flight. */
function CinematicSetup() {
  const current = useAppStore((s) => s.weatherSetting)
  const [time, setTime] = useState(1)
  const [weather, setWeather] = useState<WeatherSetting>(current)
  const start = useRef<HTMLButtonElement>(null)

  useEffect(() => start.current?.focus(), [])

  const cancel = () => useAppStore.setState({ cinematic: null })
  const begin = () => {
    const { controller } = useSimulationStore.getState()
    const clock = START_TIMES[time].clock
    if (controller) {
      if (clock !== null) controller.setClock(clock)
      controller.setFollow(null)
      controller.setSpeed(1)
      controller.setPlaying(true)
    }
    // The sun follows the chosen time; panels and tours make way.
    useAppStore.setState({ cinematic: 'playing', weatherSetting: weather, lightingMode: 'auto', tourOpen: false, shortcutsOpen: false })
  }

  return (
    <div className="cinematic-backdrop" onKeyDown={(e) => e.key === 'Escape' && cancel()}>
      <section className="cinematic-setup panel" role="dialog" aria-modal="true" aria-labelledby="cinematic-title">
        <h2 id="cinematic-title">Cinematic flight</h2>
        <p>A slow flight through the Gooi, from the whole region down to its streets. Press any key or move the map to stop.</p>
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
            Start flight
          </button>
        </div>
      </section>
    </div>
  )
}

/** Letterbox bars, the place being shown, and a way out. */
function CinematicOverlay() {
  const shot = useCinematic()
  return (
    <div className="cinematic-overlay" aria-live="polite">
      <div className="letterbox top" aria-hidden="true" />
      <div className="letterbox bottom" aria-hidden="true" />
      {shot && (
        <div className="cinematic-caption" key={shot.title + shot.subtitle}>
          <strong>{shot.title}</strong>
          <span>{shot.subtitle}</span>
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
    <button className="cinematic-button" disabled={!ready} onClick={() => useAppStore.setState({ cinematic: 'setup' })} title="Fly through the region">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="3.5" width="9" height="9" rx="1.5" />
        <path d="m10.5 7 4-2.5v7l-4-2.5" />
      </svg>
      Cinematic
    </button>
  )
}

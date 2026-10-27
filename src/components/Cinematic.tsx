import { useEffect, useRef, useState } from 'react'
import { WEATHER_LABELS, type WeatherSetting } from '../features/environment/environment'
import { START_TIMES, type CinematicStyle } from '../features/cinematic/cinematic'
import { ARTIST, MUSIC_SOURCE, useMusic } from '../features/cinematic/music'
import { useCinematic } from '../features/cinematic/useCinematic'
import { useAppStore } from '../store/useAppStore'
import { useSimulationStore } from '../store/useSimulationStore'

/** Choose the camera, time of day, weather, labels and trees, then start. */
function CinematicSetup() {
  const current = useAppStore((s) => s.weatherSetting)
  const [labels, setLabels] = useState(useAppStore.getState().layerVisibility.labels)
  const [trees, setTrees] = useState(useAppStore.getState().treeOpacity)
  const [music, setMusic] = useState(useAppStore.getState().cinematicMusic)
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
    // Snow comes with winter trees; leaving snow behind goes back to today's season.
    const { seasonSetting, weatherSetting } = useAppStore.getState()
    const season = weather === 'snow' ? 'winter' : weatherSetting === 'snow' && seasonSetting === 'winter' ? 'auto' : seasonSetting
    useAppStore.setState((s) => ({
      cinematic: 'playing',
      cinematicStyle: style,
      cinematicMusic: music,
      weatherSetting: weather,
      seasonSetting: season,
      lightingMode: 'auto',
      tourOpen: false,
      shortcutsOpen: false,
      layerVisibility: { ...s.layerVisibility, labels },
      treeOpacity: trees,
    }))
  }

  return (
    <div className="cinematic-backdrop" onKeyDown={(e) => e.key === 'Escape' && cancel()}>
      <section className="cinematic-setup panel" role="dialog" aria-modal="true" aria-labelledby="cinematic-title">
        <h2 id="cinematic-title">Cinematic mode</h2>
        <p>
          Sit back and watch the Gooi. <kbd>Space</kbd> pauses, <kbd>1</kbd>–<kbd>4</kbd> set the speed, <kbd>M</kbd> mutes, <kbd>N</kbd> skips a track;{' '}
          <kbd>Esc</kbd> or moving the map stops.
        </p>
        <fieldset>
          <legend>Camera</legend>
          <div className="cinematic-options">
            {(
              [
                ['drive', 'Follow a car through every town'],
                ['ride', 'Ride along with a bus'],
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
        <fieldset>
          <legend>Map</legend>
          <div className="cinematic-options">
            {(
              [
                [true, 'Labels on'],
                [false, 'Labels off'],
              ] as const
            ).map(([on, label]) => (
              <label key={label} className={labels === on ? 'active' : undefined}>
                <input type="radio" name="cinematic-labels" checked={labels === on} onChange={() => setLabels(on)} />
                {label}
              </label>
            ))}
          </div>
          <div className="cinematic-range">
            <label htmlFor="cinematic-trees">Tree opacity</label>
            <input id="cinematic-trees" type="range" min={10} max={100} step={5} value={Math.round(trees * 100)} onChange={(e) => setTrees(Number(e.target.value) / 100)} />
            <output htmlFor="cinematic-trees" className="range-value">
              {Math.round(trees * 100)}%
            </output>
          </div>
        </fieldset>
        <fieldset>
          <legend>Music</legend>
          <div className="cinematic-options">
            {(
              [
                [true, 'Lofi'],
                [false, 'Off'],
              ] as const
            ).map(([on, label]) => (
              <label key={label} className={music === on ? 'active' : undefined}>
                <input type="radio" name="cinematic-music" checked={music === on} onChange={() => setMusic(on)} />
                {label}
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
  const musicOn = useAppStore((s) => s.cinematicMusic)
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
      <SpeedBadge />
      {musicOn && <MusicControls />}
      <button className="cinematic-exit" onClick={() => useAppStore.setState({ cinematic: null })}>
        Exit · Esc
      </button>
    </div>
  )
}

/** That the traffic is simulated, and at what speed (or paused). */
function SpeedBadge() {
  const playing = useSimulationStore((s) => s.playing)
  const speed = useSimulationStore((s) => s.speed)
  return <span className="cinematic-badge">Simulated traffic · {playing ? `${speed}×` : 'paused'}</span>
}

/** What is playing, and next, mute and volume (also M and N). Pauses with the simulation. */
function MusicControls() {
  const playing = useSimulationStore((s) => s.playing)
  const music = useMusic(true, !playing)
  const { next, toggleMute } = music
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      const key = event.key.toLowerCase()
      if (key === 'm') toggleMute()
      else if (key === 'n') next()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [next, toggleMute])
  if (!music.track) return null
  return (
    <div className="cinematic-music">
      <span className="cinematic-track" title={`${music.track.title} by ${ARTIST} (CC0)`}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 12.5V3.5l7-1.5v9" />
          <circle cx="4.5" cy="12.5" r="1.8" />
          <circle cx="11.5" cy="11" r="1.8" />
        </svg>
        <span>
          {music.track.title}
          <a href={MUSIC_SOURCE} target="_blank" rel="noreferrer">
            {ARTIST} · CC0
          </a>
        </span>
      </span>
      {music.blocked ? (
        <button onClick={music.resume}>Play music</button>
      ) : (
        <>
          <button onClick={music.next} aria-label="Next track" title="Next track">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 3.5v9l7-4.5zM12.5 3.5v9" />
            </svg>
          </button>
          <button onClick={music.toggleMute} aria-label={music.muted ? 'Unmute' : 'Mute'} aria-pressed={music.muted} title={music.muted ? 'Unmute' : 'Mute'}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z" />
              {music.muted ? <path d="m11 6 4 4m0-4-4 4" /> : <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4" />}
            </svg>
          </button>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round(music.volume * 100)}
            aria-label="Music volume"
            onChange={(e) => music.setVolume(Number(e.target.value) / 100)}
          />
        </>
      )}
    </div>
  )
}

/** Cinematic mode: loaded on demand (see App), so it isn't part of the first download. */
export default function Cinematic() {
  const mode = useAppStore((s) => s.cinematic)
  if (mode === 'setup') return <CinematicSetup />
  if (mode === 'playing') return <CinematicOverlay />
  return null
}

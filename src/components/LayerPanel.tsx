import { SEASON_LABELS, WEATHER_LABELS, type SeasonSetting, type WeatherSetting } from '../features/environment/environment'
import type { LightingMode } from '../features/map/lighting'
import { LAYER_GROUPS } from '../features/map/layers'
import { MAP_MODES } from '../features/map/mapModes'
import { useAppStore } from '../store/useAppStore'
import { MapModes } from './MapModes'

export function LayerPanel({ embedded = false }: { embedded?: boolean }) {
  const open = useAppStore((s) => s.layerPanelOpen)
  const setOpen = useAppStore((s) => s.setLayerPanelOpen)
  const visibility = useAppStore((s) => s.layerVisibility)
  const toggleLayer = useAppStore((s) => s.toggleLayer)
  const lightingMode = useAppStore((s) => s.lightingMode)
  const setLightingMode = useAppStore((s) => s.setLightingMode)
  const weatherSetting = useAppStore((s) => s.weatherSetting)
  const seasonSetting = useAppStore((s) => s.seasonSetting)
  const liveWeather = useAppStore((s) => s.liveWeather)
  const weather = useAppStore((s) => s.weather)
  const mapMode = useAppStore((s) => s.mapMode)
  const modes: { id: LightingMode; label: string }[] = [
    { id: 'auto', label: 'Sun' },
    { id: 'day', label: 'Day' },
    { id: 'night', label: 'Night' },
  ]

  return (
    <aside className={`panel layer-panel ${open || embedded ? 'open' : ''} ${embedded ? 'embedded' : ''}`}>
      {!embedded && (
        <button
          className="panel-header"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls="layer-list"
        >
          <span>
            Map · <span className="current-mode">{MAP_MODES.find((m) => m.id === mapMode)?.label}</span>
          </span>
          <svg viewBox="0 0 16 16" aria-hidden="true" className="chevron">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>
      )}
      {(open || embedded) && (
        <ul id="layer-list" className="layer-list">
          <li>
            <MapModes />
          </li>
          {LAYER_GROUPS.map((group) => (
            <li key={group.id}>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={visibility[group.id]}
                  onChange={() => toggleLayer(group.id)}
                />
                <span className="switch" aria-hidden="true" />
                <span>{group.label}</span>
              </label>
            </li>
          ))}
          <li className="lighting">
            <span id="lighting-label">Lighting</span>
            <div className="segmented small" role="radiogroup" aria-labelledby="lighting-label">
              {modes.map((m) => (
                <button
                  key={m.id}
                  role="radio"
                  aria-checked={lightingMode === m.id}
                  className={lightingMode === m.id ? 'active' : undefined}
                  title={m.id === 'auto' ? 'Follow the sun at the simulated time' : undefined}
                  onClick={() => setLightingMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </li>
          <li className="lighting">
            <label htmlFor="weather-select">Weather</label>
            <select
              id="weather-select"
              value={weatherSetting}
              onChange={(e) => useAppStore.setState({ weatherSetting: e.target.value as WeatherSetting })}
            >
              {(Object.keys(WEATHER_LABELS) as WeatherSetting[]).map((w) => (
                <option key={w} value={w}>
                  {w === 'live' ? `Live${liveWeather ? `: ${WEATHER_LABELS[weather].toLowerCase()}, ${Math.round(liveWeather.temperature)}°C` : ''}` : WEATHER_LABELS[w]}
                </option>
              ))}
            </select>
          </li>
          <li className="lighting">
            <label htmlFor="season-select">Season</label>
            <select
              id="season-select"
              value={seasonSetting}
              onChange={(e) => useAppStore.setState({ seasonSetting: e.target.value as SeasonSetting })}
              title="Sets the trees, the colour of the land and the sun's path"
            >
              {(Object.keys(SEASON_LABELS) as SeasonSetting[]).map((s) => (
                <option key={s} value={s}>
                  {SEASON_LABELS[s]}
                </option>
              ))}
            </select>
          </li>
        </ul>
      )}
    </aside>
  )
}

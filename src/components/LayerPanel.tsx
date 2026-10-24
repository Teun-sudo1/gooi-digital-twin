import type { LightingMode } from '../features/map/lighting'
import { LAYER_GROUPS } from '../features/map/layers'
import { useAppStore } from '../store/useAppStore'

export function LayerPanel() {
  const open = useAppStore((s) => s.layerPanelOpen)
  const setOpen = useAppStore((s) => s.setLayerPanelOpen)
  const visibility = useAppStore((s) => s.layerVisibility)
  const toggleLayer = useAppStore((s) => s.toggleLayer)
  const lightingMode = useAppStore((s) => s.lightingMode)
  const setLightingMode = useAppStore((s) => s.setLightingMode)
  const modes: { id: LightingMode; label: string }[] = [
    { id: 'auto', label: 'Sun' },
    { id: 'day', label: 'Day' },
    { id: 'night', label: 'Night' },
  ]

  return (
    <aside className={`panel layer-panel ${open ? 'open' : ''}`}>
      <button
        className="panel-header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="layer-list"
      >
        <span>Layers</span>
        <svg viewBox="0 0 16 16" aria-hidden="true" className="chevron">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <ul id="layer-list" className="layer-list">
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
        </ul>
      )}
    </aside>
  )
}

import { LngLatBounds } from 'maplibre-gl'
import { useState } from 'react'
import { TOOL_BY_ID, TOOLS } from '../features/scenarios/tools'
import { useMapInstance } from '../hooks/useMapInstance'
import { type CyclePath, type RoadEdit, SPEED_CHOICES, useScenarioStore } from '../store/useScenarioStore'
import { useSimulationStore } from '../store/useSimulationStore'
import type { RoadAccess } from '../types/simulation'
import { formatCount } from '../utils/format'

const ACCESS_LABEL: Record<RoadAccess, string> = {
  closed: 'Closed to all traffic',
  'no-cars': 'Car-free: bikes and pedestrians',
  'foot-only': 'Pedestrians only',
  'bus-only': 'Bus only',
}

const streetName = (name: string | null, roadClass: string) => name ?? `Unnamed ${roadClass.replace(/_/g, ' ')}`

function describeEdit(edit: RoadEdit) {
  const parts: string[] = []
  if (edit.access) parts.push(ACCESS_LABEL[edit.access])
  if (edit.speedKmh) parts.push(`${edit.speedKmh} km/h (was ${edit.originalSpeedKmh})`)
  return parts.join(' · ')
}

type Item = { key: string; colour: string; title: string; detail: string; coordinates: [number, number][]; order: number; remove: () => void }

export function ScenarioPanel() {
  const map = useMapInstance()
  const ready = useSimulationStore((s) => s.status === 'ready')
  const rerouted = useSimulationStore((s) => s.stats?.reroutedTrips ?? 0)
  const stranded = useSimulationStore((s) => s.stats?.strandedTrips ?? 0)
  const { tool, speedKmh, edits, paths, hover, message, draft, setTool, setSpeed, removeEdit, removePath, reset } = useScenarioStore()
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 640)

  const items: Item[] = [
    ...Object.values(edits).map((e) => ({
      key: `s${e.segment}`,
      colour: TOOL_BY_ID[e.access ?? 'speed'].colour,
      title: streetName(e.name, e.roadClass),
      detail: describeEdit(e),
      coordinates: e.coordinates,
      order: e.order,
      remove: () => removeEdit(e.segment),
    })),
    ...paths.map((p: CyclePath) => ({
      key: p.id,
      colour: TOOL_BY_ID['cycle-path'].colour,
      title: 'New cycle path',
      detail: `${formatCount(Math.round(p.lengthMeters))} m, two-way, open to pedestrians`,
      coordinates: p.coordinates,
      order: p.order,
      remove: () => removePath(p.id),
    })),
  ].sort((a, b) => b.order - a.order)

  const flyTo = (coordinates: [number, number][]) => {
    if (!map || !coordinates.length) return
    const bounds = coordinates.reduce((b, c) => b.extend(c), new LngLatBounds(coordinates[0], coordinates[0]))
    map.fitBounds(bounds, { padding: 160, maxZoom: 17, pitch: map.getPitch(), bearing: map.getBearing(), duration: 900 })
  }

  const active = tool ? TOOL_BY_ID[tool] : null
  const hint = active?.id === 'cycle-path' && draft ? 'Click to add bends, double-click near a junction to finish. Backspace undoes a bend, Esc cancels.' : active?.hint

  return (
    <section className={`panel scenario-panel ${open ? 'open' : ''}`} aria-label="Road changes">
      <button className="panel-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>Road changes</span>
        <svg viewBox="0 0 16 16" aria-hidden="true" className="chevron">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="scenario-body">
          <div className="tool-grid" role="toolbar" aria-label="Editing tools">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`tool ${tool === t.id ? 'active' : ''}`}
                aria-pressed={tool === t.id}
                disabled={!ready || (t.id === 'erase' && !items.length)}
                onClick={() => setTool(t.id)}
              >
                <span className="tool-swatch" style={{ background: t.colour }} aria-hidden="true" />
                {t.label}
              </button>
            ))}
          </div>

          {tool === 'speed' && (
            <div className="speed-choice">
              <span id="speed-label">Limit</span>
              <div className="segmented small" role="radiogroup" aria-labelledby="speed-label">
                {SPEED_CHOICES.map((kmh) => (
                  <button key={kmh} role="radio" aria-checked={speedKmh === kmh} className={speedKmh === kmh ? 'active' : undefined} onClick={() => setSpeed(kmh)}>
                    {kmh}
                  </button>
                ))}
              </div>
              <span>km/h</span>
            </div>
          )}

          {active ? (
            <p className="tool-hint" aria-live="polite">
              {hint}
              {hover && tool !== 'cycle-path' && (
                <span className="hover-street">
                  {streetName(hover.name, hover.roadClass)}
                  {hover.car && hover.speedKmh ? ` · ${hover.speedKmh} km/h` : ''}
                </span>
              )}
            </p>
          ) : (
            <p className="tool-hint">Pick a tool, then click streets on the map. Traffic reroutes straight away.</p>
          )}
          {message && (
            <p className="tool-message" role="status">
              {message}
            </p>
          )}

          {items.length > 0 ? (
            <ul className="edit-list" aria-label="Changes">
              {items.map((item) => (
                <li key={item.key}>
                  <span className="tool-swatch" style={{ background: item.colour }} aria-hidden="true" />
                  <button className="edit-name" onClick={() => flyTo(item.coordinates)} title="Show on the map">
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </button>
                  <button className="icon-button" onClick={item.remove} aria-label={`Undo: ${item.title}`} title="Undo this change">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sim-note small-gap">No changes yet. The simulation uses the original network.</p>
          )}

          {items.length > 0 && (
            <>
              <p className="scenario-effect">
                <span className="sim-badge small">Model</span> {formatCount(rerouted)} trips rerouted
                {stranded > 0 && `, ${formatCount(stranded)} left with no way through`}
              </p>
              <button className="restore-button" onClick={reset}>
                Restore original network
              </button>
            </>
          )}
          <p className="dashboard-footnote">
            Changes affect simulated cars, cyclists, pedestrians and buses: buses divert around closed roads and
            can be delayed by extra traffic. Trains keep to their timetable.
          </p>
        </div>
      )}
    </section>
  )
}

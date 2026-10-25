import { LngLatBounds } from 'maplibre-gl'
import { useState } from 'react'
import { TOOL_BY_ID, TOOLS } from '../features/scenarios/tools'
import { useMapInstance } from '../hooks/useMapInstance'
import { NEW_ROAD } from '../features/scenarios/scenarioNetwork'
import { type NewRoad, type RoadEdit, SPEED_CHOICES, useScenarioStore } from '../store/useScenarioStore'
import { useSimulationStore } from '../store/useSimulationStore'
import type { NewRoadType, RoadAccess } from '../types/simulation'
import { formatCount } from '../utils/format'

const ACCESS_LABEL: Record<RoadAccess, string> = {
  closed: 'Closed to all traffic',
  removed: 'Removed',
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

const ROAD_TYPES: { id: NewRoadType; label: string }[] = [
  { id: 'cycleway', label: 'Cycle path' },
  { id: 'residential', label: 'Street' },
  { id: 'tertiary', label: 'Through road' },
  { id: 'primary', label: 'Main road' },
]
const NEW_SPEEDS = [30, 50, 60, 80, 100]

function describeRoad(road: NewRoad) {
  const length = `${formatCount(Math.round(road.lengthMeters))} m`
  if (road.road === 'cycleway') return `${length}, two-way, open to pedestrians`
  const lanes = `${road.lanes} lane${road.lanes > 1 ? 's' : ''}${road.oneway ? ', one-way' : ' each way'}`
  const users = road.road === 'primary' ? 'cars only' : 'cars, bikes and pedestrians'
  return `${length} · ${lanes} · ${road.kmh} km/h · ${users}`
}

/** Settings for a road about to be drawn. */
function RoadOptionsBar() {
  const options = useScenarioStore((s) => s.roadOptions)
  const set = useScenarioStore((s) => s.setRoadOptions)
  const cars = options.road !== 'cycleway'
  return (
    <div className="road-options">
      <div className="segmented small" role="radiogroup" aria-label="Kind of road">
        {ROAD_TYPES.map((t) => (
          <button key={t.id} role="radio" aria-checked={options.road === t.id} className={options.road === t.id ? 'active' : undefined} onClick={() => set({ road: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      {cars && (
        <>
          <div className="speed-choice">
            <span id="lanes-label">Lanes</span>
            <div className="segmented small" role="radiogroup" aria-labelledby="lanes-label">
              {[1, 2, 3].map((n) => (
                <button key={n} role="radio" aria-checked={options.lanes === n} className={options.lanes === n ? 'active' : undefined} onClick={() => set({ lanes: n })}>
                  {n}
                </button>
              ))}
            </div>
            <span>{options.oneway ? 'one way' : 'each way'}</span>
          </div>
          <div className="speed-choice">
            <span id="new-speed-label">Limit</span>
            <div className="segmented small" role="radiogroup" aria-labelledby="new-speed-label">
              {NEW_SPEEDS.map((kmh) => (
                <button key={kmh} role="radio" aria-checked={options.kmh === kmh} className={options.kmh === kmh ? 'active' : undefined} onClick={() => set({ kmh })}>
                  {kmh}
                </button>
              ))}
            </div>
            <span>km/h</span>
          </div>
        </>
      )}
      <div className="road-checks">
        {cars && (
          <label>
            <input type="checkbox" checked={options.oneway} onChange={() => set({ oneway: !options.oneway })} /> One-way (in the drawing direction)
          </label>
        )}
        <label>
          <input type="checkbox" checked={options.curved} onChange={() => set({ curved: !options.curved })} /> Smooth curves
        </label>
      </div>
    </div>
  )
}

type Item = { key: string; colour: string; title: string; detail: string; coordinates: [number, number][]; order: number; remove: () => void }

export function ScenarioPanel({ embedded = false }: { embedded?: boolean }) {
  const map = useMapInstance()
  const ready = useSimulationStore((s) => s.status === 'ready')
  const rerouted = useSimulationStore((s) => s.stats?.reroutedTrips ?? 0)
  const stranded = useSimulationStore((s) => s.stats?.strandedTrips ?? 0)
  const { tool, speedKmh, edits, roads, hover, message, draft, setTool, setSpeed, removeEdit, removeRoad, reset } = useScenarioStore()
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
    ...roads.map((r) => ({
      key: r.id,
      colour: TOOL_BY_ID['new-road'].colour,
      title: NEW_ROAD[r.road].name,
      detail: describeRoad(r),
      coordinates: r.coordinates,
      order: r.order,
      remove: () => removeRoad(r.id),
    })),
  ].sort((a, b) => b.order - a.order)

  const flyTo = (coordinates: [number, number][]) => {
    if (!map || !coordinates.length) return
    const bounds = coordinates.reduce((b, c) => b.extend(c), new LngLatBounds(coordinates[0], coordinates[0]))
    map.fitBounds(bounds, { padding: 160, maxZoom: 17, pitch: map.getPitch(), bearing: map.getBearing(), duration: 900 })
  }

  const active = tool ? TOOL_BY_ID[tool] : null
  const hint = active?.id === 'new-road' && draft ? 'Click to add bends, double-click near a junction to finish. Backspace undoes a bend, Esc cancels.' : active?.hint

  return (
    <section className={`panel scenario-panel ${open || embedded ? 'open' : ''} ${embedded ? 'embedded' : ''}`} aria-label="Road changes">
      {!embedded && (
        <button className="panel-header" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span>Road changes</span>
          <svg viewBox="0 0 16 16" aria-hidden="true" className="chevron">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>
      )}

      {(open || embedded) && (
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

          {tool === 'new-road' && <RoadOptionsBar />}

          {active ? (
            <p className="tool-hint" aria-live="polite">
              {hint}
              {hover && tool !== 'new-road' && (
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

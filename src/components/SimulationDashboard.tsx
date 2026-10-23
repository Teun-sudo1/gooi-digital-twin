import { useState } from 'react'
import { CO2_KG_PER_KM } from '../features/simulation/engine'
import { VEHICLE_COLORS } from '../features/simulation/controller'
import { type HistoryPoint, useSimulationStore } from '../store/useSimulationStore'
import { formatCount, formatDecimal } from '../utils/format'
import { TrendChart } from './TrendChart'

type Metric = 'vehicles' | 'speed' | 'delayed'

const METRICS: Record<
  Metric,
  { label: string; value: (p: HistoryPoint) => number; format: (v: number) => string }
> = {
  vehicles: { label: 'Vehicles', value: (p) => p.activeVehicles, format: (v) => formatCount(Math.round(v)) },
  speed: { label: 'Speed', value: (p) => p.averageSpeedKmh, format: (v) => `${formatDecimal(v)} km/h` },
  delayed: { label: 'Delayed', value: (p) => p.delayedVehicles, format: (v) => formatCount(Math.round(v)) },
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>
        {value}
        {unit && <small>{unit}</small>}
      </dd>
    </div>
  )
}

export function SimulationDashboard() {
  const status = useSimulationStore((s) => s.status)
  const stats = useSimulationStore((s) => s.stats)
  const history = useSimulationStore((s) => s.history)
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 640)
  const [metric, setMetric] = useState<Metric>('vehicles')

  if (status === 'error' || status === 'idle') return null

  const co2 = stats?.estimatedCo2Kg ?? 0
  const selected = METRICS[metric]

  return (
    <section className={`panel dashboard ${open ? 'open' : ''}`} aria-label="Simulated statistics">
      <button className="panel-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          Simulated statistics <span className="sim-badge small">Model</span>
        </span>
        <svg viewBox="0 0 16 16" aria-hidden="true" className="chevron">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="dashboard-body">
          {!stats ? (
            <p className="sim-note">Loading the Huizen road network…</p>
          ) : (
            <>
              <dl className="stats">
                <Stat label="Active vehicles" value={formatCount(stats.activeVehicles)} />
                <Stat label="Average speed" value={formatDecimal(stats.averageSpeedKmh)} unit="km/h" />
                <Stat
                  label="Average journey"
                  value={stats.averageJourneyMinutes === null ? '–' : formatDecimal(stats.averageJourneyMinutes)}
                  unit={stats.averageJourneyMinutes === null ? undefined : 'min'}
                />
                <Stat label="Delayed now" value={formatCount(stats.delayedVehicles)} />
                <Stat label="Distance travelled" value={formatCount(Math.round(stats.totalDistanceKm))} unit="km" />
                <Stat
                  label="Estimated CO₂"
                  value={co2 < 1000 ? formatCount(Math.round(co2)) : formatDecimal(co2 / 1000)}
                  unit={co2 < 1000 ? 'kg' : 't'}
                />
              </dl>

              <div className="segmented small" role="radiogroup" aria-label="Trend metric">
                {(Object.keys(METRICS) as Metric[]).map((key) => (
                  <button
                    key={key}
                    role="radio"
                    aria-checked={metric === key}
                    className={metric === key ? 'active' : undefined}
                    onClick={() => setMetric(key)}
                  >
                    {METRICS[key].label}
                  </button>
                ))}
              </div>
              <TrendChart
                points={history}
                value={selected.value}
                format={selected.format}
                label={`${selected.label} (simulated) over simulated time`}
              />

              <ul className="vehicle-legend" aria-label="Map legend">
                <li>
                  <span className="swatch" style={{ background: VEHICLE_COLORS.moving }} />
                  Moving
                </li>
                <li>
                  <span className="swatch" style={{ background: VEHICLE_COLORS.delayed }} />
                  Delayed (below 40% of limit for 10 s+)
                </li>
              </ul>
            </>
          )}

          <p className="dashboard-footnote">
            Synthetic output of a simplified model, not measured traffic in Huizen. Roads, one-way rules
            and speed limits come from OpenStreetMap; demand and driving behaviour are assumed. CO₂
            assumes {CO2_KG_PER_KM * 1000} g/km per car. Building heights are approximate.
          </p>
        </div>
      )}
    </section>
  )
}

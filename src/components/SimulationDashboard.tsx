import { useState } from 'react'
import { BUSIER, QUIETER } from '../features/scenarios/useComparisonLayer'
import { CONGESTION_COLOURS } from '../features/simulation/client'
import { CAR_COLOURS, CLOTHING_COLOURS } from '../features/simulation/icons'
import { CO2_KG_PER_KM } from '../features/simulation/traffic'
import { type HistoryPoint, useSimulationStore } from '../store/useSimulationStore'
import type { Comparison, ComparisonSide } from '../types/simulation'
import { formatCount, formatDecimal } from '../utils/format'
import { TrendChart } from './TrendChart'

type Metric = 'cars' | 'bikes' | 'speed' | 'delayed'

const METRICS: Record<
  Metric,
  { label: string; value: (p: HistoryPoint) => number; format: (v: number) => string }
> = {
  cars: { label: 'Cars', value: (p) => p.cars, format: (v) => formatCount(Math.round(v)) },
  bikes: { label: 'Bikes', value: (p) => p.bikes, format: (v) => formatCount(Math.round(v)) },
  speed: { label: 'Car speed', value: (p) => p.averageCarSpeedKmh, format: (v) => `${formatDecimal(v)} km/h` },
  delayed: { label: 'Delayed', value: (p) => p.delayedCars, format: (v) => formatCount(Math.round(v)) },
}

function Stat({ label, value, unit, title }: { label: string; value: string; unit?: string; title?: string }) {
  return (
    <div className="stat" title={title}>
      <dt>{label}</dt>
      <dd>
        {value}
        {unit && <small>{unit}</small>}
      </dd>
    </div>
  )
}

/** Comparison rows: value, format, and whether a higher value is better. */
const COMPARED: { label: string; value: (s: ComparisonSide) => number | null; format: (v: number) => string; higherIsBetter: boolean }[] = [
  { label: 'Car journey', value: (s) => s.journeyMinutes, format: (v) => `${formatDecimal(v)} min`, higherIsBetter: false },
  { label: 'Car speed', value: (s) => s.carSpeedKmh, format: (v) => `${formatDecimal(v)} km/h`, higherIsBetter: true },
  { label: 'Time delayed', value: (s) => s.delayedShare * 100, format: (v) => `${formatDecimal(v)}%`, higherIsBetter: false },
  { label: 'Car km per hour', value: (s) => s.carKmPerHour, format: (v) => formatCount(Math.round(v)), higherIsBetter: false },
  { label: 'CO₂ per hour', value: (s) => s.co2KgPerHour, format: (v) => `${formatCount(Math.round(v))} kg`, higherIsBetter: false },
  { label: 'Bus delay', value: (s) => s.busDelayMinutes, format: (v) => `${formatDecimal(v)} min`, higherIsBetter: false },
]
/** Simulated minutes before the comparison means much. */
const SETTLING_MINUTES = 5

function ComparisonTable({ comparison }: { comparison: Comparison }) {
  const showChanges = useSimulationStore((s) => s.showChanges)
  const settling = comparison.minutes < SETTLING_MINUTES
  return (
    <section className="comparison" aria-label="Road changes compared with the original network">
      <div className="comparison-head">
        <strong>Your road changes vs the original</strong>
        <span>{Math.floor(comparison.minutes)} simulated min</span>
      </div>
      {settling ? (
        <p className="sim-note">
          Both versions now run side by side. Results appear after a few simulated minutes; speed up to 20× to get
          there faster.
        </p>
      ) : (
        <table className="comparison-table">
          <thead>
            <tr>
              <th scope="col">Simulated</th>
              <th scope="col">Original</th>
              <th scope="col">Changed</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {COMPARED.map((row) => {
              const before = row.value(comparison.original)
              const after = row.value(comparison.scenario)
              const change = before !== null && after !== null && before > 0.05 ? (after - before) / before : null
              const meaningful = change !== null && Math.abs(change) >= 0.03
              const better = meaningful && change! > 0 === row.higherIsBetter
              return (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td>{before === null ? '–' : row.format(before)}</td>
                  <td>{after === null ? '–' : row.format(after)}</td>
                  <td className={meaningful ? (better ? 'better' : 'worse') : 'same'}>
                    {change === null ? '–' : meaningful ? `${change > 0 ? '▲' : '▼'} ${Math.abs(Math.round(change * 100))}%` : '≈ same'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <label className="toggle compact">
        <input type="checkbox" checked={showChanges} onChange={() => useSimulationStore.setState({ showChanges: !showChanges })} />
        <span className="switch" aria-hidden="true" />
        <span>
          Show streets with <span className="change-key" style={{ background: BUSIER }} /> more or{' '}
          <span className="change-key" style={{ background: QUIETER }} /> less car traffic
        </span>
      </label>
      <p className="dashboard-footnote">
        From your last change, a copy of the simulation keeps running on the original network with the same demand.
        Differences of a few percent can be chance.
      </p>
    </section>
  )
}

/** `embedded`: shown in the mobile sheet, always open and without its own header. */
export function SimulationDashboard({ embedded = false }: { embedded?: boolean }) {
  const status = useSimulationStore((s) => s.status)
  const stats = useSimulationStore((s) => s.stats)
  const history = useSimulationStore((s) => s.history)
  const lines = useSimulationStore((s) => s.lines)
  const timetableDate = useSimulationStore((s) => s.timetableDate)
  const comparison = useSimulationStore((s) => s.comparison)
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 640)
  const [metric, setMetric] = useState<Metric>('cars')

  if (status === 'error' || status === 'idle') return null

  const co2 = stats?.estimatedCo2Kg ?? 0
  const selected = METRICS[metric]
  const scheduledTrips = lines.reduce((sum, l) => sum + (l.schedule === 'timetable' ? l.tripsPerDay : 0), 0)
  const timetableDay = timetableDate
    ? new Date(`${timetableDate.slice(0, 4)}-${timetableDate.slice(4, 6)}-${timetableDate.slice(6)}T12:00:00Z`).toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null

  return (
    <section className={`panel dashboard ${open || embedded ? 'open' : ''} ${embedded ? 'embedded' : ''}`} aria-label="Simulated statistics">
      {!embedded && (
        <button className="panel-header" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span>
            Simulated statistics <span className="sim-badge small">Model</span>
          </span>
          <svg viewBox="0 0 16 16" aria-hidden="true" className="chevron">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>
      )}

      {(open || embedded) && (
        <div className="dashboard-body">
          {!stats ? (
            <p className="sim-note">Loading the Gooi street and transit networks…</p>
          ) : (
            <>
              {comparison && <ComparisonTable comparison={comparison} />}
              <dl className="stats">
                <Stat label="Cars" value={formatCount(stats.cars)} />
                <Stat label="Cyclists" value={formatCount(stats.bikes)} />
                <Stat
                  label="Buses · trains"
                  value={`${stats.buses} · ${stats.trains}`}
                  title="Vehicles in service on the modelled timetable"
                />
                <Stat label="Car speed" value={formatDecimal(stats.averageCarSpeedKmh)} unit="km/h" />
                <Stat label="Bike speed" value={formatDecimal(stats.averageBikeSpeedKmh)} unit="km/h" />
                <Stat
                  label="Car journey"
                  value={stats.averageCarJourneyMinutes === null ? '–' : formatDecimal(stats.averageCarJourneyMinutes)}
                  unit={stats.averageCarJourneyMinutes === null ? undefined : 'min'}
                />
                <Stat label="Delayed cars" value={formatCount(stats.delayedCars)} title="Below 40% of the speed limit for 10 s or more" />
                <Stat label="Car distance" value={formatCount(Math.round(stats.carKilometres))} unit="km" />
                <Stat
                  label="Est. CO₂ (cars)"
                  value={co2 < 1000 ? formatCount(Math.round(co2)) : formatDecimal(co2 / 1000)}
                  unit={co2 < 1000 ? 'kg' : 't'}
                />
                <Stat
                  label="Bus delay"
                  value={stats.busDelayMinutes === null ? '–' : formatDecimal(stats.busDelayMinutes)}
                  unit={stats.busDelayMinutes === null ? undefined : 'min'}
                  title="Average delay of buses in service against the timetable"
                />
                <Stat label="Buses late" value={formatCount(stats.busesLate)} title="Three minutes late or more" />
                <Stat label="Diversions" value={formatCount(stats.busDetours)} title="Buses diverted around closed roads" />
              </dl>
              <p className="sim-note small">
                {stats.pedestrians > 0
                  ? `${formatCount(stats.pedestrians)} pedestrians around the current view.`
                  : 'Zoom in to street level to see pedestrians.'}
              </p>

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
                  <span className="swatch" style={{ background: CAR_COLOURS[4] }} />
                  Cars, vans, trucks
                </li>
                <li>
                  <span className="swatch dot" style={{ background: CLOTHING_COLOURS[0] }} />
                  Cyclists
                </li>
                <li>
                  <span className="swatch dot" style={{ background: CLOTHING_COLOURS[1] }} />
                  Pedestrians
                </li>
                <li>
                  <span className="swatch" style={{ background: '#2f9e6e' }} />
                  Buses (line colour)
                </li>
                <li>
                  <span className="swatch" style={{ background: '#ffc917' }} />
                  Trains
                </li>
                <li>
                  <span className="swatch" style={{ background: '#ff2a1a' }} />
                  Brake lights
                </li>
                <li className="congestion-key" title="Share of time cars on a street spend held up (simulated)">
                  Streets:
                  {['free', 'slow', 'queuing', 'jammed'].map((label, i) => (
                    <span key={label}>
                      <span className="swatch line" style={{ background: CONGESTION_COLOURS[i] }} />
                      {label}
                    </span>
                  ))}
                </li>
              </ul>
            </>
          )}

          <p className="dashboard-footnote">
            Synthetic output of a simplified model, not measured traffic. Streets, paths, one-way rules,
            speed limits and bus and train routes and stops come from OpenStreetMap.{' '}
            {timetableDay
              ? `Buses and trains run to the real timetable of ${timetableDay} (${formatCount(scheduledTrips)} trips, OVapi/NDOV open data). Buses drive through the simulated traffic, so their delays are simulated too. `
              : 'Bus and train frequencies are assumed. '}
            Trips start and end in proportion to CBS 2024 population and business counts per neighbourhood; trip rates, weather effects and driving behaviour are assumed. CO₂ assumes {CO2_KG_PER_KM * 1000} g/km
            per car. Building heights are approximate.
          </p>
        </div>
      )}
    </section>
  )
}

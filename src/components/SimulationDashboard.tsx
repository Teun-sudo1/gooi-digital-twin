import { useState } from 'react'
import { CAR_COLOURS, CLOTHING_COLOURS } from '../features/simulation/icons'
import { CO2_KG_PER_KM } from '../features/simulation/traffic'
import { type HistoryPoint, useSimulationStore } from '../store/useSimulationStore'
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

export function SimulationDashboard() {
  const status = useSimulationStore((s) => s.status)
  const stats = useSimulationStore((s) => s.stats)
  const history = useSimulationStore((s) => s.history)
  const lines = useSimulationStore((s) => s.lines)
  const timetableDate = useSimulationStore((s) => s.timetableDate)
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
            <p className="sim-note">Loading the Gooi street and transit networks…</p>
          ) : (
            <>
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
              </ul>
            </>
          )}

          <p className="dashboard-footnote">
            Synthetic output of a simplified model, not measured traffic. Streets, paths, one-way rules,
            speed limits and bus and train routes and stops come from OpenStreetMap.{' '}
            {timetableDay
              ? `Buses and trains run to the real timetable of ${timetableDay} (${formatCount(scheduledTrips)} trips, OVapi/NDOV open data), with simulated positions between stops. `
              : 'Bus and train frequencies are assumed. '}
            Car, bike and pedestrian demand and driving behaviour are assumed. CO₂ assumes {CO2_KG_PER_KM * 1000} g/km
            per car. Building heights are approximate.
          </p>
        </div>
      )}
    </section>
  )
}

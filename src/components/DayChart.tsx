import { useState } from 'react'
import { type HistoryPoint, SLOT_SECONDS } from '../store/useSimulationStore'
import { formatClock } from '../utils/format'

interface DayChartProps {
  /** One point per quarter hour of the day, null where the simulation hasn't been. */
  points: (HistoryPoint | null)[]
  value: (point: HistoryPoint) => number
  format: (value: number) => string
  /** What the model's demand profile expects at a time of day, when the metric has one. */
  expected?: (clock: number) => number
  /** The simulated time now, in seconds since midnight. */
  now: number
  /** Accessible name, e.g. "Cars (simulated) over the day". */
  label: string
}

const DAY = 86_400
const WIDTH = 300
const HEIGHT = 96
const PAD_TOP = 8
const PAD_BOTTOM = 2
/** The rush hours of the demand profile, in hours (as in dayPeriod). */
const RUSH_HOURS: [number, number][] = [
  [6, 9.5],
  [15.5, 18.5],
]
const AXIS = ['00:00', '06:00', '12:00', '18:00', '24:00']

/**
 * The whole simulated day, midnight to midnight: the simulated value per
 * quarter hour (gaps where the simulation hasn't run yet), the model's
 * expected demand as a dashed line, and the rush hours shaded.
 */
export function DayChart({ points, value, format, expected, now, label }: DayChartProps) {
  const [hover, setHover] = useState<number | null>(null)
  const slots = points.length
  const values = points.map((p) => (p ? value(p) : null))
  const expectedValues = expected ? Array.from({ length: slots + 1 }, (_, i) => expected(i * SLOT_SECONDS)) : []
  const known = values.filter((v): v is number => v !== null)
  const max = Math.max(...known, ...expectedValues, 1) * 1.1

  const x = (clock: number) => (clock / DAY) * WIDTH
  const slotX = (i: number) => x((i + 0.5) * SLOT_SECONDS)
  const y = (v: number) => PAD_TOP + (1 - v / max) * (HEIGHT - PAD_TOP - PAD_BOTTOM)

  // The simulated line breaks wherever a quarter hour is missing.
  let line = ''
  values.forEach((v, i) => {
    if (v === null) return
    const start = i === 0 || values[i - 1] === null
    line += `${start ? 'M' : 'L'}${slotX(i).toFixed(1)},${y(v).toFixed(1)}`
    if (start && (i === slots - 1 || values[i + 1] === null)) line += 'h0.1'
  })
  const expectedLine = expectedValues.map((v, i) => `${i ? 'L' : 'M'}${x(i * SLOT_SECONDS).toFixed(1)},${y(v).toFixed(1)}`).join('')

  const nowSlot = Math.floor(now / SLOT_SECONDS) % slots
  const active = hover ?? nowSlot
  const activeValue = values[active]
  const covered = Math.round((known.length / slots) * 100)

  const onPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    setHover(Math.max(0, Math.min(slots - 1, Math.floor(ratio * slots))))
  }

  return (
    <figure className="trend">
      <figcaption className="trend-readout" aria-live="off">
        <strong>{activeValue === null ? 'Not simulated yet' : format(activeValue)}</strong>
        <span>
          {formatClock(active * SLOT_SECONDS)}–{formatClock((active + 1) * SLOT_SECONDS)}
          {hover === null ? ' · now' : ''}
          {expected ? ` · expected ${format(expected((active + 0.5) * SLOT_SECONDS))}` : ''}
        </span>
      </figcaption>
      <div className="trend-plot">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={
            known.length
              ? `${label}: ${format(Math.min(...known))} to ${format(Math.max(...known))}, ${covered}% of the day simulated`
              : `${label}: no data yet`
          }
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setHover(null)}
        >
          {RUSH_HOURS.map(([from, to]) => (
            <rect key={from} className="trend-band" x={x(from * 3600)} width={x((to - from) * 3600)} y={0} height={HEIGHT} />
          ))}
          <line className="trend-grid" x1="0" x2={WIDTH} y1={y(0)} y2={y(0)} />
          <line className="trend-grid" x1="0" x2={WIDTH} y1={y(max / 1.1)} y2={y(max / 1.1)} />
          {expected && <path d={expectedLine} className="trend-expected" vectorEffect="non-scaling-stroke" />}
          <line className="trend-now" x1={x(now)} x2={x(now)} y1={0} y2={HEIGHT} vectorEffect="non-scaling-stroke" />
          {line && <path d={line} className="trend-line" vectorEffect="non-scaling-stroke" />}
          {hover !== null && (
            <line className="trend-crosshair" x1={slotX(hover)} x2={slotX(hover)} y1={0} y2={HEIGHT} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {activeValue !== null && (
          <div
            className="trend-dot"
            style={{ left: `${(slotX(active) / WIDTH) * 100}%`, top: `${(y(activeValue) / HEIGHT) * 100}%` }}
            aria-hidden="true"
          />
        )}
        <span className="trend-peak" aria-hidden="true">
          {format(max / 1.1)}
        </span>
      </div>
      <div className="trend-axis" aria-hidden="true">
        {AXIS.map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
      <ul className="trend-legend" aria-label="Chart legend">
        <li>
          <span className="trend-key line" aria-hidden="true" />
          Simulated
        </li>
        {expected && (
          <li>
            <span className="trend-key dashed" aria-hidden="true" />
            Expected (assumed demand)
          </li>
        )}
        <li>
          <span className="trend-key band" aria-hidden="true" />
          Rush hours
        </li>
      </ul>
    </figure>
  )
}

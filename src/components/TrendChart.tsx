import { useId, useState } from 'react'
import type { HistoryPoint } from '../store/useSimulationStore'
import { formatClock } from '../utils/format'

interface TrendChartProps {
  points: HistoryPoint[]
  value: (point: HistoryPoint) => number
  format: (value: number) => string
  /** Accessible name, e.g. "Active vehicles (simulated)". */
  label: string
}

const WIDTH = 300
const HEIGHT = 84
const PAD_TOP = 14
const PAD_BOTTOM = 16

/**
 * Single-series line over simulated time, with a crosshair tooltip. One
 * series, so no legend: the selected metric names it.
 */
export function TrendChart({ points, value, format, label }: TrendChartProps) {
  const [hover, setHover] = useState<number | null>(null)
  const gradientId = useId()

  if (points.length < 2) {
    return <div className="trend-empty">Collecting simulated data…</div>
  }

  const values = points.map(value)
  const max = Math.max(...values, 1) * 1.1
  const x = (i: number) => (i / (points.length - 1)) * WIDTH
  const y = (v: number) => PAD_TOP + (1 - v / max) * (HEIGHT - PAD_TOP - PAD_BOTTOM)
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const area = `${line}L${WIDTH},${y(0)}L0,${y(0)}Z`
  const active = hover ?? points.length - 1

  const onPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))))
  }

  return (
    <figure className="trend">
      <figcaption className="trend-readout" aria-live="off">
        <strong>{format(values[active])}</strong>
        <span>{formatClock(points[active].clock)}{hover === null ? ' · now' : ''}</span>
      </figcaption>
      <div className="trend-plot">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label}, ${format(Math.min(...values))} to ${format(Math.max(...values))}`}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line className="trend-grid" x1="0" x2={WIDTH} y1={y(0)} y2={y(0)} />
          <line className="trend-grid" x1="0" x2={WIDTH} y1={y(max / 1.1)} y2={y(max / 1.1)} />
          <path d={area} fill={`url(#${gradientId})`} />
          <path d={line} className="trend-line" vectorEffect="non-scaling-stroke" />
          {hover !== null && (
            <line className="trend-crosshair" x1={x(hover)} x2={x(hover)} y1={PAD_TOP - 4} y2={y(0)} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        <div
          className="trend-dot"
          style={{ left: `${(x(active) / WIDTH) * 100}%`, top: `${(y(values[active]) / HEIGHT) * 100}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="trend-axis" aria-hidden="true">
        <span>{formatClock(points[0].clock)}</span>
        <span>peak {format(max / 1.1)}</span>
        <span>{formatClock(points[points.length - 1].clock)}</span>
      </div>
    </figure>
  )
}

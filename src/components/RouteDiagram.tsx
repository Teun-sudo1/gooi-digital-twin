import { useEffect, useRef, useState } from 'react'
import { useSimulationStore } from '../store/useSimulationStore'
import type { RouteSide, TransitLineInfo } from '../types/simulation'
import { shortName } from '../utils/format'

/*
 * The followed bus's line as a schematic loop: one direction down the left,
 * the return direction up the right, with every stop, the simulated
 * passengers waiting there, and all buses on the line. Click a bus to follow it.
 */

const WIDTH = 236
const LEFT = 106
const RIGHT = 130
const TOP = 22
const ROW = 22
const NAME_GAP = 22


function Side({
  side,
  x,
  y,
  align,
  colour,
  followId,
  onFollow,
}: {
  side: RouteSide
  x: number
  y: (at: number) => number
  align: 'left' | 'right'
  colour: string
  followId: number | null
  onFollow: (id: number) => void
}) {
  const outward = align === 'left' ? -1 : 1
  const anchor = align === 'left' ? 'end' : 'start'
  return (
    <g>
      {side.stops.map((stop, i) => (
        <g key={i}>
          <circle cx={x} cy={y(i)} r={4.5} className="route-stop" />
          {stop.waiting > 0 && (
            <text x={x + outward * 10} y={y(i) + 3.5} textAnchor={anchor} className="route-waiting">
              {stop.waiting}
            </text>
          )}
          <text x={x + outward * NAME_GAP} y={y(i) + 3.5} textAnchor={anchor} className="route-name">
            <title>{`${stop.name ?? 'Unnamed stop'}${stop.waiting ? ` · ${stop.waiting} waiting (simulated)` : ''}`}</title>
            {shortName(stop.name)}
          </text>
        </g>
      ))}
      {side.buses.map((bus) => {
        const followed = bus.id === followId
        return (
          <g
            key={bus.id}
            className={`route-bus ${followed ? 'followed' : ''}`}
            transform={`translate(${x}, ${y(bus.at)})`}
            onClick={() => onFollow(bus.id)}
            role="button"
            aria-label={followed ? 'Followed bus' : 'Follow this bus'}
          >
            <title>{`${followed ? 'Followed bus' : 'Click to follow'} · ${bus.delayMinutes < 1 ? 'on time' : `+${Math.round(bus.delayMinutes)} min`}`}</title>
            <rect x={-8} y={-6} width={16} height={12} rx={3} fill={colour} />
          </g>
        )
      })}
    </g>
  )
}

export function RouteDiagram() {
  const info = useSimulationStore((s) => s.followInfo)
  const followId = useSimulationStore((s) => s.followId)
  const lines = useSimulationStore((s) => s.lines)
  const controller = useSimulationStore((s) => s.controller)
  const [open, setOpen] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)

  const route = info?.type === 'bus' ? info.route : null
  const shown = route !== null
  // Bring the followed bus into view when following starts.
  useEffect(() => {
    // Scroll only the diagram (scrollIntoView could shift the whole page).
    const box = scroller.current
    const marker = box?.querySelector('.route-bus.followed')
    if (!box || !marker) return
    const offset = marker.getBoundingClientRect().top - box.getBoundingClientRect().top
    box.scrollTop += offset - box.clientHeight / 2
  }, [followId, shown])

  if (!route || followId === null) return null
  const line: TransitLineInfo | undefined = lines[route.forward.line]
  if (!line) return null
  const { forward, back } = route
  const rows = Math.max(forward.stops.length, back?.stops.length ?? 0, 2)
  const bottom = TOP + (rows - 1) * ROW
  const height = bottom + TOP
  const along = (count: number, downwards: boolean) => (at: number) => {
    const span = count > 1 ? (bottom - TOP) / (count - 1) : 0
    const clamped = Math.max(-0.7, Math.min(count - 0.3, at))
    return downwards ? TOP + clamped * span : bottom - clamped * span
  }
  const follow = (id: number) => controller?.setFollow(id)

  return (
    <section className={`panel route-panel ${open ? 'open' : ''}`} aria-label={`Route of line ${line.ref}`}>
      <button className="panel-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          <span className="line-badge" style={{ background: line.colour }}>
            {line.ref}
          </span>{' '}
          Route
        </span>
        <svg viewBox="0 0 16 16" aria-hidden="true" className="chevron">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="route-body" ref={scroller}>
          <p className="route-ends">
            <span>↓ to {line.to ?? 'end'}</span>
            {back && <span>↑ to {lines[back.line]?.to ?? 'start'}</span>}
          </p>
          <svg viewBox={`0 0 ${WIDTH} ${height}`} width={WIDTH} height={height} className="route-diagram" role="img" aria-label="Schematic route with stops and buses">
            <path
              d={
                back
                  ? `M${LEFT} ${TOP} L${LEFT} ${bottom} A14 14 0 0 0 ${RIGHT} ${bottom} L${RIGHT} ${TOP} A14 14 0 0 0 ${LEFT} ${TOP} Z`
                  : `M${LEFT} ${TOP} L${LEFT} ${bottom}`
              }
              className="route-line"
              stroke={line.colour}
            />
            <Side side={forward} x={LEFT} y={along(forward.stops.length, true)} align="left" colour={line.colour} followId={followId} onFollow={follow} />
            {back && (
              <Side side={back} x={RIGHT} y={along(back.stops.length, false)} align="right" colour={lines[back.line]?.colour ?? line.colour} followId={followId} onFollow={follow} />
            )}
          </svg>
          <p className="dashboard-footnote">
            Numbers are passengers waiting, simulated from assumed demand (there is no ridership data). Click a bus to
            follow it.
          </p>
        </div>
      )}
    </section>
  )
}

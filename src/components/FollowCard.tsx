import { useSimulationStore } from '../store/useSimulationStore'
import { Kind, type FollowInfo, type TransitLineInfo } from '../types/simulation'
import { formatClock, formatDecimal, shortName } from '../utils/format'

const VEHICLE_NAMES: Record<number, string> = {
  [Kind.Hatchback]: 'Hatchback',
  [Kind.Sedan]: 'Saloon car',
  [Kind.Suv]: 'SUV',
  [Kind.Van]: 'Van',
  [Kind.Truck]: 'Lorry',
  [Kind.Bike]: 'Cyclist',
  [Kind.Pedestrian]: 'Pedestrian',
}

function delayText(minutes: number) {
  if (minutes < 1) return 'On time'
  return `+${Math.round(minutes)} min`
}

function LineBadge({ line }: { line: TransitLineInfo }) {
  return (
    <span className="line-badge" style={{ background: line.colour }}>
      {line.mode === 'train' ? (Number(line.ref) < 3000 || /^IC/.test(line.ref) ? 'IC' : 'SPR') : line.ref}
    </span>
  )
}

function Details({ info, lines }: { info: FollowInfo; lines: TransitLineInfo[] }) {
  if (info.type === 'road') {
    const status = info.waitingAtLight ? 'Waiting at a red light' : info.delayed ? 'Held up in traffic' : null
    return (
      <>
        <div className="follow-title">
          <strong>{VEHICLE_NAMES[info.vehicle] ?? 'Vehicle'}</strong>
          {info.street && <span>on {info.street}</span>}
        </div>
        <dl className="follow-stats">
          <div>
            <dt>Speed</dt>
            <dd>{Math.round(info.speedKmh)} km/h</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd title={info.destination ?? undefined}>{info.destination ?? 'Unnamed street'}</dd>
          </div>
          <div>
            <dt>Left · so far</dt>
            <dd>
              {formatDecimal(info.remainingKm)} km · {Math.round(info.tripMinutes)} min
            </dd>
          </div>
        </dl>
        {status && <p className="follow-status">{status}</p>}
      </>
    )
  }
  const line = lines[info.line]
  if (!line) return null
  const status = info.detour ? 'On a diversion around a closed road' : info.delayMinutes >= 3 ? 'Running late' : null
  return (
    <>
      <div className="follow-title">
        <LineBadge line={line} />
        <strong>{line.to ? `to ${line.to}` : line.name}</strong>
      </div>
      <dl className="follow-stats">
        <div>
          <dt>Speed</dt>
          <dd>{Math.round(info.speedKmh)} km/h</dd>
        </div>
        <div>
          <dt>Next stop</dt>
          <dd title={info.nextStop ?? undefined}>
            {info.nextStop ? shortName(info.nextStop, 22) : info.nextStopTime === null ? 'End of the line' : 'Unnamed stop'}
            {info.nextStopTime !== null && <small> {formatClock(info.nextStopTime)}</small>}
          </dd>
        </div>
        <div>
          <dt>{info.type === 'train' ? 'Timetable' : 'Delay'}</dt>
          <dd>{info.type === 'train' ? 'Scheduled' : delayText(info.delayMinutes)}</dd>
        </div>
        {info.onBoard !== null && (
          <div title="Simulated from assumed demand">
            <dt>On board</dt>
            <dd>{info.onBoard}</dd>
          </div>
        )}
      </dl>
      {status && <p className="follow-status">{status}</p>}
    </>
  )
}

/** Details of the vehicle the camera follows. */
export function FollowCard() {
  const controller = useSimulationStore((s) => s.controller)
  const followId = useSimulationStore((s) => s.followId)
  const info = useSimulationStore((s) => s.followInfo)
  const gone = useSimulationStore((s) => s.followGone)
  const chase = useSimulationStore((s) => s.chase)
  const lines = useSimulationStore((s) => s.lines)

  if (followId === null && !gone) return null
  const stop = () => {
    controller?.setFollow(null)
    useSimulationStore.setState({ followGone: false })
  }

  return (
    <section className="panel follow-card" aria-label="Followed vehicle" aria-live="polite">
      <div className="follow-head">
        <span className="sim-badge small">Simulated</span>
        {followId !== null && (
          <button
            className={`chip-toggle ${chase ? 'active' : ''}`}
            aria-pressed={chase}
            onClick={() => controller?.setChase(!chase)}
            title="Turn the map with the vehicle"
          >
            Chase view
          </button>
        )}
        <button className="icon-button" onClick={stop} aria-label="Stop following" title="Stop following (Esc)">
          ×
        </button>
      </div>
      {followId === null ? (
        <p className="follow-status">It reached its destination or left the area. Click another vehicle to follow it.</p>
      ) : info ? (
        <Details info={info} lines={lines} />
      ) : (
        <p className="sim-note">Finding the vehicle…</p>
      )}
    </section>
  )
}

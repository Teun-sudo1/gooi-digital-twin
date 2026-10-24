import { useSimulationStore } from '../store/useSimulationStore'
import type { StopBoard, TransitLineInfo } from '../types/simulation'
import { badgeStyle, formatClock } from '../utils/format'

function badgeText(line: TransitLineInfo) {
  if (line.mode === 'bus') return line.ref
  return Number(line.ref) < 3000 || /^IC/.test(line.ref) ? 'IC' : 'SPR'
}

function Status({ row }: { row: StopBoard['departures'][number] }) {
  if (row.status === 'at-stop') return <span className="board-status now">At the stop</span>
  if (row.status === 'scheduled') return <span className="board-status">Scheduled</span>
  if (row.delayMinutes < 1) return <span className="board-status">On time</span>
  return <span className="board-status late">+{Math.round(row.delayMinutes)} min</span>
}

/** Departures from the clicked stop, like the boards at the stop itself. */
export function StopBoardPanel({ embedded = false }: { embedded?: boolean }) {
  const stop = useSimulationStore((s) => s.stop)
  const board = useSimulationStore((s) => s.board)
  const lines = useSimulationStore((s) => s.lines)
  const controller = useSimulationStore((s) => s.controller)
  if (!stop) return null
  const close = () => controller?.openStop(null)

  return (
    <section className={`panel stop-board open ${embedded ? 'embedded' : ''}`} aria-label="Departures">
      <div className="panel-header static">
        <span>Departures</span>
        <button className="icon-button" onClick={close} aria-label="Close departures" title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="board-body">
        {!board ? (
          <p className="sim-note">Loading departures…</p>
        ) : (
          <>
            <h2 className="board-name">{board.name ?? 'Stop'}</h2>
            <div className="board-lines">
              {board.lines.map((i) => lines[i] && (
                <span key={i} className="line-badge" style={badgeStyle(lines[i].colour)}>
                  {badgeText(lines[i])}
                </span>
              ))}
            </div>
            {board.departures.length ? (
              <table className="board-table">
                <tbody>
                  {board.departures.map((row, i) => {
                    const line = lines[row.line]
                    return (
                      <tr
                        key={i}
                        className={row.busId !== null ? 'followable' : undefined}
                        onClick={row.busId !== null ? () => controller?.setFollow(row.busId) : undefined}
                        title={row.busId !== null ? 'Follow this bus' : undefined}
                      >
                        <td className="board-time">{formatClock(row.time)}</td>
                        <td>
                          {line && (
                            <span className="line-badge" style={badgeStyle(line.colour)}>
                              {badgeText(line)}
                            </span>
                          )}
                        </td>
                        <td className="board-to">{row.to ?? line?.name}</td>
                        <td>
                          <Status row={row} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <p className="sim-note">No departures in the next hour.</p>
            )}
            <p className="board-waiting">
              <span className="sim-badge small">Simulated</span> {board.waiting} waiting
              {board.leftBehind > 0 && `, ${board.leftBehind} left behind by a full bus`}
            </p>
            <p className="dashboard-footnote">
              Times are from the real timetable; delays and passengers are simulated. Click a running bus to follow it.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

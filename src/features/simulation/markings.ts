import { SegmentFlag } from '../../types/simulation'
import { edgeShape, outerEdge, type LaneSources } from './lanes'
import { edgeLength, poseOnEdge, type Network, type Pose } from './network'
import type { SignalPlan } from './signals'

/*
 * Road paint at junctions, as polygons in local metres: zebra crossings where
 * OpenStreetMap maps them, and stop lines where traffic lights hold cars.
 * Both span the carriageway where the cars drive (see lanes.ts).
 */

/** Mapped zebra crossings: points in local metres. */
export interface CrossingsFile {
  attribution: string
  points: [number, number][]
}

/** A zebra snapped to the street it crosses: the segment, and where along it. */
export interface Crossing {
  segment: number
  x: number
  y: number
  /** Unit direction of the segment's drawing. */
  dx: number
  dy: number
}

/** Crossings further than this (m) from a car street are left out. */
const SNAP = 8
const STRIPE = 0.5
const STRIPE_LENGTH = 3
const STOP_LINE = 0.4

type Ring = [number, number][]

/** Snaps each mapped crossing to the nearest street cars use. */
export function snapCrossings(net: Network, points: [number, number][]): Crossing[] {
  const CELL = 50
  const grid = new Map<number, number[]>()
  const key = (cx: number, cy: number) => cx * 65_536 + cy
  for (let s = 0; s < net.segmentCount; s++) {
    if (!(net.segFlags[s] & (SegmentFlag.CarForward | SegmentFlag.CarBackward))) continue
    for (let k = net.geomStart[s] + 1; k < net.geomStart[s + 1]; k++) {
      const cx = Math.floor((net.geomX[k] + net.geomX[k - 1]) / 2 / CELL)
      const cy = Math.floor((net.geomY[k] + net.geomY[k - 1]) / 2 / CELL)
      const list = grid.get(key(cx, cy))
      if (list) list.push(k)
      else grid.set(key(cx, cy), [k])
    }
  }
  const segmentOf = new Int32Array(net.geomX.length)
  for (let s = 0; s < net.segmentCount; s++) for (let k = net.geomStart[s]; k < net.geomStart[s + 1]; k++) segmentOf[k] = s

  const out: Crossing[] = []
  for (const [px, py] of points) {
    let best: Crossing | null = null
    let bestD = SNAP
    const cx = Math.floor(px / CELL)
    const cy = Math.floor(py / CELL)
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const k of grid.get(key(gx, gy)) ?? []) {
          const ax = net.geomX[k - 1]
          const ay = net.geomY[k - 1]
          const vx = net.geomX[k] - ax
          const vy = net.geomY[k] - ay
          const len2 = vx * vx + vy * vy || 1
          const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2))
          const x = ax + vx * t
          const y = ay + vy * t
          const d = Math.hypot(px - x, py - y)
          if (d >= bestD) continue
          bestD = d
          const len = Math.sqrt(len2)
          best = { segment: segmentOf[k], x, y, dx: vx / len, dy: vy / len }
        }
      }
    }
    if (best) out.push(best)
  }
  return out
}

/** A rectangle from `along0` to `along1` along a direction and `lat0` to `lat1` to its right. */
function rectangle(x: number, y: number, dx: number, dy: number, along0: number, along1: number, lat0: number, lat1: number): Ring {
  const at = (a: number, l: number): [number, number] => [x + dx * a + dy * l, y + dy * a - dx * l]
  return [at(along0, lat0), at(along1, lat0), at(along1, lat1), at(along0, lat1), at(along0, lat0)]
}

/** Zebra stripes across each crossing's carriageway, and stop lines at the lights (when on). */
export function roadPaint(net: Network, sources: LaneSources, enabled: boolean, crossings: Crossing[], signals: SignalPlan | null, hidden?: Set<number>): Ring[] {
  const out: Ring[] = []
  if (crossings.length) {
    const forward = new Int32Array(net.segmentCount).fill(-1)
    const backward = new Int32Array(net.segmentCount).fill(-1)
    for (let e = 0; e < net.edgeCount; e++) {
      const s = net.edgeSeg[e]
      if (s >= net.segmentCount || !(net.segFlags[s] & (net.edgeRev[e] ? SegmentFlag.CarBackward : SegmentFlag.CarForward))) continue
      ;(net.edgeRev[e] ? backward : forward)[s] = e
    }
    for (const c of crossings) {
      if (hidden?.has(c.segment)) continue
      // The carriageway across, in metres right of the segment's drawing direction.
      const f = forward[c.segment] >= 0 ? edgeShape(net, sources, forward[c.segment], enabled) : null
      const b = backward[c.segment] >= 0 ? edgeShape(net, sources, backward[c.segment], enabled) : null
      if (!f && !b) continue
      const lo = Math.min(f ? f.inner : Infinity, b ? -(b.inner + b.lanes * b.laneWidth) : Infinity)
      const hi = Math.max(f ? f.inner + f.lanes * f.laneWidth : -Infinity, b ? -b.inner : -Infinity)
      for (let l = lo + STRIPE / 2; l + STRIPE <= hi; l += 2 * STRIPE) {
        out.push(rectangle(c.x, c.y, c.dx, c.dy, -STRIPE_LENGTH / 2, STRIPE_LENGTH / 2, l, l + STRIPE))
      }
    }
  }
  if (signals) {
    const pose: Pose = { x: 0, y: 0, dx: 0, dy: 0 }
    for (const approach of signals.approaches) {
      const e = approach.edge
      if (hidden?.has(net.edgeSeg[e])) continue
      poseOnEdge(net, e, Math.max(0, edgeLength(net, e) - approach.stopBack), pose)
      out.push(rectangle(pose.x, pose.y, pose.dx, pose.dy, -STOP_LINE, 0, net.edgeInner[e], outerEdge(net, e)))
    }
  }
  return out
}

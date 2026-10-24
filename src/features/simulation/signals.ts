import { Mode } from '../../types/simulation'
import { LANE_WIDTH } from './lanes'
import { edgeLength, MODE_BIT, poseOnEdge, type Network, type Pose } from './network'

/*
 * Traffic lights at the junctions where OpenStreetMap maps traffic signals.
 *
 * - One junction, one controller: the mapped signals are snapped to car
 *   junctions, and junction points joined by short streets (the corners of a
 *   crossing of two dual carriageways) are grouped into one controller.
 *   Vehicles stop only where they enter the junction; the short links inside
 *   it run freely, so nobody stops again halfway across.
 * - Phases by direction: the main road's direction, then the crossing one,
 *   with amber and an all-red clearance in between. Large junctions (more
 *   than one junction point, traffic from both sides) give left turns a
 *   phase of their own. Where only one direction is signalled, a pedestrian
 *   phase stops it now and then.
 * - Actuated: a green lasts at least MIN_GREEN, is extended while vehicles
 *   keep arriving (up to a maximum), and ends early once they stop coming if
 *   another direction is waiting. Directions with nobody waiting are skipped;
 *   with no traffic anywhere the light stays as it is.
 *
 * Signal positions come from OSM; phases and timings are assumed, not the
 * real signal plans.
 */

export const SignalState = { Green: 0, Amber: 1, Red: 2 } as const
export type SignalState = (typeof SignalState)[keyof typeof SignalState]

/** Mapped signals this close to a junction (m) belong to it. */
const SNAP_DISTANCE = 35
/** Junction points joined by a street this short (m) are one junction. */
const LINK_LENGTH = 50
/** The largest junction (m across) grouping may build. */
const MAX_SPAN = 75

const MIN_GREEN = 6
const MAX_GREEN = [40, 25]
const LEFT_MAX_GREEN = 12
const PEDESTRIAN_GREEN = 10
/** A pedestrian phase is called this often (s) where no crossing traffic calls one. */
const PEDESTRIAN_EVERY = 90
/** Green ends this long (s) after the last vehicle passed the detector, if others wait. */
const GAP = 3
/** Vehicles closer than this (m) to the stop line call a green; closer than DETECTOR they extend it. */
const CALL_DISTANCE = 100
const DETECTOR = 35
/** Signal heads stand on the kerb, this far (m) right of the lane centre. */
const KERB = 4.5

const Stage = { Green: 0, Amber: 1, AllRed: 2 } as const
type Stage = (typeof Stage)[keyof typeof Stage]

interface Phase {
  /** 0 the main road's direction, 1 the crossing one, -1 a pedestrian phase. */
  axis: number
  left: boolean
  maxGreen: number
}

interface Controller {
  phases: Phase[]
  /** Index of the first phase in the shared per-phase arrays. */
  phaseStart: number
  /** Phase serving through and right-turning traffic per axis, and left turns (-1: with the through traffic). */
  through: [number, number]
  left: [number, number]
  amber: number
  allRed: number
}

export interface Approach {
  edge: number
  controller: number
  axis: number
  /** Metres before the junction point where vehicles stop. */
  stopBack: number
}

/** A signal head: where it stands (local metres), the bearing it faces, and what it shows. */
export interface SignalHead {
  x: number
  y: number
  bearing: number
  approach: number
  left: boolean
}

/** The fixed part: which junctions have lights and how they are wired. Shared by every run. */
export interface SignalPlan {
  controllers: Controller[]
  approaches: Approach[]
  heads: SignalHead[]
  /** Approach index per edge, or -1. */
  approachOf: Int32Array
  /** 1 for the short links inside a signalled junction. */
  internal: Uint8Array
  phaseCount: number
}

const angleBetween = (a: number, b: number) => {
  let d = Math.abs(a - b) % (2 * Math.PI)
  if (d > Math.PI) d = 2 * Math.PI - d
  return d
}

/** Signed turn from one heading to another (radians, left positive). */
export function turnAngle(from: number, to: number) {
  let d = (to - from) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d < -Math.PI) d += 2 * Math.PI
  return d
}

export function buildSignalPlan(net: Network, points: [number, number][]): SignalPlan {
  const car = MODE_BIT[Mode.Car]
  const nodes = net.nodeCount

  // Car junctions: three or more streets with cars.
  const streets = new Uint8Array(nodes)
  const seen = new Set<number>()
  for (let n = 0; n < nodes; n++) {
    seen.clear()
    for (let k = net.outStart[n]; k < net.outStart[n + 1]; k++) if (net.edgeModes[net.outEdges[k]] & car) seen.add(net.edgeSeg[net.outEdges[k]])
    for (let k = net.inStart[n]; k < net.inStart[n + 1]; k++) if (net.edgeModes[net.inEdges[k]] & car) seen.add(net.edgeSeg[net.inEdges[k]])
    streets[n] = Math.min(255, seen.size)
  }
  const CELL = 50
  const grid = new Map<string, number[]>()
  for (let n = 0; n < nodes; n++) {
    if (streets[n] < 3) continue
    const key = `${Math.floor(net.nodeX[n] / CELL)},${Math.floor(net.nodeY[n] / CELL)}`
    const cell = grid.get(key)
    if (cell) cell.push(n)
    else grid.set(key, [n])
  }

  // Snap each mapped signal to the nearest junction.
  const signalled = new Set<number>()
  for (const [x, y] of points) {
    const cx = Math.floor(x / CELL)
    const cy = Math.floor(y / CELL)
    let best = -1
    let bestD = SNAP_DISTANCE
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const n of grid.get(`${cx + i},${cy + j}`) ?? []) {
          const d = Math.hypot(net.nodeX[n] - x, net.nodeY[n] - y)
          if (d < bestD) {
            bestD = d
            best = n
          }
        }
      }
    }
    if (best >= 0) signalled.add(best)
  }

  // Group junction points joined by short streets, keeping each group compact.
  const group = new Map<number, number[]>()
  for (const n of signalled) group.set(n, [n])
  const span = (a: number[], b: number[]) => {
    let max = 0
    for (const p of a) for (const q of b) max = Math.max(max, Math.hypot(net.nodeX[p] - net.nodeX[q], net.nodeY[p] - net.nodeY[q]))
    return max
  }
  const join = (a: number, b: number) => {
    const ga = group.get(a)!
    const gb = group.get(b)!
    if (ga === gb || span(ga, gb) > MAX_SPAN) return
    for (const n of gb) {
      ga.push(n)
      group.set(n, ga)
    }
  }
  const shortNeighbours = (n: number) => {
    const out: number[] = []
    for (let k = net.outStart[n]; k < net.outStart[n + 1]; k++) {
      const e = net.outEdges[k]
      if (net.edgeModes[e] & car && edgeLength(net, e) <= LINK_LENGTH) out.push(net.edgeTo[e])
    }
    for (let k = net.inStart[n]; k < net.inStart[n + 1]; k++) {
      const e = net.inEdges[k]
      if (net.edgeModes[e] & car && edgeLength(net, e) <= LINK_LENGTH) out.push(net.edgeFrom[e])
    }
    return out
  }
  for (const n of signalled) for (const m of shortNeighbours(n)) if (signalled.has(m)) join(n, m)
  // A corner of the crossing without a mapped signal of its own joins when it links two of its points.
  for (const n of [...signalled]) {
    for (const m of shortNeighbours(n)) {
      if (group.has(m) || streets[m] < 3) continue
      const g = group.get(n)!
      const links = new Set(shortNeighbours(m).filter((k) => g.includes(k)))
      if (links.size >= 2 && span(g, [m]) <= MAX_SPAN) {
        g.push(m)
        group.set(m, g)
      }
    }
  }

  const plan: SignalPlan = {
    controllers: [],
    approaches: [],
    heads: [],
    approachOf: new Int32Array(net.edgeCount).fill(-1),
    internal: new Uint8Array(net.edgeCount),
    phaseCount: 0,
  }
  const pose: Pose = { x: 0, y: 0, dx: 0, dy: 0 }
  for (const members of new Set(group.values())) {
    const inside = new Set(members)
    const edges: number[] = []
    for (const n of members) {
      for (let k = net.inStart[n]; k < net.inStart[n + 1]; k++) {
        const e = net.inEdges[k]
        if (!(net.edgeModes[e] & car)) continue
        if (inside.has(net.edgeFrom[e])) plan.internal[e] = 1
        else edges.push(e)
      }
    }
    if (edges.length < 2) {
      for (const n of members) for (let k = net.inStart[n]; k < net.inStart[n + 1]; k++) plan.internal[net.inEdges[k]] = 0
      continue
    }
    const big = members.length > 1
    const main = edges.reduce((best, e) => (net.edgePriority[e] > net.edgePriority[best] ? e : best), edges[0])
    const reference = net.edgeEndHeading[main]
    const axisOf = (e: number) => {
      const d = angleBetween(net.edgeEndHeading[e], reference) % Math.PI
      return Math.min(d, Math.PI - d) < Math.PI / 4 ? 0 : 1
    }
    // Left turns get their own phase on large junctions with traffic from both sides.
    const opposed = [0, 1].map((axis) => {
      const list = edges.filter((e) => axisOf(e) === axis)
      return list.some((a) => list.some((b) => angleBetween(net.edgeEndHeading[a], net.edgeEndHeading[b]) > (3 * Math.PI) / 4))
    })
    const phases: Phase[] = []
    const through: [number, number] = [-1, -1]
    const left: [number, number] = [-1, -1]
    for (const axis of [0, 1]) {
      if (!edges.some((e) => axisOf(e) === axis)) continue
      through[axis] = phases.length
      phases.push({ axis, left: false, maxGreen: MAX_GREEN[axis] })
      if (big && opposed[axis]) {
        left[axis] = phases.length
        phases.push({ axis, left: true, maxGreen: LEFT_MAX_GREEN })
      }
    }
    if (through[0] < 0 || through[1] < 0) phases.push({ axis: -1, left: false, maxGreen: PEDESTRIAN_GREEN })

    let diameter = 0
    for (const a of members) for (const b of members) diameter = Math.max(diameter, Math.hypot(net.nodeX[a] - net.nodeX[b], net.nodeY[a] - net.nodeY[b]))
    const fast = edges.some((e) => net.segCarSpeed[net.edgeSeg[e]] > 55 / 3.6)
    const controller = plan.controllers.length
    plan.controllers.push({
      phases,
      phaseStart: plan.phaseCount,
      through,
      left,
      amber: fast ? 4 : 3,
      allRed: Math.min(4, 1.5 + diameter / 10),
    })
    plan.phaseCount += phases.length

    for (const e of edges) {
      const length = edgeLength(net, e)
      // Stop before the crossing road; inside a large junction the points sit on the carriageways.
      const stopBack = Math.min(big ? 3 : 7, length * 0.5)
      const axis = axisOf(e)
      const approach = plan.approaches.length
      plan.approachOf[e] = approach
      plan.approaches.push({ edge: e, controller, axis, stopBack })
      poseOnEdge(net, e, Math.max(0, length - stopBack), pose)
      // Past the outer lane on multi-lane approaches.
      const oneWay = !hasReverse(net, e)
      const kerb = KERB + (net.edgeLanes[e] - 1) * LANE_WIDTH * (oneWay ? 0.5 : 1)
      const bearing = (((270 - (Math.atan2(pose.dy, pose.dx) * 180) / Math.PI) % 360) + 360) % 360
      plan.heads.push({ x: pose.x + pose.dy * kerb, y: pose.y - pose.dx * kerb, bearing, approach, left: false })
      if (left[axis] >= 0) {
        // A second head for the left-turn phase, on the far side of the lane.
        const side = oneWay ? KERB - 1 : 0.8
        plan.heads.push({ x: pose.x - pose.dy * side, y: pose.y + pose.dx * side, bearing, approach, left: true })
      }
    }
  }
  return plan
}

function hasReverse(net: Network, edge: number) {
  const from = net.edgeFrom[edge]
  for (let k = net.inStart[from]; k < net.inStart[from + 1]; k++) {
    const e = net.inEdges[k]
    if (net.edgeSeg[e] === net.edgeSeg[edge] && net.edgeModes[e] & MODE_BIT[Mode.Car]) return true
  }
  return false
}

/** The running lights of one simulation; `clone` gives another run the same junctions. */
export class Signals {
  /** Off: every junction uses the right-of-way rules, as without lights. */
  enabled = true
  readonly plan: SignalPlan
  private current: Int32Array
  private stage: Uint8Array
  private time: Float32Array
  private gap: Float32Array
  /** Seconds since each phase last ended (pedestrian phases call themselves after a while). */
  private idle: Float32Array
  private called: Uint8Array
  private active: Uint8Array

  constructor(plan: SignalPlan) {
    this.plan = plan
    const count = plan.controllers.length
    this.current = new Int32Array(count)
    this.stage = new Uint8Array(count)
    this.time = new Float32Array(count)
    this.gap = new Float32Array(count)
    this.idle = new Float32Array(plan.phaseCount)
    this.called = new Uint8Array(plan.phaseCount)
    this.active = new Uint8Array(plan.phaseCount)
    // Neighbouring junctions shouldn't all switch in step.
    plan.controllers.forEach((c, i) => {
      this.current[i] = i % c.phases.length
      this.time[i] = (i * 7) % MIN_GREEN
    })
  }

  clone(): Signals {
    const copy = new Signals(this.plan)
    copy.enabled = this.enabled
    return copy
  }

  get approaches() {
    return this.plan.approaches
  }

  /** True for the short links inside a signalled junction, where vehicles don't stop or give way. */
  isInternal(edge: number) {
    return this.enabled && edge < this.plan.internal.length && this.plan.internal[edge] === 1
  }

  approachFor(edge: number) {
    return this.enabled && edge < this.plan.approachOf.length ? this.plan.approachOf[edge] : -1
  }

  /** Stop line distance before the end of an approach edge. */
  stopBack(edge: number) {
    return this.plan.approaches[this.plan.approachOf[edge]].stopBack
  }

  /**
   * The first street after the junction for a vehicle on `edges[idx]`
   * (skipping links inside it), or -1.
   */
  exitAfter(edges: Int32Array | number[], idx: number) {
    let k = idx + 1
    while (k < edges.length && this.isInternal(edges[k])) k++
    return k < edges.length ? edges[k] : -1
  }

  /** Whether going from an approach to an exit street is a left turn (or a U-turn). */
  turnsLeft(net: Network, edge: number, exit: number) {
    return exit >= 0 && turnAngle(net.edgeEndHeading[edge], net.edgeStartHeading[exit]) > 0.5
  }

  private phaseOf(approach: number, left: boolean) {
    const a = this.plan.approaches[approach]
    const c = this.plan.controllers[a.controller]
    return left && c.left[a.axis] >= 0 ? c.left[a.axis] : c.through[a.axis]
  }

  /** What an approach shows to traffic turning left or not; -1 without a light. */
  state(edge: number, left: boolean): SignalState | -1 {
    const approach = this.approachFor(edge)
    return approach < 0 ? -1 : this.stateOf(approach, left)
  }

  private stateOf(approach: number, left: boolean): SignalState {
    const controller = this.plan.approaches[approach].controller
    if (this.current[controller] !== this.phaseOf(approach, left)) return SignalState.Red
    const stage = this.stage[controller]
    return stage === Stage.Green ? SignalState.Green : stage === Stage.Amber ? SignalState.Amber : SignalState.Red
  }

  /** A vehicle `toEnd` metres before the end of an approach edge; called every step. */
  detect(edge: number, toEnd: number, speed: number, left: boolean) {
    const approach = this.approachFor(edge)
    if (approach < 0) return
    const c = this.plan.controllers[this.plan.approaches[approach].controller]
    const phase = c.phaseStart + this.phaseOf(approach, left)
    if (toEnd < CALL_DISTANCE) this.called[phase] = 1
    if (toEnd < DETECTOR && speed > 1) this.active[phase] = 1
  }

  step(dt: number) {
    const { controllers } = this.plan
    for (let i = 0; i < this.idle.length; i++) this.idle[i] += dt
    for (let c = 0; c < controllers.length; c++) {
      const ctl = controllers[c]
      const phase = this.current[c]
      this.time[c] += dt
      const t = this.time[c]
      if (this.stage[c] === Stage.Green) {
        const p = ctl.phases[phase]
        this.idle[ctl.phaseStart + phase] = 0
        this.gap[c] = this.active[ctl.phaseStart + phase] ? 0 : this.gap[c] + dt
        const pedestrian = p.axis < 0
        const waiting = this.nextCalled(c) !== phase
        const done = pedestrian ? t >= p.maxGreen : t >= MIN_GREEN && waiting && (this.gap[c] >= GAP || t >= p.maxGreen)
        if (done) this.setStage(c, Stage.Amber)
      } else if (this.stage[c] === Stage.Amber) {
        // A pedestrian phase has no amber for traffic: it is all red already.
        if (t >= ctl.amber || ctl.phases[phase].axis < 0) this.setStage(c, Stage.AllRed)
      } else if (t >= ctl.allRed) {
        this.current[c] = this.nextCalled(c)
        this.setStage(c, Stage.Green)
      }
    }
    this.called.fill(0)
    this.active.fill(0)
  }

  private setStage(c: number, stage: Stage) {
    this.stage[c] = stage
    this.time[c] = 0
    this.gap[c] = 0
  }

  /** The next phase after the current one with someone waiting (the current one when nobody else is). */
  private nextCalled(c: number) {
    const ctl = this.plan.controllers[c]
    const count = ctl.phases.length
    for (let k = 1; k <= count; k++) {
      const phase = (this.current[c] + k) % count
      const index = ctl.phaseStart + phase
      const calls = ctl.phases[phase].axis < 0 ? this.idle[index] > PEDESTRIAN_EVERY : this.called[index] === 1
      if (calls && phase !== this.current[c]) return phase
    }
    return this.current[c]
  }

  /** States of all signal heads, in plan order. */
  writeStates(out: Uint8Array) {
    const { heads } = this.plan
    for (let i = 0; i < heads.length; i++) out[i] = this.stateOf(heads[i].approach, heads[i].left)
  }
}

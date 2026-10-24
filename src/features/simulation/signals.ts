import { Mode } from '../../types/simulation'
import { MODE_BIT, poseOnEdge, edgeLength, type Network, type Pose } from './network'

/*
 * Traffic lights at the signalised junctions mapped in OpenStreetMap. Each
 * controller runs a fixed two-phase cycle: approaches roughly in line with the
 * main road share one phase, crossing approaches the other (a crossing with
 * only one direction of approach gets a pedestrian phase instead). Timings
 * are assumed, not real signal plans. A light's state is a pure function of
 * the clock, so jumping in time needs no bookkeeping.
 */

export const SignalState = { Green: 0, Amber: 1, Red: 2 } as const
export type SignalState = (typeof SignalState)[keyof typeof SignalState]

const AMBER = 3
const ALL_RED = 2
const MAIN_GREEN = 32
const SIDE_GREEN = 20
const PEDESTRIAN_GREEN = 14

export interface Approach {
  edge: number
  controller: number
  phase: 0 | 1
  /** Where the signal head stands: local metres, and the bearing it faces (towards oncoming traffic). */
  x: number
  y: number
  bearing: number
}

interface Controller {
  green: [number, number]
  cycle: number
  offset: number
}

function hash(n: number) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296
}

export class Signals {
  readonly approaches: Approach[] = []
  /** Approach index per edge, or -1. */
  readonly approachOf: Int32Array
  private controllers: Controller[] = []

  constructor(net: Network) {
    this.approachOf = new Int32Array(net.edgeCount).fill(-1)
    const car = MODE_BIT[Mode.Car]
    const pose: Pose = { x: 0, y: 0, dx: 0, dy: 0 }
    net.signals.forEach((nodes, controller) => {
      const members = new Set(nodes)
      const edges: number[] = []
      for (const node of nodes) {
        for (let k = net.inStart[node]; k < net.inStart[node + 1]; k++) {
          const e = net.inEdges[k]
          // Approaches come from outside the crossing; links inside it run freely.
          if (net.edgeModes[e] & car && !members.has(net.edgeFrom[e])) edges.push(e)
        }
      }
      if (!edges.length) {
        this.controllers.push({ green: [MAIN_GREEN, PEDESTRIAN_GREEN], cycle: 1, offset: 0 })
        return
      }
      // The main direction is that of the highest-priority approach.
      const main = edges.reduce((best, e) => (net.edgePriority[e] > net.edgePriority[best] ? e : best), edges[0])
      const reference = net.edgeEndHeading[main]
      let crossing = false
      for (const e of edges) {
        let d = Math.abs(net.edgeEndHeading[e] - reference) % Math.PI
        if (d > Math.PI / 2) d = Math.PI - d
        const phase = d < Math.PI / 4 ? 0 : 1
        if (phase) crossing = true
        const length = edgeLength(net, e)
        poseOnEdge(net, e, Math.max(0, length - 3), pose)
        this.approachOf[e] = this.approaches.length
        this.approaches.push({
          edge: e,
          controller,
          phase,
          // On the kerb to the right of the stop line, facing the traffic.
          x: pose.x + pose.dy * 4.5,
          y: pose.y - pose.dx * 4.5,
          bearing: (270 - (Math.atan2(pose.dy, pose.dx) * 180) / Math.PI) % 360,
        })
      }
      const green: [number, number] = [MAIN_GREEN, crossing ? SIDE_GREEN : PEDESTRIAN_GREEN]
      const cycle = green[0] + green[1] + 2 * (AMBER + ALL_RED)
      this.controllers.push({ green, cycle, offset: hash(controller) * cycle })
    })
  }

  /** State of one approach at a time of day. */
  state(approach: number, clock: number): SignalState {
    const { controller, phase } = this.approaches[approach]
    const { green, cycle, offset } = this.controllers[controller]
    const t = (clock + offset) % cycle
    const start = phase === 0 ? 0 : green[0] + AMBER + ALL_RED
    const into = t - start
    if (into >= 0 && into < green[phase]) return SignalState.Green
    if (into >= green[phase] && into < green[phase] + AMBER) return SignalState.Amber
    return SignalState.Red
  }

  /** State for traffic on an edge, or -1 when the edge has no light. */
  stateForEdge(edge: number, clock: number): SignalState | -1 {
    const a = edge < this.approachOf.length ? this.approachOf[edge] : -1
    return a < 0 ? -1 : this.state(a, clock)
  }

  /** States of all approaches, in order. */
  writeStates(clock: number, out: Uint8Array) {
    for (let i = 0; i < this.approaches.length; i++) out[i] = this.state(i, clock)
  }
}

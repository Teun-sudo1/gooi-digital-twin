import { AGENT_STRIDE, AgentFlag, Kind, Mode, type FollowInfo, type RouteDiagram, type RouteSide } from '../../types/simulation'
import { edgeLength, MODE_BIT, poseOnEdge, type Network, type Pose } from './network'
import { findRoute } from './routing'
import { profileAt, type Agent, type TrafficModel } from './traffic'
import { BUS_ID_BASE, type Line, type TransitModel, type Trip } from './transit'

/*
 * Buses in road traffic. Each scheduled bus trip becomes a vehicle that drives
 * its real route (the OSM line geometry), stops at its stops, and tries to
 * keep to the timetable: it never leaves a stop early, and between stops it
 * aims for the scheduled arrival without exceeding the speed limit. Where the
 * route runs along a street of the simulated network, the bus queues behind
 * cars, and cars queue behind it. Where a street on the
 * route is closed to buses, it takes the fastest diversion and rejoins the
 * route after the closure, skipping the stops in between. Delays build up
 * from all of that; they are simulated, not live.
 *
 * Stretches of route without a matching street (bus-only roads that aren't in
 * the car network, such as HOV busways) are driven freely.
 *
 * Passengers are simulated with assumed demand (there is no ridership data):
 * they arrive at stops at a rate that follows the rush hours and is higher at
 * stops served by several lines, board the next bus (boarding takes time),
 * and get off along the way.
 */

const DAY = 86_400
/** Bus length (m); a bus's position along the line is its centre. */
const BUS_LENGTH = 12
const HALF = BUS_LENGTH / 2
const ACCEL = 1.0
const DECEL = 1.4
const MAX_DECEL = 5
const MIN_DWELL = 12
/** Speed on bus-only stretches without a matching street (m/s). */
const FREE_SPEED = 16.7
const MAX_SPEED = 22
/** How far ahead (m) a bus looks for closed streets on its route. */
const LOOKAHEAD = 400
const REJOIN_SEARCH = 5000
const LATERAL = 1.7
/** Assumed passengers per hour arriving at an ordinary stop of one line in the peak. */
const PEAK_ARRIVALS = 8
const MAX_WAITING = 40
const SECONDS_PER_PASSENGER = 1.5
const MAX_DWELL = 45
/** Assumed share of the peak passenger demand per hour of the day. */
const PASSENGER_PROFILE = [0.05, 0.02, 0.01, 0.01, 0.02, 0.1, 0.4, 0.9, 1.0, 0.6, 0.45, 0.5, 0.55, 0.5, 0.55, 0.75, 0.95, 0.9, 0.6, 0.4, 0.3, 0.22, 0.15, 0.08]

/** A stretch of a line that runs along one directed street edge. */
interface Run {
  d0: number
  d1: number
  edge: number
  /** Offset along the edge at d0 and d1. */
  o0: number
  o1: number
}

interface Stop {
  d: number
  arrive: number
  depart: number
}

interface Plan {
  /** Distance along the line where the bus leaves its route. */
  at: number
  /** Diversion, or null when no way back to the route exists (the trip ends there). */
  edges: Int32Array | null
  /** Distance along the line where it rejoins. */
  rejoin: number
}

interface Bus {
  id: number
  line: Line
  trip: Trip
  stops: Stop[]
  stopIdx: number
  end: number
  d: number
  v: number
  dwellUntil: number
  delay: number
  braking: boolean
  plan: Plan | null
  planVersion: number
  /** Where the route ahead was last checked for closures. */
  checkedAt: number
  /** On a diversion: edge index and front offset along it. */
  detour: { edges: Int32Array; idx: number; offset: number; rejoin: number } | null
  /** Stand-in that road traffic queues behind. */
  pseudo: Agent
  /** Index of each trip stop among the line's stops (-1 when not one of them). */
  stopLine: Int32Array
  onBoard: number
}

/**
 * Matches each bus line to the street edges it runs along: the line is
 * sampled every 6 m and each sample snapped to the nearest car edge pointing
 * the same way (within 8 m and 35°). Consecutive samples on one edge form a run.
 */
export function matchLines(transit: TransitModel, net: Network): Run[][] {
  const CELL = 30
  const grid = new Map<number, number[]>()
  const key = (cx: number, cy: number) => cx * 65_536 + cy
  const motor = MODE_BIT[Mode.Car] | MODE_BIT[Mode.Bus]
  const edgeOf = new Int32Array(net.segmentCount * 2).fill(-1)
  for (let e = 0; e < net.edgeCount; e++) if (net.edgeModes[e] & motor) edgeOf[net.edgeSeg[e] * 2 + net.edgeRev[e]] = e
  for (let s = 0; s < net.segmentCount; s++) {
    if (edgeOf[2 * s] < 0 && edgeOf[2 * s + 1] < 0) continue
    for (let k = net.geomStart[s] + 1; k < net.geomStart[s + 1]; k++) {
      const x0 = Math.floor((Math.min(net.geomX[k], net.geomX[k - 1]) - 8) / CELL)
      const x1 = Math.floor((Math.max(net.geomX[k], net.geomX[k - 1]) + 8) / CELL)
      const y0 = Math.floor((Math.min(net.geomY[k], net.geomY[k - 1]) - 8) / CELL)
      const y1 = Math.floor((Math.max(net.geomY[k], net.geomY[k - 1]) + 8) / CELL)
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const list = grid.get(key(cx, cy))
          if (list) list.push(k)
          else grid.set(key(cx, cy), [k])
        }
      }
    }
  }
  // Segment of each geometry point (points are stored per segment, in order).
  const segOfPoint = new Int32Array(net.geomX.length)
  for (let s = 0; s < net.segmentCount; s++) for (let k = net.geomStart[s]; k < net.geomStart[s + 1]; k++) segOfPoint[k] = s

  const p = { x: 0, y: 0, bearing: 0 }
  const cos35 = Math.cos((35 * Math.PI) / 180)
  return transit.lines.map((line) => {
    if (line.info.mode !== 'bus' || !line.trips?.length) return []
    const runs: Run[] = []
    let current: Run | null = null
    for (let d = 0; d <= line.length; d += 6) {
      const { dx, dy } = transit.pointAt(line, d, p)
      const len = Math.hypot(dx, dy) || 1
      let best = -1
      let bestD = 8
      let bestOffset = 0
      for (const k of grid.get(key(Math.floor(p.x / CELL), Math.floor(p.y / CELL))) ?? []) {
        const ax = net.geomX[k - 1]
        const ay = net.geomY[k - 1]
        const sx = net.geomX[k] - ax
        const sy = net.geomY[k] - ay
        const l2 = sx * sx + sy * sy || 1
        const t = Math.max(0, Math.min(1, ((p.x - ax) * sx + (p.y - ay) * sy) / l2))
        const dist = Math.hypot(ax + sx * t - p.x, ay + sy * t - p.y)
        if (dist >= bestD) continue
        const dot = (sx * dx + sy * dy) / (Math.sqrt(l2) * len)
        const s = segOfPoint[k]
        const rev = dot < -cos35 ? 1 : dot > cos35 ? 0 : -1
        if (rev < 0) continue
        const e = edgeOf[s * 2 + rev]
        if (e < 0) continue
        const along = net.geomDist[k - 1] + t * Math.sqrt(l2)
        best = e
        bestD = dist
        bestOffset = rev ? net.segLength[s] - along : along
      }
      if (best >= 0 && current && current.edge === best) {
        current.d1 = d
        current.o1 = bestOffset
      } else {
        if (current && current.d1 - current.d0 >= 10) runs.push(current)
        current = best >= 0 ? { d0: d, d1: d, edge: best, o0: bestOffset, o1: bestOffset } : null
      }
    }
    if (current && current.d1 - current.d0 >= 10) runs.push(current)
    // Stretch runs to the edge ends, so consecutive streets join up.
    for (const run of runs) {
      const length = edgeLength(net, run.edge)
      const before = Math.min(run.o0, 9)
      const after = Math.min(length - run.o1, 9)
      run.d0 -= before
      run.o0 -= before
      run.d1 += after
      run.o1 += after
    }
    return runs
  })
}

function stopsOf(line: Line, trip: Trip): Stop[] {
  const length = Math.round(line.length)
  const stops: Stop[] = []
  for (let k = 0; k < trip.dist.length; k++) {
    const d = trip.dist[k]
    if (d <= 1 || d >= length - 1) continue
    const last = stops.at(-1)
    if (last && Math.abs(last.d - d) < 1) last.depart = trip.times[k]
    else stops.push({ d, arrive: trip.times[k], depart: trip.times[k] })
  }
  return stops
}

export interface BusMeasures {
  /** Bus-seconds in service and delay-seconds accumulated, for the average delay. */
  busSeconds: number
  delaySeconds: number
}

export class BusFleet {
  buses: Bus[] = []
  measures: BusMeasures = { busSeconds: 0, delaySeconds: 0 }
  private transit: TransitModel
  private runs: Run[][]
  private traffic: TrafficModel
  private started: Set<number> = new Set()
  private lastClock = -1
  /** Bumped when the street network changes, so diversions are re-planned. */
  private networkVersion = 0
  private pose: Pose = { x: 0, y: 0, dx: 0, dy: 0 }
  private point = { x: 0, y: 0, bearing: 0 }
  /** Simulated passengers waiting at each stop of each line, and how busy each stop is. */
  private waiting: Float64Array[]
  private stopWeight: Float64Array[]
  /** The line running the other way (same number), or -1. */
  private reverseOf: Int32Array
  /** First departure and last arrival of each line today (s), or null without trips. */
  private service: ([number, number] | null)[]

  constructor(transit: TransitModel, runs: Run[][], traffic: TrafficModel) {
    this.transit = transit
    this.runs = runs
    this.traffic = traffic
    // Stops shared by several lines (and bus stations) are busier.
    const linesAt = new Map<string, Set<string>>()
    for (const line of transit.lines) {
      if (line.info.mode !== 'bus') continue
      for (const name of line.stopNames) if (name) linesAt.set(name, (linesAt.get(name) ?? new Set()).add(line.info.ref))
    }
    this.stopWeight = transit.lines.map((line) =>
      Float64Array.from(line.stopNames, (name) => {
        if (!name) return 0.6
        const shared = 0.6 + 0.4 * (linesAt.get(name)?.size ?? 1)
        return /station/i.test(name) ? shared * 2 : shared
      }),
    )
    this.waiting = transit.lines.map((line) => new Float64Array(line.stopDist.length))
    this.service = transit.lines.map((line) =>
      line.trips?.length
        ? [line.trips[0].times[0], line.trips.reduce((m, t) => Math.max(m, t.times[t.times.length - 1]), 0)]
        : null,
    )
    this.reverseOf = Int32Array.from(transit.lines, (line) => {
      if (line.info.mode !== 'bus') return -1
      const same = transit.lines.filter((l) => l !== line && l.info.mode === 'bus' && l.info.ref === line.info.ref && l.trips?.length)
      const back = same.find((l) => l.info.to && l.info.to === line.info.from) ?? same.find((l) => l.info.to !== line.info.to)
      return back ? back.info.index : -1
    })
  }

  /** Lines with buses in service today, between their first and last trip. */
  private inService(line: Line, clock: number) {
    const window = this.service[line.info.index]
    if (!window) return false
    const [first, last] = window
    return (clock >= first && clock <= last) || clock + DAY <= last
  }

  private passengersArrive(dt: number, clock: number) {
    const rate = (PEAK_ARRIVALS * profileAt(PASSENGER_PROFILE, clock) * dt) / 3600
    this.transit.lines.forEach((line, li) => {
      if (line.info.mode !== 'bus' || !this.inService(line, clock)) return
      const waiting = this.waiting[li]
      const weight = this.stopWeight[li]
      for (let k = 0; k < waiting.length; k++) waiting[k] = Math.min(MAX_WAITING, waiting[k] + rate * weight[k])
    })
  }

  resetMeasures() {
    this.measures = { busSeconds: 0, delaySeconds: 0 }
  }

  /** A copy for another traffic model (the original network in a comparison). */
  fork(traffic: TrafficModel): BusFleet {
    const copy = new BusFleet(this.transit, this.runs, traffic)
    copy.started = new Set(this.started)
    copy.lastClock = this.lastClock
    copy.waiting = this.waiting.map((w) => w.slice())
    copy.buses = this.buses.map((b) => ({ ...b, plan: null, detour: b.detour && { ...b.detour }, pseudo: { ...b.pseudo, edges: Int32Array.from(b.pseudo.edges) } }))
    return copy
  }

  networkChanged() {
    this.networkVersion++
  }

  /** Places buses at their scheduled positions (start, or after a jump in time). */
  reset(clock: number) {
    this.buses = []
    this.started.clear()
    this.lastClock = clock
    // About ten minutes' worth of passengers at each stop.
    const level = (PEAK_ARRIVALS * profileAt(PASSENGER_PROFILE, clock)) / 6
    this.transit.lines.forEach((line, li) => {
      const service = line.info.mode === 'bus' && this.inService(line, clock)
      this.waiting[li] = Float64Array.from(this.stopWeight[li], (w) => (service ? level * w : 0))
    })
    this.activate(clock, true)
  }

  private activate(clock: number, midTrip: boolean) {
    const transit = this.transit
    transit.lines.forEach((line, li) => {
      if (line.info.mode !== 'bus' || !line.trips) return
      line.trips.forEach((trip, ti) => {
        const id = BUS_ID_BASE + li * 1000 + ti
        if (this.started.has(id)) return
        const n = trip.times.length
        for (const now of [clock, clock + DAY]) {
          if (now < trip.times[0] || now >= trip.times[n - 1]) continue
          // Starting on time: from the first point. Mid-trip (after a jump): where the timetable puts it.
          if (!midTrip && now - trip.times[0] > 60) continue
          const d = midTrip ? transit.scheduledDistance(line, trip, now) : trip.dist[0]
          if (d < 0) continue
          this.started.add(id)
          const stops = stopsOf(line, trip)
          const stopLine = Int32Array.from(stops, (stop) => {
            let best = -1
            let bestD = 150
            line.stopDist.forEach((sd, i) => {
              if (Math.abs(sd - stop.d) < bestD) {
                bestD = Math.abs(sd - stop.d)
                best = i
              }
            })
            return best
          })
          const bus: Bus = {
            id,
            line,
            trip,
            stops,
            stopIdx: stops.findIndex((s) => s.d > d + 1),
            end: trip.dist[n - 1],
            d,
            v: midTrip ? 6 : 8,
            dwellUntil: 0,
            delay: 0,
            braking: false,
            plan: null,
            planVersion: -1,
            checkedAt: -Infinity,
            detour: null,
            stopLine,
            // Mid-trip buses already carry some passengers.
            onBoard: midTrip ? Math.round(4 + ((id * 7919) % 13)) : 0,
            pseudo: {
              id: -1, kind: Kind.Bus, mode: Mode.Car, colour: 0, edges: new Int32Array(1), idx: 0, offset: 0, speed: 0,
              desired: 1, top: MAX_SPEED, accel: ACCEL, length: BUS_LENGTH, lateral: LATERAL, dest: -1, destIsZone: false,
              needsRoute: false, departedAt: now, slowFor: 0, braking: false, external: true,
            },
          }
          if (bus.stopIdx < 0) bus.stopIdx = stops.length
          this.buses.push(bus)
          break
        }
      })
    })
  }

  private runAt(runs: Run[], d: number): Run | null {
    let lo = 0
    let hi = runs.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (runs[mid].d1 < d) lo = mid + 1
      else if (runs[mid].d0 > d) hi = mid - 1
      else return runs[mid]
    }
    return null
  }

  /** Offset along a run's edge for a distance along the line. */
  private offsetIn(run: Run, d: number) {
    return run.o0 + ((d - run.d0) * (run.o1 - run.o0)) / (run.d1 - run.d0 || 1)
  }

  /** Scheduled time at distance d (between the stops either side), for the delay. */
  private scheduledAt(bus: Bus, d: number) {
    const { trip } = bus
    const n = trip.dist.length
    if (d <= trip.dist[0]) return trip.times[0]
    for (let k = 1; k < n; k++) {
      if (trip.dist[k] >= d) {
        const span = trip.dist[k] - trip.dist[k - 1]
        return span <= 0 ? trip.times[k] : trip.times[k - 1] + ((d - trip.dist[k - 1]) / span) * (trip.times[k] - trip.times[k - 1])
      }
    }
    return trip.times[n - 1]
  }

  /** Looks for a closed street ahead on the route and plans a diversion around it. */
  private planAhead(bus: Bus, runs: Run[]) {
    const fresh = bus.planVersion === this.networkVersion
    if (fresh && bus.plan && bus.plan.at > bus.d) return
    if (fresh && !bus.plan && bus.d < bus.checkedAt + 100) return
    bus.planVersion = this.networkVersion
    bus.checkedAt = bus.d
    bus.plan = null
    const net = this.traffic.net
    const bit = MODE_BIT[Mode.Bus]
    const front = bus.d + HALF
    const blocked = runs.findIndex((r) => r.d0 > front + 1 && r.d0 < front + LOOKAHEAD && !(net.edgeModes[r.edge] & bit))
    if (blocked < 0) return
    const from = net.edgeFrom[runs[blocked].edge]
    for (let r = blocked + 1; r < runs.length && runs[r].d0 < runs[blocked].d1 + REJOIN_SEARCH; r++) {
      const run = runs[r]
      if (!(net.edgeModes[run.edge] & bit) || run.d0 < runs[blocked].d1) continue
      const route = findRoute(net, Mode.Bus, from, net.edgeFrom[run.edge])
      if (!route) continue
      bus.plan = { at: runs[blocked].d0, edges: route.edges, rejoin: run.d0 }
      return
    }
    bus.plan = { at: runs[blocked].d0, edges: null, rejoin: Infinity }
  }

  step(dt: number, clock: number) {
    // Midnight, or a jump the worker didn't announce: start the day's schedule afresh.
    if (clock < this.lastClock - 1) this.reset(clock)
    this.lastClock = clock
    this.activate(clock, false)
    this.passengersArrive(dt, clock)

    const traffic = this.traffic
    const net = traffic.net
    const externals: Agent[] = []
    const survivors: Bus[] = []
    for (const bus of this.buses) {
      const runs = this.runs[bus.line.info.index]
      let target: number

      if (bus.detour) {
        target = this.detourTarget(bus, net)
      } else if (clock < bus.dwellUntil) {
        target = 0
        bus.v = 0
      } else {
        this.planAhead(bus, runs)
        const run = this.runAt(runs, bus.d + HALF)
        const limit = run ? net.edgeSpeed[Mode.Bus][run.edge] || net.segCarSpeed[net.edgeSeg[run.edge]] : FREE_SPEED
        const vmax = Math.min(MAX_SPEED, limit)
        const stop = bus.stops[bus.stopIdx]
        target = vmax
        if (stop) {
          // Aim for the scheduled arrival; never crawl.
          const needed = (stop.d - bus.d) / Math.max(10, stop.arrive - clock)
          target = Math.min(vmax, Math.max(needed * 1.1, vmax * 0.6))
          target = Math.min(target, Math.sqrt(2 * DECEL * Math.max(0, stop.d - bus.d - 0.5)))
        } else target = Math.min(target, Math.sqrt(1 + 2 * DECEL * Math.max(0, bus.end - bus.d)))
        if (bus.plan) target = Math.min(target, Math.sqrt(4 + 2 * DECEL * Math.max(0, bus.plan.at - bus.d - HALF)))
        if (run) {
          const front = this.offsetIn(run, bus.d + HALF)
          const toEnd = edgeLength(net, run.edge) - front
          // Queue behind traffic ahead.
          const leader = traffic.firstAhead(run.edge, front, bus.pseudo)
          let gap = leader ? leader.offset - leader.length - front : Infinity
          if (!leader && toEnd < 40) {
            const next = this.runAt(runs, run.d1 + 1)
            if (next && next !== run) {
              const ahead = traffic.firstAhead(next.edge, -1, bus.pseudo)
              if (ahead) gap = toEnd + ahead.offset - ahead.length
            }
          }
          if (gap < Infinity) target = Math.min(target, Math.max(0, (gap - 3) / 1.5))
        }
      }

      const before = bus.v
      bus.v = target > bus.v ? Math.min(target, bus.v + ACCEL * dt) : Math.max(target, bus.v - MAX_DECEL * dt)
      bus.braking = bus.v < 0.5 || before - bus.v > 0.5 * dt

      if (bus.detour) {
        if (!this.advanceDetour(bus, net, dt)) continue
      } else {
        bus.d += bus.v * dt
        const stop = bus.stops[bus.stopIdx]
        if (stop && bus.d >= stop.d - 0.6 && bus.v < 1) {
          // At the stop: passengers get off and on, then wait for the scheduled departure.
          bus.d = Math.max(bus.d, stop.d)
          const exchanged = this.serveStop(bus)
          bus.dwellUntil = Math.max(clock + Math.min(MAX_DWELL, MIN_DWELL + exchanged * SECONDS_PER_PASSENGER), stop.depart)
          bus.stopIdx++
        }
        const plan = bus.plan
        if (plan && bus.d + HALF >= plan.at) {
          if (!plan.edges) continue // no way round: the trip ends here
          bus.detour = { edges: plan.edges, idx: 0, offset: 0, rejoin: plan.rejoin }
          bus.plan = null
        }
        if (bus.d >= bus.end - 0.5) continue
      }

      // Delay against the timetable (not while waiting for a scheduled departure).
      const stop = bus.stops[bus.stopIdx - 1]
      const scheduled = clock < bus.dwellUntil && stop ? stop.depart : this.scheduledAt(bus, bus.d)
      const t = clock < scheduled - DAY / 2 ? clock + DAY : clock
      bus.delay = Math.max(0, t - scheduled - (clock < bus.dwellUntil ? MIN_DWELL : 0))
      this.measures.busSeconds += dt
      this.measures.delaySeconds += bus.delay * dt

      // Cars queue behind moving buses (stopped buses use the bus bay).
      const occupying = this.occupiedEdge(bus, runs)
      if (occupying && clock >= bus.dwellUntil) {
        bus.pseudo.edges[0] = occupying.edge
        bus.pseudo.offset = occupying.offset
        bus.pseudo.speed = bus.v
        externals.push(bus.pseudo)
      }
      survivors.push(bus)
    }
    this.buses = survivors
    traffic.externals = externals
  }

  /** Passengers alighting and boarding at the bus's current stop; returns how many moved. */
  private serveStop(bus: Bus) {
    const remaining = bus.stops.length - bus.stopIdx - 1
    const alight = remaining <= 0 ? bus.onBoard : Math.round(bus.onBoard * Math.min(1, 1.3 / (remaining + 1)))
    bus.onBoard -= alight
    let board = 0
    const li = bus.stopLine[bus.stopIdx]
    if (remaining > 0 && li >= 0) {
      const waiting = this.waiting[bus.line.info.index]
      board = Math.floor(waiting[li])
      waiting[li] -= board
      bus.onBoard += board
    }
    return alight + board
  }

  /** One direction of a line for the route diagram. */
  private routeSide(index: number): RouteSide {
    const line = this.transit.lines[index]
    const stops = line.stopDist
    const waiting = this.waiting[index]
    const position = (d: number) => {
      if (!stops.length) return 0
      if (d < stops[0]) return -1 + d / (stops[0] || 1)
      for (let i = 0; i + 1 < stops.length; i++) {
        if (d < stops[i + 1]) return i + (d - stops[i]) / (stops[i + 1] - stops[i] || 1)
      }
      return Math.min(stops.length, stops.length - 1 + (d - stops[stops.length - 1]) / (line.length - stops[stops.length - 1] || 1))
    }
    return {
      line: index,
      stops: stops.map((_, i) => ({ name: line.stopNames[i], waiting: Math.floor(waiting[i]) })),
      buses: this.buses.filter((b) => b.line === line).map((b) => ({ id: b.id, at: position(b.d), delayMinutes: b.delay / 60 })),
    }
  }

  route(index: number): RouteDiagram {
    const back = this.reverseOf[index]
    return { forward: this.routeSide(index), back: back >= 0 ? this.routeSide(back) : null }
  }

  private occupiedEdge(bus: Bus, runs: Run[]): { edge: number; offset: number } | null {
    if (bus.detour) return { edge: bus.detour.edges[bus.detour.idx], offset: bus.detour.offset }
    const run = this.runAt(runs, bus.d + HALF)
    return run ? { edge: run.edge, offset: this.offsetIn(run, bus.d + HALF) } : null
  }

  private detourTarget(bus: Bus, net: Network) {
    const detour = bus.detour!
    const edge = detour.edges[detour.idx]
    const toEnd = edgeLength(net, edge) - detour.offset
    let target = Math.min(MAX_SPEED, net.edgeSpeed[Mode.Bus][edge] || 8.3)
    if (detour.idx + 1 < detour.edges.length) {
      // Turns on the diversion: slow for them.
      target = Math.min(target, Math.sqrt(36 + 2 * DECEL * Math.max(0, toEnd - 1)))
    }
    const leader = this.traffic.firstAhead(edge, detour.offset, bus.pseudo)
    if (leader) target = Math.min(target, Math.max(0, (leader.offset - leader.length - detour.offset - 3) / 1.5))
    return target
  }

  /** Moves along the diversion; returns false if the bus had to stop service. */
  private advanceDetour(bus: Bus, net: Network, dt: number) {
    const detour = bus.detour!
    detour.offset += bus.v * dt
    while (detour.offset >= edgeLength(net, detour.edges[detour.idx])) {
      detour.offset -= edgeLength(net, detour.edges[detour.idx])
      if (++detour.idx >= detour.edges.length) {
        // Back on the route, past the closure; stops in between are skipped.
        bus.d = detour.rejoin - HALF + detour.offset
        bus.detour = null
        while (bus.stopIdx < bus.stops.length && bus.stops[bus.stopIdx].d < bus.d) bus.stopIdx++
        return bus.d < bus.end - 0.5
      }
    }
    return true
  }

  /** Writes the buses in view (and the followed one); returns the new count. */
  writeFrame(out: Float32Array, n: number, view: { minX: number; minY: number; maxX: number; maxY: number } | null, follow: number): number {
    const max = Math.floor(out.length / AGENT_STRIDE)
    const net = this.traffic.net
    for (const bus of this.buses) {
      if (n >= max) break
      let x: number
      let y: number
      let bearing: number
      if (bus.detour) {
        const p = poseOnEdge(net, bus.detour.edges[bus.detour.idx], Math.max(0, bus.detour.offset - HALF), this.pose)
        x = p.x + p.dy * LATERAL
        y = p.y - p.dx * LATERAL
        bearing = 90 - (Math.atan2(p.dy, p.dx) * 180) / Math.PI
      } else {
        const { dx, dy } = this.transit.pointAt(bus.line, Math.min(bus.d, bus.line.length), this.point)
        const len = Math.hypot(dx, dy) || 1
        x = this.point.x + (dy / len) * LATERAL
        y = this.point.y - (dx / len) * LATERAL
        bearing = this.point.bearing
      }
      if (view && bus.id !== follow && (x < view.minX - 80 || x > view.maxX + 80 || y < view.minY - 80 || y > view.maxY + 80)) continue
      const o = n * AGENT_STRIDE
      out[o] = x
      out[o + 1] = y
      out[o + 2] = bearing
      out[o + 3] = Kind.Bus
      out[o + 4] = bus.line.info.index
      out[o + 5] = (bus.braking ? AgentFlag.Braking : 0) | (bus.delay >= 180 ? AgentFlag.Delayed : 0)
      out[o + 6] = bus.id
      n++
    }
    return n
  }

  stats() {
    let delay = 0
    let late = 0
    let detours = 0
    for (const bus of this.buses) {
      delay += bus.delay
      if (bus.delay >= 180) late++
      if (bus.detour || bus.plan?.edges) detours++
    }
    return {
      buses: this.buses.length,
      busDelayMinutes: this.buses.length ? delay / this.buses.length / 60 : null,
      busesLate: late,
      busDetours: detours,
    }
  }

  inspect(id: number): FollowInfo | null {
    const bus = this.buses.find((b) => b.id === id)
    if (!bus) return null
    const next = bus.stops[bus.stopIdx]
    const index = next ? bus.line.stopDist.reduce((best, d, i) => (Math.abs(d - next.d) < Math.abs(bus.line.stopDist[best] - next.d) ? i : best), 0) : -1
    return {
      type: 'bus',
      id,
      line: bus.line.info.index,
      speedKmh: bus.v * 3.6,
      delayMinutes: bus.delay / 60,
      nextStop: index >= 0 && Math.abs(bus.line.stopDist[index] - next!.d) < 150 ? bus.line.stopNames[index] : null,
      nextStopTime: next ? next.arrive % DAY : null,
      detour: Boolean(bus.detour || bus.plan?.edges),
      onBoard: bus.onBoard,
      route: this.route(bus.line.info.index),
    }
  }
}

import type { Road, Route, SimulationStats, Vehicle } from '../../types/simulation'
import type { RoadGraph } from './graph'
import { findRoute } from './routing'

/*
 * A deliberately simple microscopic traffic model. Every number it produces
 * is SIMULATED and must never be presented as measured traffic in Huizen.
 *
 * - Demand: a stylised weekday profile scales the number of cars on the road.
 *   Morning trips run mostly from residential streets towards through roads
 *   and the edges of town; evening trips run the other way.
 * - Routing: each car takes the fastest free-flow route (A*, see routing.ts).
 * - Movement: cars accelerate towards their preferred speed, brake for
 *   corners and their destination, and keep a time gap to the car ahead,
 *   including a car waiting on the next road.
 * - Junctions follow Dutch right of way: side roads give way to more
 *   important roads, circulating traffic on a roundabout goes first, and on
 *   equal roads traffic from the right has priority. Queues form naturally.
 */

/** Share of the peak fleet on the road at each hour (0 = midnight). Stylised, not measured. */
export const DEMAND_PROFILE = [
  0.05, 0.03, 0.02, 0.02, 0.03, 0.1, 0.35, 0.85, 1.0, 0.7, 0.55, 0.55,
  0.6, 0.55, 0.55, 0.7, 0.9, 1.0, 0.75, 0.5, 0.4, 0.3, 0.2, 0.1,
]

const DAY = 86_400
const CAR_LENGTH = 4.5
/** Bumper-to-bumper distance kept when stopped (m). */
const MIN_GAP = 2.5
/** Time gap kept to the car ahead (s). */
const HEADWAY = 1.3
const ACCELERATION = 2.0
const COMFORT_DECELERATION = 2.2
const MAX_DECELERATION = 7
/** Below this share of the speed limit, for longer than DELAY_AFTER, a car counts as delayed. */
const DELAY_SPEED_SHARE = 0.4
const DELAY_AFTER = 10
/** Cars stuck at walking pace for this long are removed, so a rare gridlock can't freeze the model. */
const STUCK_LIMIT = 180
const MIN_TRIP_METERS = 600
/** How close (m) to the junction a priority car must be for others to give way. */
const CONFLICT_DISTANCE = 35
/** Start checking right of way this far (m) before the junction. */
const YIELD_LOOKAHEAD = 40
/** Waiting longer than this (s), drivers on equal roads negotiate and go (prevents four-way deadlock). */
const EQUAL_PRIORITY_PATIENCE = 6
/** Waiting longer than this (s) for a gap on a busy main road, drivers force their way in. */
const MINOR_ROAD_PATIENCE = 45
/** Assumed average passenger-car emissions, in kg CO2 per km. A rough figure, not a measurement. */
export const CO2_KG_PER_KM = 0.15
const JOURNEY_SAMPLE = 100

export interface SimulationOptions {
  /** Cars on the road at peak demand. */
  density?: number
  /** Simulated seconds since midnight. */
  startClock?: number
  seed?: number
}

/** Small deterministic PRNG (mulberry32), so tests and runs are reproducible. */
function createRandom(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Demand share at a given time, interpolated between the hourly values. */
export function demandAt(clock: number): number {
  const hours = (((clock % DAY) + DAY) % DAY) / 3600
  const h = Math.floor(hours)
  const t = hours - h
  return DEMAND_PROFILE[h] * (1 - t) + DEMAND_PROFILE[(h + 1) % 24] * t
}

/** Safe speed for the turn from one road into the next, based on the angle between them. */
function cornerSpeed(from: Road, to: Road): number {
  let angle = Math.abs(to.startHeading - from.endHeading)
  if (angle > Math.PI) angle = 2 * Math.PI - angle
  if (angle < 0.35) return Infinity
  if (angle < 0.9) return 9
  if (angle < 1.9) return 6
  return 3
}

/** True when `other` approaches the junction from the right of a car arriving along `road`. */
function fromTheRight(road: Road, other: Road): boolean {
  // Headings are counter-clockwise from east; a car crossing from our right
  // travels about 90° counter-clockwise from our own direction.
  let diff = other.endHeading - road.endHeading
  while (diff <= -Math.PI) diff += 2 * Math.PI
  while (diff > Math.PI) diff -= 2 * Math.PI
  return diff > 0.5 && diff < 2.6
}

export interface VehiclePose {
  lng: number
  lat: number
  /** Degrees clockwise from north. */
  bearing: number
  delayed: boolean
}

export class TrafficSimulation {
  readonly graph: RoadGraph
  clock: number
  density: number
  vehicles: Vehicle[] = []

  private random: () => number
  private nextId = 1
  private spawnBudget = 0
  private closed = new Set<string>()
  private routeCache = new Map<string, Route | null>()
  private totalDistance = 0
  private completedTrips = 0
  private journeyTimes: number[] = []

  constructor(graph: RoadGraph, options: SimulationOptions = {}) {
    this.graph = graph
    this.density = options.density ?? 300
    this.clock = options.startClock ?? 7.5 * 3600
    this.random = createRandom(options.seed ?? 1)
  }

  /** Number of cars the demand profile asks for right now. */
  get targetVehicles() {
    return Math.round(this.density * demandAt(this.clock))
  }

  /** Fills the network straight away with cars part-way along their trips, so the town never starts empty. */
  populate() {
    const target = this.targetVehicles
    for (let attempts = 0; this.vehicles.length < target && attempts < target * 3; attempts++) {
      this.spawn(true)
    }
  }

  setClock(clock: number) {
    this.clock = ((clock % DAY) + DAY) % DAY
  }

  /**
   * Jump to another time of day. Cars already driving keep their elapsed trip
   * time, so the jump is not counted as travel time.
   */
  jumpTo(clock: number) {
    const before = this.clock
    this.setClock(clock)
    const delta = this.clock - before
    for (const vehicle of this.vehicles) vehicle.departedAt += delta
  }

  /** Close road segments (both directions). Affected cars are rerouted from their next junction. */
  setClosedSegments(segmentIds: Iterable<string>) {
    this.closed = new Set(segmentIds)
    this.routeCache.clear()
    this.vehicles = this.vehicles.filter((vehicle) => {
      const remaining = vehicle.route.roads.slice(vehicle.routeIndex + 1)
      if (!remaining.some((id) => this.closed.has(this.graph.roads[id].segmentId))) return true
      const current = this.graph.roads[vehicle.route.roads[vehicle.routeIndex]]
      const destination = this.graph.roads[vehicle.route.roads[vehicle.route.roads.length - 1]].to
      const detour = current.to === destination ? null : findRoute(this.graph, current.to, destination, this.closed)
      if (!detour) return false
      const roads = [current.id, ...detour.roads]
      vehicle.route = {
        roads,
        lengthMeters: roads.reduce((sum, id) => sum + this.graph.roads[id].lengthMeters, 0),
        freeFlowSeconds: vehicle.route.freeFlowSeconds,
      }
      vehicle.routeIndex = 0
      return true
    })
  }

  /** Advances the model by dt simulated seconds. Call with small steps (≤ 1 s) for stable following. */
  step(dt: number) {
    this.setClock(this.clock + dt)
    this.spawnVehicles(dt)
    this.moveVehicles(dt)
  }

  getStats(): SimulationStats {
    let speedSum = 0
    let delayed = 0
    for (const v of this.vehicles) {
      speedSum += v.speed
      if (v.slowFor > DELAY_AFTER) delayed++
    }
    const n = this.vehicles.length
    const journeys = this.journeyTimes
    return {
      clock: this.clock,
      activeVehicles: n,
      averageSpeedKmh: n ? (speedSum / n) * 3.6 : 0,
      averageJourneyMinutes: journeys.length
        ? journeys.reduce((a, b) => a + b, 0) / journeys.length / 60
        : null,
      delayedVehicles: delayed,
      totalDistanceKm: this.totalDistance / 1000,
      estimatedCo2Kg: (this.totalDistance / 1000) * CO2_KG_PER_KM,
      completedTrips: this.completedTrips,
    }
  }

  /** Current map position of a vehicle, offset to the right-hand lane on two-way roads. */
  pose(vehicle: Vehicle): VehiclePose {
    const road = this.graph.roads[vehicle.route.roads[vehicle.routeIndex]]
    const { xs, ys, cumulative } = road
    const d = Math.min(vehicle.offset, road.lengthMeters)
    // Binary search for the polyline piece containing distance d.
    let lo = 0
    let hi = cumulative.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cumulative[mid] <= d) lo = mid
      else hi = mid
    }
    const piece = cumulative[hi] - cumulative[lo] || 1
    const t = (d - cumulative[lo]) / piece
    const dx = xs[hi] - xs[lo]
    const dy = ys[hi] - ys[lo]
    let x = xs[lo] + dx * t
    let y = ys[lo] + dy * t
    if (road.twoWay) {
      // Dutch traffic keeps right: shift 1.6 m along the right-hand normal.
      const len = Math.hypot(dx, dy) || 1
      x += (dy / len) * 1.6
      y -= (dx / len) * 1.6
    }
    const [lng, lat] = this.graph.toLngLat(x, y)
    return {
      lng,
      lat,
      bearing: 90 - (Math.atan2(dy, dx) * 180) / Math.PI,
      delayed: vehicle.slowFor > DELAY_AFTER,
    }
  }

  private pick(list: number[]) {
    return list[Math.floor(this.random() * list.length)]
  }

  /** Origin and destination by time of day; see the module comment. */
  private chooseTrip(): [number, number] {
    const { zones } = this.graph
    const hour = this.clock / 3600
    const outward = () => (this.random() < 0.5 && zones.gateways.length ? this.pick(zones.gateways) : this.pick(zones.arterial))
    const r = this.random()
    if (r < 0.15 && zones.gateways.length >= 2) return [this.pick(zones.gateways), this.pick(zones.gateways)]
    const r2 = this.random()
    if (hour >= 6 && hour < 10 && r2 < 0.6) return [this.pick(zones.residential), outward()]
    if (hour >= 15 && hour < 19 && r2 < 0.6) return [outward(), this.pick(zones.residential)]
    if (r2 < 0.33) return [this.pick(zones.residential), this.pick(zones.arterial)]
    if (r2 < 0.66) return [this.pick(zones.arterial), this.pick(zones.residential)]
    return [this.pick(zones.all), this.pick(zones.all)]
  }

  private route(from: number, to: number) {
    const key = `${from}-${to}`
    if (!this.routeCache.has(key)) {
      if (this.routeCache.size > 20_000) this.routeCache.clear()
      this.routeCache.set(key, findRoute(this.graph, from, to, this.closed))
    }
    return this.routeCache.get(key) ?? null
  }

  private spawn(midTrip: boolean): boolean {
    for (let attempt = 0; attempt < 6; attempt++) {
      const [from, to] = this.chooseTrip()
      const a = this.graph.nodes[from]
      const b = this.graph.nodes[to]
      if (Math.hypot(a.x - b.x, a.y - b.y) < MIN_TRIP_METERS) continue
      const route = this.route(from, to)
      if (!route) continue

      let routeIndex = 0
      let offset = 0
      let elapsed = 0
      if (midTrip) {
        // Start somewhere along the trip, as if the car had left earlier.
        let remaining = this.random() * route.lengthMeters
        const share = remaining / route.lengthMeters
        while (remaining > this.graph.roads[route.roads[routeIndex]].lengthMeters) {
          remaining -= this.graph.roads[route.roads[routeIndex]].lengthMeters
          routeIndex++
        }
        offset = remaining
        elapsed = share * route.freeFlowSeconds
      } else if (this.vehicles.some((v) => v.route.roads[v.routeIndex] === route.roads[0] && v.offset < CAR_LENGTH * 3)) {
        continue // the entry road is occupied; try another trip
      }

      const road = this.graph.roads[route.roads[routeIndex]]
      const desiredFactor = 0.88 + this.random() * 0.17
      this.vehicles.push({
        id: this.nextId++,
        route,
        routeIndex,
        offset,
        speed: road.speedLimitMs * desiredFactor * (midTrip ? 0.9 : 0.4),
        desiredFactor,
        departedAt: this.clock - elapsed,
        slowFor: 0,
      })
      return true
    }
    return false
  }

  private spawnVehicles(dt: number) {
    const target = this.targetVehicles
    const deficit = target - this.vehicles.length
    if (deficit <= 0) {
      this.spawnBudget = 0
      return
    }
    // Refill at a rate that would restore the whole fleet in about 90 simulated seconds.
    this.spawnBudget = Math.min(this.spawnBudget + dt * Math.max(0.5, target / 90), 30)
    for (let i = 0; i < deficit && this.spawnBudget >= 1; i++) {
      this.spawnBudget--
      this.spawn(false)
    }
  }

  private mustYield(road: Road, vehicle: Vehicle, occupancy: Map<number, Vehicle[]>): boolean {
    const junction = this.graph.nodes[road.to]
    if (junction.incoming.length < 2) return false
    for (const otherId of junction.incoming) {
      if (otherId === road.id) continue
      const waiting = occupancy.get(otherId)
      if (!waiting?.length) continue
      const other = this.graph.roads[otherId]
      const car = waiting[waiting.length - 1] // closest to the junction
      // Cars standing still are themselves giving way; they don't block us.
      if (other.lengthMeters - car.offset > CONFLICT_DISTANCE || car.speed < 1.5) continue
      if (other.priority > road.priority && vehicle.slowFor < MINOR_ROAD_PATIENCE) return true
      if (
        other.priority === road.priority &&
        fromTheRight(road, other) &&
        vehicle.slowFor < EQUAL_PRIORITY_PATIENCE
      ) {
        return true
      }
    }
    return false
  }

  private moveVehicles(dt: number) {
    const { roads } = this.graph

    // Group cars per road, ordered by distance along it, to find each car's leader.
    const occupancy = new Map<number, Vehicle[]>()
    for (const v of this.vehicles) {
      const id = v.route.roads[v.routeIndex]
      const list = occupancy.get(id)
      if (list) list.push(v)
      else occupancy.set(id, [v])
    }
    for (const list of occupancy.values()) list.sort((a, b) => a.offset - b.offset)

    // 1. Choose each car's speed from the state at the start of the step.
    for (const [roadId, list] of occupancy) {
      const road = roads[roadId]
      for (let i = 0; i < list.length; i++) {
        const v = list[i]
        const isLast = v.routeIndex === v.route.roads.length - 1
        const next = isLast ? null : roads[v.route.roads[v.routeIndex + 1]]
        const toEnd = road.lengthMeters - v.offset

        let target = road.speedLimitMs * v.desiredFactor
        // Brake in time for the corner (or the destination) at the end of this road.
        const endSpeed = next ? Math.min(cornerSpeed(road, next), next.speedLimitMs * v.desiredFactor) : 2
        target = Math.min(target, Math.sqrt(endSpeed ** 2 + 2 * COMFORT_DECELERATION * Math.max(0, toEnd - 1)))

        // Give way at the junction: stop at the line while a priority car approaches.
        if (next && toEnd < YIELD_LOOKAHEAD && this.mustYield(road, v, occupancy)) {
          target = Math.min(target, Math.sqrt(2 * COMFORT_DECELERATION * Math.max(0, toEnd - 1.5)))
        }

        // Keep a safe time gap to the car ahead, on this road or waiting on the next one.
        let gap = Infinity
        if (i + 1 < list.length) gap = list[i + 1].offset - v.offset - CAR_LENGTH
        else if (next) {
          const ahead = occupancy.get(next.id)
          if (ahead?.length) gap = toEnd + ahead[0].offset - CAR_LENGTH
        }
        if (gap < Infinity) target = Math.min(target, Math.max(0, (gap - MIN_GAP) / HEADWAY))

        v.speed =
          target > v.speed
            ? Math.min(target, v.speed + ACCELERATION * dt)
            : Math.max(target, v.speed - MAX_DECELERATION * dt)

        v.slowFor = v.speed < road.speedLimitMs * DELAY_SPEED_SHARE ? v.slowFor + dt : 0
      }
    }

    // 2. Move, hand over to the next road, and retire cars that arrived or got stuck.
    const survivors: Vehicle[] = []
    for (const v of this.vehicles) {
      const travelled = v.speed * dt
      v.offset += travelled
      this.totalDistance += travelled
      let arrived = false
      while (v.offset >= roads[v.route.roads[v.routeIndex]].lengthMeters) {
        v.offset -= roads[v.route.roads[v.routeIndex]].lengthMeters
        if (++v.routeIndex >= v.route.roads.length) {
          arrived = true
          break
        }
      }
      if (arrived) {
        this.completedTrips++
        const journey = (((this.clock - v.departedAt) % DAY) + DAY) % DAY
        this.journeyTimes.push(journey)
        if (this.journeyTimes.length > JOURNEY_SAMPLE) this.journeyTimes.shift()
      } else if (v.slowFor < STUCK_LIMIT || v.speed > 0.5) {
        survivors.push(v)
      }
    }
    this.vehicles = survivors
  }
}

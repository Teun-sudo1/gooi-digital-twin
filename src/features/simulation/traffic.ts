import {
  AGENT_STRIDE,
  AgentFlag,
  Kind,
  Mode,
  type FollowInfo,
  type Viewport,
} from '../../types/simulation'
import { edgeLength, MODE_BIT, poseOnEdge, type Network, type Pose } from './network'
import { findRoute, TreeCache, type Route } from './routing'

/*
 * Street traffic: cars (five vehicle types), bicycles and pedestrians on the
 * real Gooi street network. A deliberately simple microscopic model; every
 * number it produces is SIMULATED.
 *
 * - Demand follows stylised weekday profiles per mode, scaled by a density
 *   setting. Morning car and bike trips run mostly from residential streets
 *   to destination zones (town centres, through roads, the region's edges);
 *   evening trips run back. ~18% of car trips are through traffic.
 * - Routes are the fastest free-flow paths per mode. Trips end or start in
 *   one of a few hundred zones, so cached shortest-path trees answer most
 *   routing queries without a new search.
 * - Cars accelerate to a preferred speed, brake for corners, give way under
 *   Dutch rules (priority roads, roundabouts, traffic from the right) and
 *   keep a time gap to the car ahead. Bikes follow bikes; pedestrians walk.
 * - Pedestrians are only simulated around the area being viewed, which keeps
 *   the cost proportional to what can be seen.
 * - Cars queue behind buses (which are moved by the bus fleet and passed in
 *   as `externals`).
 * - When the road network changes (a scenario edit), trips whose remaining
 *   route is no longer allowed are rerouted from the end of the street they
 *   are on, a few at a time; trips with no way left leave the network.
 */

const DAY = 86_400

// Weekday demand (share of the peak) per hour, 0 = midnight. Stylised, not measured.
export const CAR_PROFILE = [0.05, 0.03, 0.02, 0.02, 0.03, 0.1, 0.35, 0.85, 1.0, 0.7, 0.55, 0.55, 0.6, 0.55, 0.55, 0.7, 0.9, 1.0, 0.75, 0.5, 0.4, 0.3, 0.2, 0.1]
export const BIKE_PROFILE = [0.02, 0.01, 0.01, 0.01, 0.02, 0.05, 0.25, 0.95, 1.0, 0.55, 0.45, 0.5, 0.6, 0.55, 0.55, 0.8, 0.9, 0.85, 0.6, 0.45, 0.35, 0.25, 0.12, 0.05]
export const FOOT_PROFILE = [0.05, 0.03, 0.02, 0.02, 0.02, 0.05, 0.15, 0.4, 0.5, 0.6, 0.8, 0.9, 1.0, 0.95, 0.9, 0.95, 0.9, 0.85, 0.75, 0.6, 0.45, 0.3, 0.15, 0.08]

/** Bikes on the road at peak, per car at peak. Cycling is a large share of Dutch trips. */
const BIKES_PER_CAR = 0.55
/** Assumed average passenger-car emissions in kg CO2 per km. A rough figure, not a measurement. */
export const CO2_KG_PER_KM = 0.15

interface VehicleType {
  kind: Kind
  share: number
  length: number
  accel: number
  /** Absolute top speed (m/s). */
  top: number
  /** Range of preferred speed relative to the limit. */
  factor: [number, number]
  /** Colour indices (see icons.ts) with weights. */
  colours: number[]
}

// Colours: 0 white, 1 black, 2 grey, 3 silver, 4 blue, 5 red, 6 green, 7 beige.
const COMMON_COLOURS = [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 6, 7]
export const VEHICLE_TYPES: VehicleType[] = [
  { kind: Kind.Hatchback, share: 0.34, length: 3.9, accel: 2.3, top: 50, factor: [0.9, 1.06], colours: COMMON_COLOURS },
  { kind: Kind.Sedan, share: 0.3, length: 4.7, accel: 2.1, top: 55, factor: [0.9, 1.06], colours: COMMON_COLOURS },
  { kind: Kind.Suv, share: 0.2, length: 4.8, accel: 2.0, top: 55, factor: [0.9, 1.05], colours: COMMON_COLOURS },
  { kind: Kind.Van, share: 0.11, length: 5.4, accel: 1.6, top: 36, factor: [0.88, 1.0], colours: [0, 0, 0, 0, 0, 0, 2, 3, 4] },
  { kind: Kind.Truck, share: 0.05, length: 10, accel: 0.9, top: 22.2, factor: [0.85, 0.95], colours: [0, 0, 4, 5, 2] },
]

const MIN_GAP = 2.5
const HEADWAY = 1.3
const BIKE_HEADWAY = 0.7
const COMFORT_DECEL = 2.2
const MAX_DECEL = 7
const DELAY_SHARE = 0.4
const DELAY_AFTER = 10
const STUCK_LIMIT = 180
const CONFLICT_DISTANCE = 35
const YIELD_LOOKAHEAD = 40
const EQUAL_PATIENCE = 6
const MINOR_PATIENCE = 45
/** Grid size (m) for destination zones. */
const ZONE_CELL = 1100
const JOURNEY_SAMPLE = 200
const PEDESTRIAN_MIN_ZOOM = 15
const MAX_PEDESTRIANS = 450
/** Wall-clock time per step spent rerouting trips after a network change. */
const REROUTE_BUDGET_MS = 6
/** Ids in frames must stay exact as 32-bit floats; buses and trains use ids above this. */
export const ROAD_ID_LIMIT = 8_000_000

/**
 * Totals for comparing two runs of the model (the original network and a
 * scenario), restarted whenever the comparison restarts.
 */
export interface Measures {
  seconds: number
  carSeconds: number
  carKm: number
  delayedCarSeconds: number
  journeySeconds: number
  journeys: number
  /** Cars entering each street segment. */
  flow: Float32Array
}

export interface Agent {
  id: number
  kind: Kind
  mode: Mode
  colour: number
  edges: Int32Array
  idx: number
  offset: number
  speed: number
  /** Cars: preferred share of the limit. Bikes and pedestrians: preferred speed in m/s. */
  desired: number
  top: number
  accel: number
  length: number
  /** Metres to the right of the street centreline. */
  lateral: number
  /** Final junction of the trip. */
  dest: number
  /** True when `dest` is a destination zone, so a cached path tree can reroute the trip. */
  destIsZone: boolean
  /** Set when a network change made the rest of the route invalid. */
  needsRoute: boolean
  /** A vehicle moved elsewhere (a bus) that cars still queue behind. */
  external?: boolean
  departedAt: number
  slowFor: number
  braking: boolean
}

/** Deterministic PRNG (mulberry32) so runs and tests are reproducible. */
export function createRandom(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function profileAt(profile: number[], clock: number) {
  const hours = (((clock % DAY) + DAY) % DAY) / 3600
  const h = Math.floor(hours)
  const t = hours - h
  return profile[h] * (1 - t) + profile[(h + 1) % 24] * t
}

function cornerSpeed(net: Network, from: number, to: number) {
  let angle = Math.abs(net.edgeStartHeading[to] - net.edgeEndHeading[from])
  angle %= 2 * Math.PI
  if (angle > Math.PI) angle = 2 * Math.PI - angle
  if (angle < 0.35) return Infinity
  if (angle < 0.9) return 9
  if (angle < 1.9) return 6
  return 3
}

/** True when edge `other` arrives at the junction from the right of a car on `edge`. */
function fromTheRight(net: Network, edge: number, other: number) {
  let diff = net.edgeEndHeading[other] - net.edgeEndHeading[edge]
  while (diff <= -Math.PI) diff += 2 * Math.PI
  while (diff > Math.PI) diff -= 2 * Math.PI
  return diff > 0.5 && diff < 2.6
}

interface Zones {
  /** Destination zones: one well-connected junction per grid cell, plus gateways. */
  zones: number[]
  /** Junctions where through roads leave the area. */
  gateways: number[]
  /** Junctions on residential streets: typical homes. */
  homes: number[]
}

function buildZones(net: Network, mode: Mode): Zones {
  const bit = MODE_BIT[mode]
  const cells = new Map<string, { node: number; score: number }>()
  const homes: number[] = []
  const gateways: number[] = []
  const [w, s, e, n] = net.bbox
  const p = net.projection
  const minX = (w - p.lng0) * p.kx
  const maxX = (e - p.lng0) * p.kx
  const minY = (s - p.lat0) * p.ky
  const maxY = (n - p.lat0) * p.ky
  const residential = new Set(['residential', 'living_street'].map((c) => net.classes.indexOf(c)))
  const minor = new Set(['residential', 'living_street', 'service', 'footway', 'path', 'track', 'cycleway'].map((c) => net.classes.indexOf(c)))

  for (let i = 0; i < net.nodeCount; i++) {
    let out = 0
    let inc = 0
    let major = 0
    let allResidential = true
    const neighbours = new Set<number>()
    for (let k = net.outStart[i]; k < net.outStart[i + 1]; k++) {
      const edge = net.outEdges[k]
      if (!(net.edgeModes[edge] & bit)) continue
      out++
      neighbours.add(net.edgeTo[edge])
      const cls = net.segClass[net.edgeSeg[edge]]
      if (!minor.has(cls)) major++
      if (!residential.has(cls)) allResidential = false
    }
    for (let k = net.inStart[i]; k < net.inStart[i + 1]; k++) {
      const edge = net.inEdges[k]
      if (!(net.edgeModes[edge] & bit)) continue
      inc++
      neighbours.add(net.edgeFrom[edge])
    }
    if (out + inc === 0) continue
    const x = net.nodeX[i]
    const y = net.nodeY[i]
    if (out > 0 && inc > 0 && allResidential) homes.push(i)
    const nearEdge = Math.min(x - minX, maxX - x, y - minY, maxY - y) < 250
    if (nearEdge && neighbours.size === 1 && (major > 0 || mode === Mode.Bike)) gateways.push(i)
    if (out === 0 || inc === 0) continue
    const key = `${Math.floor(x / ZONE_CELL)},${Math.floor(y / ZONE_CELL)}`
    const score = out + inc + major * 3
    const best = cells.get(key)
    if (!best || score > best.score) cells.set(key, { node: i, score })
  }
  return { zones: [...[...cells.values()].map((c) => c.node), ...gateways], gateways, homes }
}

export interface TrafficOptions {
  /** Cars on the road at peak demand. Bikes scale with it. */
  density?: number
  startClock?: number
  seed?: number
  /** Path trees kept in memory per simulation. */
  treeCapacity?: number
}

export class TrafficModel {
  net: Network
  clock: number
  density: number
  agents: Agent[] = []
  viewport: Viewport | null = null
  /** Vehicles moved by other models (buses) that cars queue behind. Set before each step. */
  externals: Agent[] = []
  measures: Measures

  private random: () => number
  private nextId = 1
  private budget = [0, 0, 0, 0]
  private trees: TreeCache
  private treeCapacity: number
  private pendingReroutes = 0
  private rerouted = 0
  private stranded = 0
  private zones: [Zones, Zones]
  private footNodes: Int32Array
  private carKm = 0
  private bikeKm = 0
  private journeys: number[] = []
  private occupancy = new Map<number, Agent[]>()
  private pose: Pose = { x: 0, y: 0, dx: 0, dy: 0 }

  constructor(net: Network, options: TrafficOptions = {}) {
    this.net = net
    this.density = options.density ?? 3000
    this.clock = options.startClock ?? 8 * 3600
    this.random = createRandom(options.seed ?? 1)
    this.treeCapacity = options.treeCapacity ?? 300
    this.trees = new TreeCache(net, this.treeCapacity)
    this.zones = [buildZones(net, Mode.Car), buildZones(net, Mode.Bike)]
    const foot: number[] = []
    for (let i = 0; i < net.nodeCount; i++) {
      for (let k = net.outStart[i]; k < net.outStart[i + 1]; k++) {
        if (net.edgeModes[net.outEdges[k]] & MODE_BIT[Mode.Foot]) {
          foot.push(i)
          break
        }
      }
    }
    this.footNodes = Int32Array.from(foot)
    this.measures = this.emptyMeasures()
  }

  private emptyMeasures(): Measures {
    return { seconds: 0, carSeconds: 0, carKm: 0, delayedCarSeconds: 0, journeySeconds: 0, journeys: 0, flow: new Float32Array(this.net.segmentCount) }
  }

  resetMeasures() {
    this.measures = this.emptyMeasures()
  }

  /**
   * A copy of this model on another network, with the same trips under way,
   * for running the original network alongside a scenario.
   */
  fork(net: Network, seed: number): TrafficModel {
    const copy = new TrafficModel(net, { density: this.density, startClock: this.clock, seed, treeCapacity: this.treeCapacity })
    copy.nextId = this.nextId
    copy.agents = this.agents.filter((a) => a.mode !== Mode.Foot).map((a) => ({ ...a }))
    return copy
  }

  get zoneInfo() {
    return this.zones
  }

  target(mode: Mode) {
    if (mode === Mode.Car) return Math.round(this.density * profileAt(CAR_PROFILE, this.clock))
    if (mode === Mode.Bike) return Math.round(this.density * BIKES_PER_CAR * profileAt(BIKE_PROFILE, this.clock))
    return this.pedestrianTarget()
  }

  /**
   * Fill the network at once with trips already under way, so the region never
   * starts empty. Trips use a limited set of zones at first (bounded start-up
   * time); more zones come into use as the simulation runs.
   */
  populate(treesPerMode = 60) {
    for (const mode of [Mode.Car, Mode.Bike]) {
      const target = this.target(mode)
      this.trees.builtThisTick = 0
      let count = 0
      for (let attempts = 0; count < target && attempts < target * 3; attempts++) {
        if (this.spawn(mode, true, treesPerMode)) count++
      }
    }
  }

  /**
   * Jump to another time of day. Small jumps shift trips already under way;
   * larger ones replace the traffic with a fresh mix for the new time, so the
   * evening doesn't inherit the morning rush.
   */
  jumpTo(clock: number) {
    const before = this.clock
    this.clock = ((clock % DAY) + DAY) % DAY
    const delta = this.clock - before
    if (Math.abs(delta) > 600) {
      this.agents = this.agents.filter((a) => a.mode === Mode.Foot)
      this.budget = [0, 0, 0, 0]
      this.populate()
      return
    }
    for (const agent of this.agents) agent.departedAt += delta
  }

  /**
   * Switch to a changed street network (a scenario edit). Edge ids below
   * `staleEdgesFrom` must mean the same in both networks; agents on a later
   * edge leave, and agents whose remaining route uses one are rerouted.
   * `resetCounts` restarts the rerouted / stranded statistics.
   */
  setNetwork(net: Network, staleEdgesFrom = Infinity, resetCounts = false) {
    this.net = net
    this.trees = new TreeCache(net, this.treeCapacity)
    if (resetCounts) {
      this.rerouted = 0
      this.stranded = 0
    }
    this.pendingReroutes = 0
    const survivors: Agent[] = []
    for (const a of this.agents) {
      if (a.edges[a.idx] >= staleEdgesFrom) {
        this.stranded++
        continue
      }
      a.needsRoute = !this.routeAllowed(a, staleEdgesFrom)
      if (a.needsRoute) this.pendingReroutes++
      survivors.push(a)
    }
    this.agents = survivors
  }

  step(dt: number) {
    this.clock = (this.clock + dt) % DAY
    this.measures.seconds += dt
    this.trees.builtThisTick = 0
    if (this.pendingReroutes) this.reroutePending()
    this.spawnAll(dt)
    this.move(dt)
  }

  // -------------------------------------------------------------------------
  // Rerouting after network changes

  private routeAllowed(a: Agent, staleEdgesFrom: number) {
    const bit = MODE_BIT[a.mode]
    for (let k = a.idx + 1; k < a.edges.length; k++) {
      const e = a.edges[k]
      if (e >= staleEdgesFrom || !(this.net.edgeModes[e] & bit)) return false
    }
    return true
  }

  /** New route from the end of the agent's current street to its destination. */
  private reroute(a: Agent): boolean {
    a.needsRoute = false
    const net = this.net
    const current = a.edges[a.idx]
    const from = net.edgeTo[current]
    let route: Route | null = null
    if (from !== a.dest) {
      route =
        a.destIsZone && a.mode !== Mode.Foot
          ? this.trees.get(a.mode, a.dest, 'to').route(from)
          : findRoute(net, a.mode, from, a.dest)
      if (!route) return false
    }
    const edges = new Int32Array(1 + (route?.edges.length ?? 0))
    edges[0] = current
    if (route) edges.set(route.edges, 1)
    a.edges = edges
    a.idx = 0
    this.rerouted++
    return true
  }

  private reroutePending() {
    const started = performance.now()
    let left = 0
    const stranded = new Set<Agent>()
    for (const a of this.agents) {
      if (!a.needsRoute) continue
      if (performance.now() - started > REROUTE_BUDGET_MS) left++
      else if (!this.reroute(a)) stranded.add(a)
    }
    this.pendingReroutes = left
    if (stranded.size) {
      // No way left to the destination: the trip leaves the network.
      this.stranded += stranded.size
      this.agents = this.agents.filter((a) => !stranded.has(a))
    }
  }

  // -------------------------------------------------------------------------
  // Spawning

  private pick<T>(list: ArrayLike<T>): T {
    return list[Math.floor(this.random() * list.length)]
  }

  private chooseTrip(mode: Mode): { origin: number; zone: number; toZone: boolean } {
    const z = this.zones[mode === Mode.Car ? 0 : 1]
    const hour = this.clock / 3600
    const r = this.random()
    if (mode === Mode.Car && r < 0.18 && z.gateways.length > 1) {
      return { origin: this.pick(z.gateways), zone: this.pick(z.gateways), toZone: true }
    }
    const r2 = this.random()
    let toZone: boolean
    if (hour >= 6 && hour < 10) toZone = r2 < 0.8
    else if (hour >= 15 && hour < 19) toZone = r2 < 0.2
    else toZone = r2 < 0.5
    return { origin: this.pick(z.homes), zone: this.pick(z.zones), toZone }
  }

  private route(mode: Mode, home: number, zone: number, toZone: boolean, treeBudget: number): Route | null {
    const direction = toZone ? 'to' : 'from'
    if (!this.trees.has(mode, zone, direction) && this.trees.builtThisTick >= treeBudget) return null
    return this.trees.get(mode, zone, direction).route(home)
  }

  private spawn(mode: Mode, midTrip: boolean, treeBudget: number): boolean {
    const net = this.net
    for (let attempt = 0; attempt < 4; attempt++) {
      const trip = this.chooseTrip(mode)
      const a = trip.origin
      const b = trip.zone
      const distance = Math.hypot(net.nodeX[a] - net.nodeX[b], net.nodeY[a] - net.nodeY[b])
      if (distance < (mode === Mode.Car ? 800 : 600)) continue
      if (mode === Mode.Bike && distance > 7000) continue
      const route = this.route(mode, a, b, trip.toZone, treeBudget)
      if (!route) continue
      this.launch(mode, route, midTrip, trip.toZone)
      return true
    }
    return false
  }

  private launch(mode: Mode, route: Route, midTrip: boolean, destIsZone = false) {
    const net = this.net
    let idx = 0
    let offset = 0
    let elapsed = 0
    if (midTrip) {
      let remaining = this.random() * route.lengthMeters
      elapsed = (remaining / route.lengthMeters) * route.freeFlowSeconds
      while (idx < route.edges.length - 1 && remaining > edgeLength(net, route.edges[idx])) {
        remaining -= edgeLength(net, route.edges[idx])
        idx++
      }
      offset = remaining
    }
    const r = this.random
    let kind: Kind
    let colour: number
    let desired: number
    let top: number
    let accel: number
    let length: number
    if (mode === Mode.Car) {
      let pickShare = r()
      const type = VEHICLE_TYPES.find((t) => (pickShare -= t.share) < 0) ?? VEHICLE_TYPES[0]
      kind = type.kind
      colour = this.pick(type.colours)
      desired = type.factor[0] + r() * (type.factor[1] - type.factor[0])
      top = type.top
      accel = type.accel
      length = type.length
    } else if (mode === Mode.Bike) {
      kind = Kind.Bike
      colour = Math.floor(r() * 6)
      // A quarter ride e-bikes, which cruise faster.
      desired = r() < 0.25 ? 6 + r() * 1.2 : 4 + r() * 1.6
      top = desired
      accel = 1
      length = 1.8
    } else {
      kind = Kind.Pedestrian
      colour = Math.floor(r() * 6)
      desired = 1.1 + r() * 0.5
      top = desired
      accel = 0.8
      length = 0.6
    }
    const edge = route.edges[idx]
    this.agents.push({
      id: this.nextId++,
      kind,
      mode,
      colour,
      edges: route.edges,
      idx,
      offset,
      speed: this.cruise(mode, edge, desired, top) * (midTrip ? 0.9 : 0.3),
      desired,
      top,
      accel,
      length,
      lateral: this.lateralFor(mode, edge),
      dest: net.edgeTo[route.edges[route.edges.length - 1]],
      destIsZone,
      needsRoute: false,
      departedAt: this.clock - elapsed,
      slowFor: 0,
      braking: false,
    })
  }

  /** Preferred speed on an edge. */
  private cruise(mode: Mode, edge: number, desired: number, top: number) {
    if (mode === Mode.Car) return Math.min(top, this.net.edgeSpeed[Mode.Car][edge] * desired)
    // Bikes and pedestrians scale their own pace by the street (paths and steps are slower).
    const reference = mode === Mode.Bike ? 4.9 : 1.35
    return Math.min(top, desired * (this.net.edgeSpeed[mode][edge] / reference))
  }

  /** Where across the street an agent travels: Dutch traffic keeps right. */
  private lateralFor(mode: Mode, edge: number) {
    const net = this.net
    const modes = net.edgeModes[edge]
    const s = net.edgeSeg[edge]
    const flags = net.segFlags[s]
    const twoWayCars = (flags & 1) !== 0 && (flags & 2) !== 0
    const hasCars = (modes & MODE_BIT[Mode.Car]) !== 0 || (flags & 3) !== 0
    if (mode === Mode.Car) return twoWayCars ? 1.7 : 0
    if (mode === Mode.Bike) return hasCars ? (twoWayCars ? 3.4 : 2.2) : 0.8
    return hasCars ? 5.2 : 0.4 + this.random() * 0.9
  }

  private pedestrianTarget() {
    const view = this.viewport
    if (!view || view.zoom < PEDESTRIAN_MIN_ZOOM) return 0
    const areaKm2 = ((view.maxX - view.minX) * (view.maxY - view.minY)) / 1e6
    return Math.min(MAX_PEDESTRIANS, Math.round(areaKm2 * 900 * profileAt(FOOT_PROFILE, this.clock)))
  }

  private spawnPedestrian(midTrip: boolean) {
    const view = this.viewport
    if (!view) return
    const net = this.net
    for (let attempt = 0; attempt < 6; attempt++) {
      const x = view.minX + this.random() * (view.maxX - view.minX)
      const y = view.minY + this.random() * (view.maxY - view.minY)
      const a = this.nearestFootNode(x, y)
      const angle = this.random() * 2 * Math.PI
      const reach = 150 + this.random() * 650
      const b = this.nearestFootNode(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach)
      if (a < 0 || b < 0 || a === b) continue
      if (Math.hypot(net.nodeX[a] - net.nodeX[b], net.nodeY[a] - net.nodeY[b]) < 100) continue
      const route = findRoute(net, Mode.Foot, a, b)
      if (!route || route.lengthMeters > 2500) continue
      this.launch(Mode.Foot, route, midTrip)
      return
    }
  }

  /** Approximate nearest walkable junction (sampled; good enough for picking trip ends). */
  private nearestFootNode(x: number, y: number) {
    const nodes = this.footNodes
    let best = -1
    let bestD = 120 * 120
    // Linear scan over a stride keeps this cheap; the area being viewed is small.
    for (let k = 0; k < nodes.length; k += 3) {
      const i = nodes[k]
      const dx = this.net.nodeX[i] - x
      const dy = this.net.nodeY[i] - y
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  private spawnAll(dt: number) {
    const counts = [0, 0, 0]
    for (const a of this.agents) counts[a.mode]++
    for (const mode of [Mode.Car, Mode.Bike, Mode.Foot]) {
      const target = this.target(mode)
      const deficit = target - counts[mode]
      if (deficit <= 0) {
        this.budget[mode] = 0
        continue
      }
      // Refill at a rate that would restore the whole fleet in about 90 simulated seconds
      // (pedestrians appear faster when the view changes).
      const rate = Math.max(0.5, target / (mode === Mode.Foot ? 10 : 90))
      this.budget[mode] = Math.min(this.budget[mode] + dt * rate, mode === Mode.Foot ? 60 : 40)
      for (let i = 0; i < deficit && this.budget[mode] >= 1; i++) {
        this.budget[mode]--
        if (mode === Mode.Foot) this.spawnPedestrian(counts[Mode.Foot] === 0)
        else this.spawn(mode, false, 2)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Movement

  private mustYield(edge: number, agent: Agent): boolean {
    const net = this.net
    const junction = net.edgeTo[edge]
    const first = net.inStart[junction]
    const last = net.inStart[junction + 1]
    if (last - first < 2) return false
    for (let k = first; k < last; k++) {
      const other = net.inEdges[k]
      if (other === edge) continue
      const waiting = this.occupancy.get(other * 2)
      if (!waiting?.length) continue
      const car = waiting[waiting.length - 1]
      if (edgeLength(net, other) - car.offset > CONFLICT_DISTANCE || car.speed < 1.5) continue
      if (net.edgePriority[other] > net.edgePriority[edge] && agent.slowFor < MINOR_PATIENCE) return true
      if (net.edgePriority[other] === net.edgePriority[edge] && fromTheRight(net, edge, other) && agent.slowFor < EQUAL_PATIENCE) {
        return true
      }
    }
    return false
  }

  /** The first car (or bus) on an edge beyond `offset`, other than `self`. */
  firstAhead(edge: number, offset: number, self: Agent | null): Agent | null {
    const list = this.occupancy.get(edge * 2 + Mode.Car)
    if (!list) return null
    for (const a of list) if (a !== self && a.offset > offset) return a
    return null
  }

  private move(dt: number) {
    const net = this.net
    const occupancy = this.occupancy
    const measures = this.measures
    occupancy.clear()
    // Cars and bikes queue separately (key edge*2 + group); pedestrians pass each other freely.
    for (const a of [...this.agents, ...this.externals]) {
      if (a.mode === Mode.Foot) continue
      const key = a.edges[a.idx] * 2 + a.mode
      const list = occupancy.get(key)
      if (list) list.push(a)
      else occupancy.set(key, [a])
    }
    for (const list of occupancy.values()) if (list.length > 1) list.sort((p, q) => p.offset - q.offset)

    for (const [key, list] of occupancy) {
      const edge = key >> 1
      const isCar = (key & 1) === 0
      const length = edgeLength(net, edge)
      for (let i = 0; i < list.length; i++) {
        const a = list[i]
        if (a.external) continue
        const next = a.idx + 1 < a.edges.length ? a.edges[a.idx + 1] : -1
        const toEnd = length - a.offset
        let target = this.cruise(a.mode, edge, a.desired, a.top)

        if (isCar) {
          const endSpeed = next >= 0 ? Math.min(cornerSpeed(net, edge, next), this.cruise(Mode.Car, next, a.desired, a.top)) : 2
          target = Math.min(target, Math.sqrt(endSpeed * endSpeed + 2 * COMFORT_DECEL * Math.max(0, toEnd - 1)))
          if (next >= 0 && toEnd < YIELD_LOOKAHEAD && this.mustYield(edge, a)) {
            target = Math.min(target, Math.sqrt(2 * COMFORT_DECEL * Math.max(0, toEnd - 1.5)))
          }
        } else if (next < 0) {
          target = Math.min(target, Math.sqrt(1 + 2 * 1.5 * toEnd))
        }

        let gap = Infinity
        if (i + 1 < list.length) gap = list[i + 1].offset - a.offset - list[i + 1].length
        else if (next >= 0) {
          const ahead = occupancy.get(next * 2 + a.mode)
          if (ahead?.length) gap = toEnd + ahead[0].offset - ahead[0].length
        }
        if (gap < Infinity) {
          const minGap = isCar ? MIN_GAP : 0.8
          target = Math.min(target, Math.max(0, (gap - minGap) / (isCar ? HEADWAY : BIKE_HEADWAY)))
        }

        const before = a.speed
        a.speed = target > a.speed ? Math.min(target, a.speed + a.accel * dt) : Math.max(target, a.speed - MAX_DECEL * dt)
        a.braking = isCar && (a.speed < 0.5 || before - a.speed > 0.6 * dt)
        const limit = isCar ? net.edgeSpeed[Mode.Car][edge] : a.desired
        a.slowFor = a.speed < limit * DELAY_SHARE ? a.slowFor + dt : 0
      }
    }

    // Pedestrians: walk at their pace; leave when far outside the view.
    const view = this.viewport
    const survivors: Agent[] = []
    for (const a of this.agents) {
      if (a.mode === Mode.Foot) {
        a.speed = this.cruise(Mode.Foot, a.edges[a.idx], a.desired, a.top)
        if (!view || view.zoom < PEDESTRIAN_MIN_ZOOM - 0.5) continue
      }
      const travelled = a.speed * dt
      a.offset += travelled
      if (a.mode === Mode.Car) {
        this.carKm += travelled / 1000
        measures.carKm += travelled / 1000
        measures.carSeconds += dt
        if (a.slowFor > DELAY_AFTER) measures.delayedCarSeconds += dt
      } else if (a.mode === Mode.Bike) this.bikeKm += travelled / 1000
      let arrived = false
      while (!arrived && a.offset >= edgeLength(net, a.edges[a.idx])) {
        // Reaching the end of a street before the queued reroute: decide now.
        if (a.needsRoute && a.idx + 1 < a.edges.length) {
          this.pendingReroutes--
          if (!this.reroute(a)) {
            this.stranded++
            arrived = true
            break
          }
        }
        a.offset -= edgeLength(net, a.edges[a.idx])
        if (++a.idx >= a.edges.length) {
          arrived = true
          break
        }
        a.lateral = this.lateralFor(a.mode, a.edges[a.idx])
        if (a.mode === Mode.Car) {
          const s = net.edgeSeg[a.edges[a.idx]]
          if (s < measures.flow.length) measures.flow[s]++
        }
      }
      if (arrived) {
        if (a.mode === Mode.Car && a.idx >= a.edges.length) {
          const journey = (((this.clock - a.departedAt) % DAY) + DAY) % DAY
          this.journeys.push(journey)
          if (this.journeys.length > JOURNEY_SAMPLE) this.journeys.shift()
          measures.journeySeconds += journey
          measures.journeys++
        }
        continue
      }
      if (a.slowFor > STUCK_LIMIT && a.speed < 0.5) continue
      if (a.mode === Mode.Foot && view && !this.inView(a, view, 400)) continue
      survivors.push(a)
    }
    this.agents = survivors
  }

  private inView(a: Agent, v: Viewport, margin: number) {
    const e = a.edges[a.idx]
    const x = this.net.nodeX[this.net.edgeFrom[e]]
    const y = this.net.nodeY[this.net.edgeFrom[e]]
    return x > v.minX - margin && x < v.maxX + margin && y > v.minY - margin && y < v.maxY + margin
  }

  // -------------------------------------------------------------------------
  // Output

  /**
   * Writes visible agents into `out` (AGENT_STRIDE floats each: x, y,
   * bearing, kind, colour, flags, id) and returns how many were written.
   * `follow` is always written when present, wherever it is.
   */
  writeFrame(out: Float32Array, view: Viewport | null, follow = -1): number {
    const p = this.pose
    const margin = 60
    let n = 0
    const max = Math.floor(out.length / AGENT_STRIDE)
    for (const a of this.agents) {
      if (n >= max) break
      poseOnEdge(this.net, a.edges[a.idx], a.offset, p)
      // Shift to the right of the direction of travel.
      const x = p.x + p.dy * a.lateral
      const y = p.y - p.dx * a.lateral
      const id = a.id % ROAD_ID_LIMIT
      if (view && id !== follow && (x < view.minX - margin || x > view.maxX + margin || y < view.minY - margin || y > view.maxY + margin)) continue
      const o = n * AGENT_STRIDE
      out[o] = x
      out[o + 1] = y
      out[o + 2] = 90 - (Math.atan2(p.dy, p.dx) * 180) / Math.PI
      out[o + 3] = a.kind
      out[o + 4] = a.colour
      out[o + 5] = (a.braking ? AgentFlag.Braking : 0) | (a.slowFor > DELAY_AFTER ? AgentFlag.Delayed : 0)
      out[o + 6] = id
      n++
    }
    return n
  }

  /** Details of one car, bike or pedestrian for the follow card, or null when it has gone. */
  inspect(id: number): FollowInfo | null {
    const a = this.agents.find((agent) => agent.id % ROAD_ID_LIMIT === id)
    if (!a) return null
    const net = this.net
    let remaining = -a.offset
    for (let k = a.idx; k < a.edges.length; k++) remaining += edgeLength(net, a.edges[k])
    // The destination is the last named street on the route.
    let destination: string | null = null
    for (let k = a.edges.length - 1; k >= a.idx && destination === null; k--) {
      const name = net.segName[net.edgeSeg[a.edges[k]]]
      if (name >= 0) destination = net.names[name]
    }
    const edge = a.edges[a.idx]
    return {
      type: 'road',
      id,
      vehicle: a.kind,
      speedKmh: a.speed * 3.6,
      destination,
      remainingKm: Math.max(0, remaining) / 1000,
      tripMinutes: ((((this.clock - a.departedAt) % DAY) + DAY) % DAY) / 60,
      delayed: a.slowFor > DELAY_AFTER,
      street: net.segName[net.edgeSeg[edge]] >= 0 ? net.names[net.segName[net.edgeSeg[edge]]] : null,
    }
  }

  stats() {
    let cars = 0
    let bikes = 0
    let pedestrians = 0
    let carSpeed = 0
    let bikeSpeed = 0
    let delayed = 0
    for (const a of this.agents) {
      if (a.mode === Mode.Car) {
        cars++
        carSpeed += a.speed
        if (a.slowFor > DELAY_AFTER) delayed++
      } else if (a.mode === Mode.Bike) {
        bikes++
        bikeSpeed += a.speed
      } else pedestrians++
    }
    const journeys = this.journeys
    return {
      clock: this.clock,
      cars,
      bikes,
      pedestrians,
      averageCarSpeedKmh: cars ? (carSpeed / cars) * 3.6 : 0,
      averageBikeSpeedKmh: bikes ? (bikeSpeed / bikes) * 3.6 : 0,
      averageCarJourneyMinutes: journeys.length ? journeys.reduce((s, j) => s + j, 0) / journeys.length / 60 : null,
      delayedCars: delayed,
      carKilometres: this.carKm,
      bikeKilometres: this.bikeKm,
      estimatedCo2Kg: this.carKm * CO2_KG_PER_KM,
      reroutedTrips: this.rerouted,
      strandedTrips: this.stranded,
    }
  }
}

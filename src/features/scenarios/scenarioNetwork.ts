import {
  Mode,
  SegmentFlag,
  type Intervention,
  type JunctionInfo,
  type NetworkFile,
  type NewRoadType,
  type RoadAccess,
  type SegmentInfo,
} from '../../types/simulation'
import { buildNetwork, fromLngLat, MODE_BIT, toLngLat, type Network } from '../simulation/network'

/*
 * Applies a scenario (road edits on the map) to the street network. The
 * network is rebuilt from the original file each time, so restoring the
 * baseline is simply an empty scenario. New roads are appended after the
 * original segments, which keeps every original segment and edge id
 * stable: agents already on the road keep valid routes.
 */

const MODES = [Mode.Car, Mode.Bike, Mode.Foot, Mode.Bus] as const
const ALL_MODES = MODE_BIT[Mode.Car] | MODE_BIT[Mode.Bike] | MODE_BIT[Mode.Foot] | MODE_BIT[Mode.Bus]

/** Modes still allowed on a street after an access edit (intersected with what was allowed before). */
export const ACCESS_MODES: Record<RoadAccess, number> = {
  closed: 0,
  removed: 0,
  'no-cars': MODE_BIT[Mode.Bike] | MODE_BIT[Mode.Foot],
  'foot-only': MODE_BIT[Mode.Foot],
  // Buses keep the street; the pavement stays open.
  'bus-only': MODE_BIT[Mode.Bus] | MODE_BIT[Mode.Foot],
}

export const SPEED_LIMIT_RANGE = [5, 130] as const
const MAX_ROAD_POINTS = 2000
export const MAX_NEW_LANES = 3

/** What each kind of new road is called, and who may use it (SegmentFlag bits; cars both ways unless one-way). */
export const NEW_ROAD: Record<NewRoadType, { name: string; bikes: boolean; foot: boolean; cars: boolean }> = {
  cycleway: { name: 'New cycle path', bikes: true, foot: true, cars: false },
  residential: { name: 'New street', bikes: true, foot: true, cars: true },
  tertiary: { name: 'New through road', bikes: true, foot: true, cars: true },
  primary: { name: 'New main road', bikes: false, foot: false, cars: true },
}

/** Drops anything malformed, so a bad message can never corrupt the network. */
export function validInterventions(file: NetworkFile, list: unknown): Intervention[] {
  if (!Array.isArray(list)) return []
  const segments = file.segments.from.length
  const nodes = file.nodes.length / 2
  const isIndex = (v: unknown, n: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < n
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  return list.filter((item: Intervention) => {
    if (!item || typeof item !== 'object') return false
    switch (item.kind) {
      case 'access':
        return isIndex(item.segment, segments) && item.access in ACCESS_MODES
      case 'speed':
        return isIndex(item.segment, segments) && finite(item.kmh) && item.kmh >= SPEED_LIMIT_RANGE[0] && item.kmh <= SPEED_LIMIT_RANGE[1]
      case 'new-road':
        return (
          typeof item.id === 'string' &&
          item.road in NEW_ROAD &&
          isIndex(item.from, nodes) &&
          isIndex(item.to, nodes) &&
          item.from !== item.to &&
          Array.isArray(item.points) &&
          item.points.length <= MAX_ROAD_POINTS &&
          item.points.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1])) &&
          Number.isInteger(item.lanes) &&
          item.lanes >= 1 &&
          item.lanes <= MAX_NEW_LANES &&
          typeof item.oneway === 'boolean' &&
          (item.road === 'cycleway' || (finite(item.kmh) && item.kmh >= SPEED_LIMIT_RANGE[0] && item.kmh <= SPEED_LIMIT_RANGE[1]))
        )
      default:
        return false
    }
  })
}

/** The network file plus new roads as extra segments. */
function withNewRoads(file: NetworkFile, roads: NewRoad[]): NetworkFile {
  if (!roads.length) return file
  const { projection } = file.meta
  const classes = [...file.classes]
  for (const road of roads) if (!classes.includes(road.road)) classes.push(road.road)
  const names = [...file.names]
  const nameOf = (road: NewRoad) => {
    const name = NEW_ROAD[road.road].name
    if (!names.includes(name)) names.push(name)
    return names.indexOf(name)
  }
  const seg = file.segments
  const geom = roads.map((road) => {
    // Interior points, delta-encoded from the from-node in file units.
    let px = file.nodes[2 * road.from]
    let py = file.nodes[2 * road.from + 1]
    const out: number[] = []
    for (const [lng, lat] of road.points) {
      const [x, y] = fromLngLat(projection, lng, lat)
      const ix = Math.round(x / projection.unit)
      const iy = Math.round(y / projection.unit)
      out.push(ix - px, iy - py)
      px = ix
      py = iy
    }
    return out
  })
  const flagsOf = (road: NewRoad) => {
    const use = NEW_ROAD[road.road]
    let flags = 0
    if (use.bikes) flags |= SegmentFlag.BikeForward | SegmentFlag.BikeBackward
    if (use.foot) flags |= SegmentFlag.Foot
    if (use.cars) flags |= SegmentFlag.CarForward | (road.oneway ? 0 : SegmentFlag.CarBackward)
    return flags
  }
  return {
    ...file,
    classes,
    names,
    segments: {
      from: [...seg.from, ...roads.map((r) => r.from)],
      to: [...seg.to, ...roads.map((r) => r.to)],
      cls: [...seg.cls, ...roads.map((r) => classes.indexOf(r.road))],
      name: [...seg.name, ...roads.map(nameOf)],
      speed: [...seg.speed, ...roads.map((r) => (NEW_ROAD[r.road].cars ? r.kmh : 0))],
      flags: [...seg.flags, ...roads.map(flagsOf)],
      way: [...seg.way, ...roads.map(() => -1)],
      geom: [...seg.geom, ...geom],
    },
  }
}

type NewRoad = Extract<Intervention, { kind: 'new-road' }>

export interface ScenarioNetwork {
  net: Network
  /** Segments of the original file; later segments are new roads. */
  baseSegments: number
  baseEdges: number
  /** Road id for each appended segment. */
  roadIds: string[]
  /** Lanes per direction of each appended segment. */
  newLanes: number[]
  /** Segments removed completely (not drawn, no traffic). */
  removed: Set<number>
}

export function buildScenarioNetwork(file: NetworkFile, interventions: Intervention[]): ScenarioNetwork {
  const roads = interventions.filter((i) => i.kind === 'new-road')
  const net = buildNetwork(withNewRoads(file, roads))
  const baseSegments = file.segments.from.length
  let baseEdges = net.edgeCount
  while (baseEdges > 0 && net.edgeSeg[baseEdges - 1] >= baseSegments) baseEdges--

  const access = new Map<number, number>()
  const speed = new Map<number, number>()
  const removed = new Set<number>()
  for (const i of interventions) {
    if (i.kind === 'access') access.set(i.segment, ACCESS_MODES[i.access])
    else if (i.kind === 'speed') speed.set(i.segment, i.kmh / 3.6)
    if (i.kind === 'access' && i.access === 'removed') removed.add(i.segment)
  }
  if (access.size || speed.size) {
    for (let e = 0; e < net.edgeCount; e++) {
      const s = net.edgeSeg[e]
      const allowed = access.get(s) ?? ALL_MODES
      net.edgeModes[e] &= allowed
      for (const m of MODES) if (!(net.edgeModes[e] & MODE_BIT[m])) net.edgeSpeed[m][e] = 0
      const limit = speed.get(s)
      if (limit !== undefined) {
        for (const m of [Mode.Car, Mode.Bus]) if (net.edgeModes[e] & MODE_BIT[m]) net.edgeSpeed[m][e] = limit
      }
    }
    // Keep the A* heuristic admissible when a limit was raised.
    for (const m of MODES) {
      let max = 1
      for (let e = 0; e < net.edgeCount; e++) max = Math.max(max, net.edgeSpeed[m][e])
      net.maxSpeed[m] = max
    }
  }
  return { net, baseSegments, baseEdges, roadIds: roads.map((r) => r.id), newLanes: roads.map((r) => r.lanes), removed }
}

// ---------------------------------------------------------------------------
// Picking

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

/**
 * The street nearest to a point (within `radius` metres) whose original
 * permissions match `mask` (SegmentFlag bits). Uses the original flags, so a
 * closed street can still be picked to reopen it.
 */
export function pickSegment(scenario: ScenarioNetwork, lng: number, lat: number, radius: number, mask: number): SegmentInfo | null {
  const { net } = scenario
  const [x, y] = fromLngLat(net.projection, lng, lat)
  let best = -1
  let bestD = radius
  for (let s = 0; s < net.segmentCount; s++) {
    if (!(net.segFlags[s] & mask)) continue
    const a = net.geomStart[s]
    const b = net.geomStart[s + 1]
    for (let k = a + 1; k < b; k++) {
      // Cheap rejection before the exact distance.
      if (Math.min(net.geomX[k], net.geomX[k - 1]) - bestD > x || Math.max(net.geomX[k], net.geomX[k - 1]) + bestD < x) continue
      if (Math.min(net.geomY[k], net.geomY[k - 1]) - bestD > y || Math.max(net.geomY[k], net.geomY[k - 1]) + bestD < y) continue
      const d = distanceToSegment(x, y, net.geomX[k - 1], net.geomY[k - 1], net.geomX[k], net.geomY[k])
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
  }
  if (best < 0) return null
  const coordinates: [number, number][] = []
  for (let k = net.geomStart[best]; k < net.geomStart[best + 1]; k++) {
    coordinates.push(toLngLat(net.projection, net.geomX[k], net.geomY[k]))
  }
  const flags = net.segFlags[best]
  const name = net.segName[best]
  return {
    segment: best,
    roadId: best >= scenario.baseSegments ? scenario.roadIds[best - scenario.baseSegments] : null,
    name: name >= 0 ? net.names[name] : null,
    roadClass: net.classes[net.segClass[best]],
    coordinates,
    car: (flags & (SegmentFlag.CarForward | SegmentFlag.CarBackward)) !== 0,
    bike: (flags & (SegmentFlag.BikeForward | SegmentFlag.BikeBackward)) !== 0,
    foot: (flags & SegmentFlag.Foot) !== 0,
    speedKmh: Math.round(net.segCarSpeed[best] * 3.6),
  }
}

/** The nearest junction (within `radius` metres) of streets someone can currently use. */
export function nearestJunction(scenario: ScenarioNetwork, lng: number, lat: number, radius: number): JunctionInfo | null {
  const { net } = scenario
  const [x, y] = fromLngLat(net.projection, lng, lat)
  const bit = ALL_MODES
  let best = -1
  let bestD = radius
  for (let i = 0; i < net.nodeCount; i++) {
    const d = Math.hypot(net.nodeX[i] - x, net.nodeY[i] - y)
    if (d >= bestD) continue
    let reachable = false
    for (let k = net.outStart[i]; k < net.outStart[i + 1] && !reachable; k++) reachable = (net.edgeModes[net.outEdges[k]] & bit) !== 0
    if (!reachable) continue
    bestD = d
    best = i
  }
  return best < 0 ? null : { node: best, coordinates: toLngLat(net.projection, net.nodeX[best], net.nodeY[best]) }
}

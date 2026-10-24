import {
  Mode,
  SegmentFlag,
  type Intervention,
  type JunctionInfo,
  type NetworkFile,
  type RoadAccess,
  type SegmentInfo,
} from '../../types/simulation'
import { buildNetwork, fromLngLat, MODE_BIT, toLngLat, type Network } from '../simulation/network'

/*
 * Applies a scenario (road edits on the map) to the street network. The
 * network is rebuilt from the original file each time, so restoring the
 * baseline is simply an empty scenario. New cycle paths are appended after
 * the original segments, which keeps every original segment and edge id
 * stable: agents already on the road keep valid routes.
 */

const ALL_MODES = MODE_BIT[Mode.Car] | MODE_BIT[Mode.Bike] | MODE_BIT[Mode.Foot]

/** Modes still allowed on a street after an access edit (intersected with what was allowed before). */
export const ACCESS_MODES: Record<RoadAccess, number> = {
  closed: 0,
  'no-cars': MODE_BIT[Mode.Bike] | MODE_BIT[Mode.Foot],
  'foot-only': MODE_BIT[Mode.Foot],
  // Buses follow their timetable on their own; the pavement stays open.
  'bus-only': MODE_BIT[Mode.Foot],
}

export const SPEED_LIMIT_RANGE = [5, 130] as const
const MAX_PATH_POINTS = 500
const CYCLE_PATH_NAME = 'New cycle path'

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
      case 'cycle-path':
        return (
          typeof item.id === 'string' &&
          isIndex(item.from, nodes) &&
          isIndex(item.to, nodes) &&
          item.from !== item.to &&
          Array.isArray(item.points) &&
          item.points.length <= MAX_PATH_POINTS &&
          item.points.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]))
        )
      default:
        return false
    }
  })
}

/** The network file plus new cycle paths as extra segments. */
function withCyclePaths(file: NetworkFile, paths: Extract<Intervention, { kind: 'cycle-path' }>[]): NetworkFile {
  if (!paths.length) return file
  const { projection } = file.meta
  const classes = file.classes.includes('cycleway') ? file.classes : [...file.classes, 'cycleway']
  const names = [...file.names, CYCLE_PATH_NAME]
  const cls = classes.indexOf('cycleway')
  const name = names.length - 1
  const seg = file.segments
  const geom = paths.map((path) => {
    // Interior points, delta-encoded from the from-node in file units.
    let px = file.nodes[2 * path.from]
    let py = file.nodes[2 * path.from + 1]
    const out: number[] = []
    for (const [lng, lat] of path.points) {
      const [x, y] = fromLngLat(projection, lng, lat)
      const ix = Math.round(x / projection.unit)
      const iy = Math.round(y / projection.unit)
      out.push(ix - px, iy - py)
      px = ix
      py = iy
    }
    return out
  })
  const flags = SegmentFlag.BikeForward | SegmentFlag.BikeBackward | SegmentFlag.Foot
  return {
    ...file,
    classes,
    names,
    segments: {
      from: [...seg.from, ...paths.map((p) => p.from)],
      to: [...seg.to, ...paths.map((p) => p.to)],
      cls: [...seg.cls, ...paths.map(() => cls)],
      name: [...seg.name, ...paths.map(() => name)],
      speed: [...seg.speed, ...paths.map(() => 0)],
      flags: [...seg.flags, ...paths.map(() => flags)],
      way: [...seg.way, ...paths.map(() => -1)],
      geom: [...seg.geom, ...geom],
    },
  }
}

export interface ScenarioNetwork {
  net: Network
  /** Segments of the original file; later segments are new cycle paths. */
  baseSegments: number
  baseEdges: number
  /** Cycle path id for each appended segment. */
  pathIds: string[]
}

export function buildScenarioNetwork(file: NetworkFile, interventions: Intervention[]): ScenarioNetwork {
  const paths = interventions.filter((i) => i.kind === 'cycle-path')
  const net = buildNetwork(withCyclePaths(file, paths))
  const baseSegments = file.segments.from.length
  let baseEdges = net.edgeCount
  while (baseEdges > 0 && net.edgeSeg[baseEdges - 1] >= baseSegments) baseEdges--

  const access = new Map<number, number>()
  const speed = new Map<number, number>()
  for (const i of interventions) {
    if (i.kind === 'access') access.set(i.segment, ACCESS_MODES[i.access])
    else if (i.kind === 'speed') speed.set(i.segment, i.kmh / 3.6)
  }
  if (access.size || speed.size) {
    for (let e = 0; e < net.edgeCount; e++) {
      const s = net.edgeSeg[e]
      const allowed = access.get(s) ?? ALL_MODES
      net.edgeModes[e] &= allowed
      for (const m of [Mode.Car, Mode.Bike, Mode.Foot]) if (!(net.edgeModes[e] & MODE_BIT[m])) net.edgeSpeed[m][e] = 0
      const limit = speed.get(s)
      if (limit !== undefined && net.edgeModes[e] & MODE_BIT[Mode.Car]) net.edgeSpeed[Mode.Car][e] = limit
    }
    // Keep the A* heuristic admissible when a limit was raised.
    for (const m of [Mode.Car, Mode.Bike, Mode.Foot]) {
      let max = 1
      for (let e = 0; e < net.edgeCount; e++) max = Math.max(max, net.edgeSpeed[m][e])
      net.maxSpeed[m] = max
    }
  }
  return { net, baseSegments, baseEdges, pathIds: paths.map((p) => p.id) }
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
    pathId: best >= scenario.baseSegments ? scenario.pathIds[best - scenario.baseSegments] : null,
    name: name >= 0 ? net.names[name] : null,
    roadClass: net.classes[net.segClass[best]],
    coordinates,
    car: (flags & (SegmentFlag.CarForward | SegmentFlag.CarBackward)) !== 0,
    bike: (flags & (SegmentFlag.BikeForward | SegmentFlag.BikeBackward)) !== 0,
    foot: (flags & SegmentFlag.Foot) !== 0,
    speedKmh: Math.round(net.segCarSpeed[best] * 3.6),
  }
}

/** The nearest junction (within `radius` metres) that cyclists can currently reach. */
export function nearestJunction(scenario: ScenarioNetwork, lng: number, lat: number, radius: number): JunctionInfo | null {
  const { net } = scenario
  const [x, y] = fromLngLat(net.projection, lng, lat)
  const bit = MODE_BIT[Mode.Bike]
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

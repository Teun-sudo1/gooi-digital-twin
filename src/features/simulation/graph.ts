import type { LngLat } from '../../types/geo'
import type {
  Intersection,
  Road,
  RoadClass,
  RoadNetworkFile,
  RoadSegmentRecord,
} from '../../types/simulation'

const ARTERIAL: ReadonlySet<RoadClass> = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
])
const RESIDENTIAL: ReadonlySet<RoadClass> = new Set(['residential', 'living_street'])

/** Right-of-way rank by road class. Roundabouts outrank everything (circulating traffic goes first). */
const PRIORITY: Record<RoadClass, number> = {
  motorway: 6, motorway_link: 6, trunk: 5, trunk_link: 5, primary: 4, primary_link: 4,
  secondary: 3, secondary_link: 3, tertiary: 2, tertiary_link: 2, unclassified: 1,
  residential: 0, living_street: -1,
}
const ROUNDABOUT_PRIORITY = 10

/** Dead ends of through roads within this distance of the data boundary become entry/exit points. */
const GATEWAY_EDGE_DISTANCE = 350

export interface RoadGraph {
  nodes: Intersection[]
  roads: Road[]
  segments: Map<string, RoadSegmentRecord>
  /** Directed road ids per segment id (one or two). */
  roadsBySegment: Map<string, number[]>
  maxSpeedMs: number
  /** Candidate trip ends, grouped so demand can differ by time of day. */
  zones: {
    all: number[]
    residential: number[]
    arterial: number[]
    /** Where through roads leave the modelled area: traffic enters and exits here. */
    gateways: number[]
  }
  toLngLat(x: number, y: number): LngLat
}

/**
 * Turns the stored segment list into a directed graph in a local metric
 * projection. Over an area the size of Huizen (~5 km), a flat
 * equirectangular projection around the centre is accurate to centimetres,
 * and makes per-frame interpolation simple arithmetic instead of geodesy.
 */
export function buildRoadGraph(file: RoadNetworkFile): RoadGraph {
  const [west, south, east, north] = file.meta.bbox
  const lng0 = (west + east) / 2
  const lat0 = (south + north) / 2
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180)
  const ky = 110_574
  const project = ([lng, lat]: LngLat): [number, number] => [(lng - lng0) * kx, (lat - lat0) * ky]
  const toLngLat = (x: number, y: number): LngLat => [lng0 + x / kx, lat0 + y / ky]

  const nodes: Intersection[] = file.nodes.map((position, id) => {
    const [x, y] = project(position)
    return { id, position, x, y, outgoing: [], incoming: [] }
  })

  const roads: Road[] = []
  const roadsBySegment = new Map<string, number[]>()
  const segments = new Map<string, RoadSegmentRecord>()
  let maxSpeedMs = 1

  const addRoad = (segment: RoadSegmentRecord, coords: LngLat[], from: number, to: number) => {
    const n = coords.length
    const xs = new Float64Array(n)
    const ys = new Float64Array(n)
    const cumulative = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      ;[xs[i], ys[i]] = project(coords[i])
      if (i > 0) cumulative[i] = cumulative[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
    }
    const speedLimitMs = segment.speed / 3.6
    maxSpeedMs = Math.max(maxSpeedMs, speedLimitMs)
    const road: Road = {
      id: roads.length,
      segmentId: segment.id,
      name: segment.name,
      roadClass: segment.class,
      from,
      to,
      xs,
      ys,
      cumulative,
      lengthMeters: cumulative[n - 1],
      speedLimitMs,
      twoWay: !segment.oneway,
      priority: segment.roundabout ? ROUNDABOUT_PRIORITY : PRIORITY[segment.class],
      startHeading: Math.atan2(ys[1] - ys[0], xs[1] - xs[0]),
      endHeading: Math.atan2(ys[n - 1] - ys[n - 2], xs[n - 1] - xs[n - 2]),
    }
    roads.push(road)
    nodes[from].outgoing.push(road.id)
    nodes[to].incoming.push(road.id)
    const list = roadsBySegment.get(segment.id) ?? []
    list.push(road.id)
    roadsBySegment.set(segment.id, list)
  }

  for (const segment of file.segments) {
    segments.set(segment.id, segment)
    addRoad(segment, segment.coords, segment.from, segment.to)
    if (!segment.oneway) addRoad(segment, [...segment.coords].reverse(), segment.to, segment.from)
  }

  // Classify junctions for origin/destination choice.
  const [minX, minY] = project([west, south])
  const [maxX, maxY] = project([east, north])
  const zones: RoadGraph['zones'] = { all: [], residential: [], arterial: [], gateways: [] }
  for (const node of nodes) {
    const incident = [...node.outgoing, ...node.incoming].map((id) => roads[id])
    if (incident.length === 0) continue
    zones.all.push(node.id)
    if (incident.some((r) => ARTERIAL.has(r.roadClass))) zones.arterial.push(node.id)
    else if (incident.every((r) => RESIDENTIAL.has(r.roadClass))) zones.residential.push(node.id)

    const neighbours = new Set(incident.map((r) => (r.from === node.id ? r.to : r.from)))
    const nearEdge =
      Math.min(node.x - minX, maxX - node.x, node.y - minY, maxY - node.y) < GATEWAY_EDGE_DISTANCE
    const throughRoad = incident.some((r) => !RESIDENTIAL.has(r.roadClass))
    if (neighbours.size === 1 && nearEdge && throughRoad) zones.gateways.push(node.id)
  }

  return { nodes, roads, segments, roadsBySegment, maxSpeedMs, zones, toLngLat }
}

let networkRequest: Promise<RoadNetworkFile> | null = null

/** Downloads the road network once per page load; later calls share the same request. */
export function loadRoadNetwork(): Promise<RoadNetworkFile> {
  networkRequest ??= fetch(`${import.meta.env.BASE_URL}data/huizen-roads.json`).then((response) => {
    if (!response.ok) throw new Error(`Road network download failed (${response.status})`)
    return response.json() as Promise<RoadNetworkFile>
  })
  networkRequest.catch(() => {
    networkRequest = null
  })
  return networkRequest
}

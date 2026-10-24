import { Mode, SegmentFlag, type NetworkFile, type Projection } from '../../types/simulation'

/** Bits in Network.edgeModes, indexed by Mode. */
export const MODE_BIT = [1, 2, 4, 8] as const

/** Right-of-way rank for cars arriving at a junction; higher goes first. */
const PRIORITY: Record<string, number> = {
  motorway: 6, motorway_link: 6, trunk: 5, trunk_link: 5, primary: 4, primary_link: 4,
  secondary: 3, secondary_link: 3, tertiary: 2, tertiary_link: 2, unclassified: 1,
  residential: 0, living_street: -1,
}
const ROUNDABOUT_PRIORITY = 10

/** Cycling speeds (m/s) by street type; riders vary around these. */
const BIKE_SPEED: Record<string, number> = {
  cycleway: 5.2, residential: 4.7, living_street: 4.2, unclassified: 4.9, tertiary: 4.9,
  tertiary_link: 4.9, secondary: 4.9, secondary_link: 4.9, primary: 4.9, primary_link: 4.9,
  service: 4.4, track: 3.8, path: 3.8, footway: 3.4, pedestrian: 3.2, bridleway: 3.6,
}
const WALK_SPEED = 1.35
const STEPS_SPEED = 0.6

/**
 * The street network as flat typed arrays, in local metres. A segment is a
 * stretch of street between two junctions. Each direction a segment can be
 * travelled in becomes a directed edge carrying a bitmask of the modes
 * allowed on it. Typed arrays keep tens of thousands of edges compact and
 * fast to route over.
 */
export interface Network {
  projection: Projection
  bbox: [number, number, number, number]
  classes: string[]
  names: string[]

  nodeCount: number
  nodeX: Float64Array
  nodeY: Float64Array

  segmentCount: number
  segClass: Uint8Array
  segName: Int32Array
  segWay: Float64Array
  segFlags: Uint8Array
  segLength: Float64Array
  /** Car speed limit (m/s), 0 when cars are not allowed. */
  segCarSpeed: Float32Array
  /** Geometry: segment s uses points geomStart[s] … geomStart[s + 1] - 1. */
  geomStart: Int32Array
  geomX: Float64Array
  geomY: Float64Array
  /** Distance from the segment start at each point. */
  geomDist: Float64Array

  edgeCount: number
  edgeSeg: Int32Array
  /** 1 when the edge runs against the segment's stored direction. */
  edgeRev: Uint8Array
  edgeFrom: Int32Array
  edgeTo: Int32Array
  edgeModes: Uint8Array
  edgePriority: Int8Array
  /** Heading (radians, counter-clockwise from east) when leaving / arriving. */
  edgeStartHeading: Float32Array
  edgeEndHeading: Float32Array
  /** Per-mode travel speed on each edge (m/s); 0 when the mode is not allowed. */
  edgeSpeed: [Float32Array, Float32Array, Float32Array, Float32Array]

  /** Outgoing / incoming edges per node in compressed (CSR) form. */
  outStart: Int32Array
  outEdges: Int32Array
  inStart: Int32Array
  inEdges: Int32Array

  maxSpeed: [number, number, number, number]

  /** Traffic-light controller per node (index into `signals`), or -1. */
  nodeSignal: Int32Array
  signals: number[][]
}

export function toLngLat(projection: Projection, x: number, y: number): [number, number] {
  return [projection.lng0 + x / projection.kx, projection.lat0 + y / projection.ky]
}

export function fromLngLat(projection: Projection, lng: number, lat: number): [number, number] {
  return [(lng - projection.lng0) * projection.kx, (lat - projection.lat0) * projection.ky]
}

export function buildNetwork(file: NetworkFile): Network {
  const { projection } = file.meta
  const unit = projection.unit
  const nodeCount = file.nodes.length / 2
  const nodeX = new Float64Array(nodeCount)
  const nodeY = new Float64Array(nodeCount)
  for (let i = 0; i < nodeCount; i++) {
    nodeX[i] = file.nodes[2 * i] * unit
    nodeY[i] = file.nodes[2 * i + 1] * unit
  }

  const seg = file.segments
  const segmentCount = seg.from.length
  const segClass = Uint8Array.from(seg.cls)
  const segName = Int32Array.from(seg.name)
  const segWay = Float64Array.from(seg.way)
  const segFlags = Uint8Array.from(seg.flags)
  const segCarSpeed = Float32Array.from(seg.speed, (kmh) => kmh / 3.6)
  const segLength = new Float64Array(segmentCount)

  // Decode geometry: from-node, interior points, to-node.
  let totalPoints = 0
  for (let s = 0; s < segmentCount; s++) totalPoints += seg.geom[s].length / 2 + 2
  const geomStart = new Int32Array(segmentCount + 1)
  const geomX = new Float64Array(totalPoints)
  const geomY = new Float64Array(totalPoints)
  const geomDist = new Float64Array(totalPoints)
  let p = 0
  for (let s = 0; s < segmentCount; s++) {
    geomStart[s] = p
    const from = seg.from[s]
    let ix = file.nodes[2 * from]
    let iy = file.nodes[2 * from + 1]
    geomX[p] = ix * unit
    geomY[p] = iy * unit
    p++
    const g = seg.geom[s]
    for (let k = 0; k < g.length; k += 2) {
      ix += g[k]
      iy += g[k + 1]
      geomX[p] = ix * unit
      geomY[p] = iy * unit
      p++
    }
    geomX[p] = nodeX[seg.to[s]]
    geomY[p] = nodeY[seg.to[s]]
    p++
    let d = 0
    for (let k = geomStart[s] + 1; k < p; k++) {
      d += Math.hypot(geomX[k] - geomX[k - 1], geomY[k] - geomY[k - 1])
      geomDist[k] = d
    }
    segLength[s] = Math.max(d, 0.1)
  }
  geomStart[segmentCount] = p

  // Directed edges.
  const edgeSegList: number[] = []
  const edgeRevList: number[] = []
  const edgeModesList: number[] = []
  for (let s = 0; s < segmentCount; s++) {
    const f = segFlags[s]
    const foot = f & SegmentFlag.Foot ? MODE_BIT[Mode.Foot] : 0
    // Buses may drive wherever cars may (bus-only edits add streets for them alone).
    const motor = MODE_BIT[Mode.Car] | MODE_BIT[Mode.Bus]
    const fwd = (f & SegmentFlag.CarForward ? motor : 0) | (f & SegmentFlag.BikeForward ? MODE_BIT[Mode.Bike] : 0) | foot
    const bwd = (f & SegmentFlag.CarBackward ? motor : 0) | (f & SegmentFlag.BikeBackward ? MODE_BIT[Mode.Bike] : 0) | foot
    if (fwd) {
      edgeSegList.push(s)
      edgeRevList.push(0)
      edgeModesList.push(fwd)
    }
    if (bwd) {
      edgeSegList.push(s)
      edgeRevList.push(1)
      edgeModesList.push(bwd)
    }
  }
  const edgeCount = edgeSegList.length
  const edgeSeg = Int32Array.from(edgeSegList)
  const edgeRev = Uint8Array.from(edgeRevList)
  const edgeModes = Uint8Array.from(edgeModesList)
  const edgeFrom = new Int32Array(edgeCount)
  const edgeTo = new Int32Array(edgeCount)
  const edgePriority = new Int8Array(edgeCount)
  const edgeStartHeading = new Float32Array(edgeCount)
  const edgeEndHeading = new Float32Array(edgeCount)
  const edgeSpeed: [Float32Array, Float32Array, Float32Array, Float32Array] = [
    new Float32Array(edgeCount),
    new Float32Array(edgeCount),
    new Float32Array(edgeCount),
    new Float32Array(edgeCount),
  ]
  const maxSpeed: [number, number, number, number] = [1, 1, 1, 1]

  for (let e = 0; e < edgeCount; e++) {
    const s = edgeSeg[e]
    const rev = edgeRev[e] === 1
    edgeFrom[e] = rev ? seg.to[s] : seg.from[s]
    edgeTo[e] = rev ? seg.from[s] : seg.to[s]
    const cls = file.classes[segClass[s]]
    edgePriority[e] = segFlags[s] & SegmentFlag.Roundabout ? ROUNDABOUT_PRIORITY : (PRIORITY[cls] ?? 0)

    const a = geomStart[s]
    const b = geomStart[s + 1] - 1
    const h0 = Math.atan2(geomY[a + 1] - geomY[a], geomX[a + 1] - geomX[a])
    const h1 = Math.atan2(geomY[b] - geomY[b - 1], geomX[b] - geomX[b - 1])
    edgeStartHeading[e] = rev ? h1 + Math.PI : h0
    edgeEndHeading[e] = rev ? h0 + Math.PI : h1

    const modes = edgeModes[e]
    if (modes & MODE_BIT[Mode.Car]) edgeSpeed[Mode.Car][e] = segCarSpeed[s]
    if (modes & MODE_BIT[Mode.Bike]) edgeSpeed[Mode.Bike][e] = BIKE_SPEED[cls] ?? 4.2
    if (modes & MODE_BIT[Mode.Foot]) edgeSpeed[Mode.Foot][e] = cls === 'steps' ? STEPS_SPEED : WALK_SPEED
    if (modes & MODE_BIT[Mode.Bus]) edgeSpeed[Mode.Bus][e] = segCarSpeed[s]
    for (let m = 0; m < 4; m++) maxSpeed[m] = Math.max(maxSpeed[m], edgeSpeed[m][e])
  }

  const csr = (key: Int32Array) => {
    const start = new Int32Array(nodeCount + 1)
    for (let e = 0; e < edgeCount; e++) start[key[e] + 1]++
    for (let i = 0; i < nodeCount; i++) start[i + 1] += start[i]
    const fill = start.slice(0, nodeCount)
    const list = new Int32Array(edgeCount)
    for (let e = 0; e < edgeCount; e++) list[fill[key[e]]++] = e
    return [start, list] as const
  }
  const [outStart, outEdges] = csr(edgeFrom)
  const [inStart, inEdges] = csr(edgeTo)

  const signals = (file.signals ?? []).filter((nodes) => nodes.every((i) => Number.isInteger(i) && i >= 0 && i < nodeCount))
  const nodeSignal = new Int32Array(nodeCount).fill(-1)
  signals.forEach((nodes, k) => {
    for (const i of nodes) nodeSignal[i] = k
  })

  return {
    projection,
    bbox: file.meta.bbox,
    classes: file.classes,
    names: file.names,
    nodeCount,
    nodeX,
    nodeY,
    segmentCount,
    segClass,
    segName,
    segWay,
    segFlags,
    segLength,
    segCarSpeed,
    geomStart,
    geomX,
    geomY,
    geomDist,
    edgeCount,
    edgeSeg,
    edgeRev,
    edgeFrom,
    edgeTo,
    edgeModes,
    edgePriority,
    edgeStartHeading,
    edgeEndHeading,
    edgeSpeed,
    outStart,
    outEdges,
    inStart,
    inEdges,
    maxSpeed,
    nodeSignal,
    signals,
  }
}

export function edgeLength(net: Network, e: number) {
  return net.segLength[net.edgeSeg[e]]
}

export interface Pose {
  x: number
  y: number
  /** Unit direction of travel. */
  dx: number
  dy: number
}

/** Position and direction at distance `d` along edge `e`. */
export function poseOnEdge(net: Network, e: number, d: number, out: Pose): Pose {
  const s = net.edgeSeg[e]
  const length = net.segLength[s]
  const rev = net.edgeRev[e] === 1
  const along = Math.max(0, Math.min(length, rev ? length - d : d))
  let lo = net.geomStart[s]
  let hi = net.geomStart[s + 1] - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (net.geomDist[mid] <= along) lo = mid
    else hi = mid
  }
  const piece = net.geomDist[hi] - net.geomDist[lo] || 1
  const t = (along - net.geomDist[lo]) / piece
  const ax = net.geomX[lo]
  const ay = net.geomY[lo]
  const bx = net.geomX[hi]
  const by = net.geomY[hi]
  out.x = ax + (bx - ax) * t
  out.y = ay + (by - ay) * t
  const len = Math.hypot(bx - ax, by - ay) || 1
  out.dx = ((bx - ax) / len) * (rev ? -1 : 1)
  out.dy = ((by - ay) / len) * (rev ? -1 : 1)
  return out
}

export function fetchJson<T>(url: string): Promise<T> {
  return fetch(url).then((response) => {
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
    return response.json() as Promise<T>
  })
}

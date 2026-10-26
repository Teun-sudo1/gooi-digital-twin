import { SegmentFlag } from '../../types/simulation'
import type { Network } from './network'

/*
 * Lanes per direction for car traffic, and where they lie across the street.
 *
 * Counts come from OpenStreetMap where it records them (gooi-lanes.json, by
 * way id). Elsewhere, on main roads, they are estimated from the measured
 * carriageway width (gooi-road-geometry.json, from the BGT outlines);
 * failing that, assumed from the street type: two on motorways and on
 * dual-carriageway trunk roads, one on everything else. Minor streets keep
 * one. Switched off, every street has one.
 *
 * Positions: where the carriageway was measured, the lanes share its width
 * between its inner and outer edge, so cars drive on the real asphalt even
 * where the OSM line is off-centre or runs down a median. Elsewhere lanes
 * are 3.2 m wide beside the line.
 */

/** Mapped lanes per OSM way: [with the way's direction, against it]. */
export interface LanesFile {
  attribution: string
  ways: Record<string, [number, number]>
}

export const MAX_LANES = 4
export const LANE_WIDTH = 3.2

/** Measured carriageway edges: rows of [segment, forward inner, forward outer, backward inner, backward outer]. */
export interface RoadGeometryFile {
  meta: { network: string }
  rows: (number | null)[][]
}

/** Inner and outer edge per segment and direction (0 forward, 1 backward), metres right of travel. */
export type RoadGeometry = Map<number, [[number, number] | null, [number, number] | null]>

export function readRoadGeometry(file: RoadGeometryFile | null): RoadGeometry {
  const geometry: RoadGeometry = new Map()
  for (const [s, fi, fo, bi, bo] of file?.rows ?? []) {
    if (s === null) continue
    geometry.set(s, [fi !== null && fo !== null ? [fi, fo] : null, bi !== null && bo !== null ? [bi, bo] : null])
  }
  return geometry
}

/** Streets that keep one lane whatever their width (parking and verges are often part of their asphalt). */
const MINOR = new Set(['residential', 'living_street', 'service', 'unclassified', 'track', 'road'])

/** Everything that decides an edge's lanes. */
export interface LaneSources {
  file: LanesFile | null
  geometry?: RoadGeometry
  added?: AddedLanes
}

function assumedLanes(cls: string, oneway: boolean) {
  if (cls === 'motorway') return 2
  if (cls === 'trunk' && oneway) return 2
  return 1
}

/** Roads added in a scenario: segments from `first` on, with their lanes per direction. */
export interface AddedLanes {
  first: number
  lanes: number[]
}

/** Fills `net.edgeLanes`, `edgeInner` and `edgeLaneWidth` (one lane everywhere when switched off). */
export function applyLanes(net: Network, sources: LaneSources, enabled: boolean) {
  for (let e = 0; e < net.edgeCount; e++) {
    const { lanes, inner, laneWidth } = edgeShape(net, sources, e, enabled)
    net.edgeLanes[e] = lanes
    net.edgeInner[e] = inner
    net.edgeLaneWidth[e] = laneWidth
  }
}

/** The measured carriageway of an edge, in its direction of travel, or null. */
function measured(net: Network, geometry: RoadGeometry | undefined, e: number) {
  return geometry?.get(net.edgeSeg[e])?.[net.edgeRev[e]] ?? null
}

/** Lanes of an edge and where they lie. */
export function edgeShape(net: Network, sources: LaneSources, e: number, enabled = true) {
  const lanes = enabled ? mappedLanes(net, sources, e) : 1
  const carriageway = measured(net, sources.geometry, e)
  if (carriageway) {
    const [inner, outer] = carriageway
    return { lanes, inner, laneWidth: (outer - inner) / lanes }
  }
  const s = net.edgeSeg[e]
  const flags = s < net.segmentCount ? net.segFlags[s] : 0
  const twoWay = (flags & SegmentFlag.CarForward) !== 0 && (flags & SegmentFlag.CarBackward) !== 0
  return { lanes, inner: twoWay ? 0.1 : (-lanes * LANE_WIDTH) / 2, laneWidth: LANE_WIDTH }
}

/** Car lanes of an edge as mapped, measured or assumed (or as drawn for a new road); 1 for edges cars never use. */
function mappedLanes(net: Network, { file, geometry, added }: LaneSources, e: number) {
  const s = net.edgeSeg[e]
  const flags = s < net.segmentCount ? net.segFlags[s] : 0
  // By the street as mapped, not its current access: a street closed in a scenario keeps
  // its lanes, so the cars still on it don't end up in one.
  if (!(flags & (net.edgeRev[e] ? SegmentFlag.CarBackward : SegmentFlag.CarForward))) return 1
  if (added && s >= added.first) return Math.max(1, Math.min(MAX_LANES, added.lanes[s - added.first] ?? 1))
  const cls = net.classes[net.segClass[s]]
  const tagged = file?.ways[String(net.segWay[s])]?.[net.edgeRev[e]]
  let lanes = tagged || 0
  if (!lanes) {
    const carriageway = measured(net, geometry, e)
    const oneway = ((flags & SegmentFlag.CarForward) !== 0) !== ((flags & SegmentFlag.CarBackward) !== 0)
    // About 3.4 m a lane; a little extra width (a narrow shoulder) doesn't make another lane.
    if (carriageway && !MINOR.has(cls)) lanes = Math.floor((carriageway[1] - carriageway[0] + 0.6) / 3.4)
    lanes = Math.max(lanes, assumedLanes(cls, oneway))
  }
  return Math.max(1, Math.min(MAX_LANES, lanes))
}

/** The outer edge of an edge's lanes (metres right of travel): where the kerb is. */
export function outerEdge(net: Network, e: number) {
  return net.edgeInner[e] + net.edgeLanes[e] * net.edgeLaneWidth[e]
}

/** Markings stop this far (m) from a junction, so they don't run across it. */
const MARKING_SETBACK = 7

/**
 * Road surface and lane markings for the streets with more than one lane in
 * a direction, in local metres along each segment. Offsets are metres to the
 * right of the segment's drawing direction and match where cars drive (see
 * TrafficModel.carLateral): on a two-way street the directions meet at the
 * centreline; on a one-way street the lanes sit around it.
 */
export interface LaneMarking {
  /** Points along the segment (local metres). */
  points: [number, number][]
  kind: 'surface' | 'divider' | 'centre' | 'edge'
  /** Metres right of the line (negative: left). */
  offset: number
  /** Surface width in metres (surfaces only). */
  width: number
  motorway: boolean
}

export function laneMarkings(net: Network, sources: LaneSources, hidden?: Set<number>): LaneMarking[] {
  const out: LaneMarking[] = []
  // The car edge of each segment and direction.
  const forward = new Int32Array(net.segmentCount).fill(-1)
  const backward = new Int32Array(net.segmentCount).fill(-1)
  for (let e = 0; e < net.edgeCount; e++) {
    const s = net.edgeSeg[e]
    if (s >= net.segmentCount || !(net.segFlags[s] & (net.edgeRev[e] ? SegmentFlag.CarBackward : SegmentFlag.CarForward))) continue
    ;(net.edgeRev[e] ? backward : forward)[s] = e
  }
  const motorwayClass = net.classes.indexOf('motorway')
  for (let s = 0; s < net.segmentCount; s++) {
    // Offsets in the segment's drawing direction: the backward lanes mirror theirs.
    const f = forward[s] >= 0 ? edgeShape(net, sources, forward[s]) : null
    const b = backward[s] >= 0 ? edgeShape(net, sources, backward[s]) : null
    if (Math.max(f?.lanes ?? 0, b?.lanes ?? 0) < 2 || hidden?.has(s)) continue
    const points: [number, number][] = []
    for (let k = net.geomStart[s]; k < net.geomStart[s + 1]; k++) points.push([net.geomX[k], net.geomY[k]])
    const motorway = net.segClass[s] === motorwayClass
    const lines = trim(points, Math.min(MARKING_SETBACK, net.segLength[s] * 0.25))
    const line = (kind: LaneMarking['kind'], offset: number) => lines && out.push({ points: lines, kind, offset, width: 0, motorway })
    let lo = Infinity
    let hi = -Infinity
    if (f) {
      for (let k = 1; k < f.lanes; k++) line('divider', f.inner + k * f.laneWidth)
      line('edge', f.inner + f.lanes * f.laneWidth)
      lo = Math.min(lo, f.inner)
      hi = Math.max(hi, f.inner + f.lanes * f.laneWidth)
    }
    if (b) {
      for (let k = 1; k < b.lanes; k++) line('divider', -(b.inner + k * b.laneWidth))
      line('edge', -(b.inner + b.lanes * b.laneWidth))
      lo = Math.min(lo, -(b.inner + b.lanes * b.laneWidth))
      hi = Math.max(hi, -b.inner)
    }
    // Between the directions: one centre line where they meet, otherwise an edge line on each side.
    if (f && b && Math.abs(f.inner + b.inner) < 1) line('centre', (f.inner - b.inner) / 2)
    else {
      if (f) line('edge', f.inner)
      if (b) line('edge', -b.inner)
    }
    out.push({ points, kind: 'surface', offset: (lo + hi) / 2, width: hi - lo + 0.6, motorway })
  }
  return out
}

/** The part of a polyline from `cut` metres after its start to `cut` before its end, or null when too short. */
function trim(points: [number, number][], cut: number): [number, number][] | null {
  const lengths = [0]
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]))
  const total = lengths[lengths.length - 1]
  if (total - 2 * cut < 4) return null
  const at = (d: number): [number, number] => {
    let i = 1
    while (i < points.length - 1 && lengths[i] < d) i++
    const t = (d - lengths[i - 1]) / (lengths[i] - lengths[i - 1] || 1)
    return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t]
  }
  const inner = points.filter((_, i) => lengths[i] > cut && lengths[i] < total - cut)
  return [at(cut), ...inner, at(total - cut)]
}

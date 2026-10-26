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

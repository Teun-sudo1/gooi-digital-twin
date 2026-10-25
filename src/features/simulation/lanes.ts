import { SegmentFlag } from '../../types/simulation'
import type { Network } from './network'

/*
 * Lanes per direction for car traffic. Counts come from OpenStreetMap where
 * it records them (public/data/gooi-lanes.json, by way id); elsewhere they
 * are assumed from the street type: two on motorways and on dual-carriageway
 * trunk roads, one on everything else. Switched off, every street has one.
 */

/** Mapped lanes per OSM way: [with the way's direction, against it]. */
export interface LanesFile {
  attribution: string
  ways: Record<string, [number, number]>
}

export const MAX_LANES = 4
export const LANE_WIDTH = 3.2

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

/** Fills `net.edgeLanes` from the mapped counts (or with ones when switched off). */
export function applyLanes(net: Network, file: LanesFile | null, enabled: boolean, added?: AddedLanes) {
  for (let e = 0; e < net.edgeCount; e++) net.edgeLanes[e] = enabled ? mappedLanes(net, file, e, added) : 1
}

/** Car lanes of an edge as mapped (or assumed, or as drawn for a new road); 1 for edges cars never use. */
function mappedLanes(net: Network, file: LanesFile | null, e: number, added?: AddedLanes) {
  const s = net.edgeSeg[e]
  const flags = s < net.segmentCount ? net.segFlags[s] : 0
  // By the street as mapped, not its current access: a street closed in a scenario keeps
  // its lanes, so the cars still on it don't end up in one.
  if (!(flags & (net.edgeRev[e] ? SegmentFlag.CarBackward : SegmentFlag.CarForward))) return 1
  if (added && s >= added.first) return Math.max(1, Math.min(MAX_LANES, added.lanes[s - added.first] ?? 1))
  const tagged = file?.ways[String(net.segWay[s])]
  const oneway = ((flags & SegmentFlag.CarForward) !== 0) !== ((flags & SegmentFlag.CarBackward) !== 0)
  const lanes = (tagged ? tagged[net.edgeRev[e]] : 0) || assumedLanes(net.classes[net.segClass[s]], oneway)
  return Math.max(1, Math.min(MAX_LANES, lanes))
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

export function laneMarkings(net: Network, file: LanesFile | null, added?: AddedLanes, hidden?: Set<number>): LaneMarking[] {
  const out: LaneMarking[] = []
  const forward = new Uint8Array(net.segmentCount)
  const backward = new Uint8Array(net.segmentCount)
  for (let e = 0; e < net.edgeCount; e++) {
    const s = net.edgeSeg[e]
    if (s >= net.segmentCount || !(net.segFlags[s] & (net.edgeRev[e] ? SegmentFlag.CarBackward : SegmentFlag.CarForward))) continue
    ;(net.edgeRev[e] ? backward : forward)[s] = mappedLanes(net, file, e, added)
  }
  const motorwayClass = net.classes.indexOf('motorway')
  for (let s = 0; s < net.segmentCount; s++) {
    const f = forward[s]
    const b = backward[s]
    if (Math.max(f, b) < 2 || hidden?.has(s)) continue
    const points: [number, number][] = []
    for (let k = net.geomStart[s]; k < net.geomStart[s + 1]; k++) points.push([net.geomX[k], net.geomY[k]])
    const motorway = net.segClass[s] === motorwayClass
    const lines = trim(points, Math.min(MARKING_SETBACK, net.segLength[s] * 0.25))
    const line = (kind: LaneMarking['kind'], offset: number) => lines && out.push({ points: lines, kind, offset, width: 0, motorway })
    if (f && b) {
      // Two-way: forward lanes right of the centreline, backward lanes left.
      out.push({ points, kind: 'surface', offset: (f - b) * (LANE_WIDTH / 2), width: (f + b) * LANE_WIDTH + 0.6, motorway })
      line('centre', 0)
      for (let k = 1; k < f; k++) line('divider', 0.1 + k * LANE_WIDTH)
      for (let k = 1; k < b; k++) line('divider', -(0.1 + k * LANE_WIDTH))
      line('edge', 0.1 + f * LANE_WIDTH)
      line('edge', -(0.1 + b * LANE_WIDTH))
    } else {
      const lanes = f || b
      out.push({ points, kind: 'surface', offset: 0, width: lanes * LANE_WIDTH + 0.6, motorway })
      for (let k = 1; k < lanes; k++) line('divider', (k - lanes / 2) * LANE_WIDTH)
      line('edge', (lanes / 2) * LANE_WIDTH)
      line('edge', -(lanes / 2) * LANE_WIDTH)
    }
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

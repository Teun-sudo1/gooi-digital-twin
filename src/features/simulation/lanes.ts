import { Mode, SegmentFlag } from '../../types/simulation'
import { MODE_BIT, type Network } from './network'

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

/** Fills `net.edgeLanes` from the mapped counts (or with ones when switched off). */
export function applyLanes(net: Network, file: LanesFile | null, enabled: boolean) {
  const car = MODE_BIT[Mode.Car]
  for (let e = 0; e < net.edgeCount; e++) {
    const s = net.edgeSeg[e]
    if (!enabled || !(net.edgeModes[e] & car) || s >= net.segmentCount) {
      net.edgeLanes[e] = 1
      continue
    }
    const tagged = file?.ways[String(net.segWay[s])]
    const flags = net.segFlags[s]
    const oneway = ((flags & SegmentFlag.CarForward) !== 0) !== ((flags & SegmentFlag.CarBackward) !== 0)
    const lanes = (tagged ? tagged[net.edgeRev[e]] : 0) || assumedLanes(net.classes[net.segClass[s]], oneway)
    net.edgeLanes[e] = Math.max(1, Math.min(MAX_LANES, lanes))
  }
}

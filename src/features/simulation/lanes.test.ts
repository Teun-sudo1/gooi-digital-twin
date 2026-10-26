import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Mode, type DemandFile, type NetworkFile } from '../../types/simulation'
import { applyLanes, outerEdge, readRoadGeometry, type LanesFile, type RoadGeometryFile } from './lanes'
import { buildNetwork } from './network'
import { turnAngle } from './signals'
import { TrafficModel } from './traffic'

const read = <T,>(path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/data/${path}`, import.meta.url)), 'utf8')) as T
const lanesFile = read<LanesFile>('gooi-lanes.json')
const geometryFile = read<RoadGeometryFile>('gooi-road-geometry.json')
const sources = { file: lanesFile, geometry: readRoadGeometry(geometryFile) }
const demand = read<DemandFile>('gooi-demand.json')

describe('lanes', () => {
  const net = buildNetwork(read<NetworkFile>('gooi-network.json'))
  applyLanes(net, sources, true)

  it('come from the map data, with more than one where it says so', () => {
    const counts = [0, 0, 0, 0, 0]
    for (let e = 0; e < net.edgeCount; e++) if (net.edgeModes[e] & 1) counts[net.edgeLanes[e]]++
    expect(counts[2] + counts[3] + counts[4]).toBeGreaterThan(500)
    // The A1 is a motorway with three or more lanes each way around the Gooi.
    const motorway = net.classes.indexOf('motorway')
    let wide = 0
    for (let e = 0; e < net.edgeCount; e++) if (net.segClass[net.edgeSeg[e]] === motorway && net.edgeLanes[e] >= 3) wide++
    expect(wide).toBeGreaterThan(20)
    // Switched off, every street has one.
    const off = buildNetwork(read<NetworkFile>('gooi-network.json'))
    applyLanes(off, sources, false)
    expect(off.edgeLanes.every((n) => n === 1)).toBe(true)
  })

  it('lie on the measured carriageways (BGT), also where the street line runs down a median', () => {
    expect(geometryFile.meta.network).toBe(read<NetworkFile>('gooi-network.json').meta.generated)
    let carSegments = 0
    for (let s = 0; s < net.segmentCount; s++) if (net.segFlags[s] & 3) carSegments++
    expect(geometryFile.rows.length / carSegments).toBeGreaterThan(0.5)
    const geometry = readRoadGeometry(geometryFile)
    let dual = 0
    let checked = 0
    for (let e = 0; e < net.edgeCount; e++) {
      const measured = geometry.get(net.edgeSeg[e])?.[net.edgeRev[e]]
      if (!measured || !(net.edgeModes[e] & 1)) continue
      // The lanes fill the carriageway, edge to edge.
      expect(net.edgeInner[e]).toBeCloseTo(measured[0], 3)
      expect(outerEdge(net, e)).toBeCloseTo(measured[1], 3)
      checked++
      if (measured[0] > 2) dual++
    }
    expect(checked).toBeGreaterThan(5000)
    // Dual carriageways mapped as one line: the lanes start beyond the median.
    expect(dual).toBeGreaterThan(20)
  })

  it('are used side by side, without cars overlapping in a lane, and turning cars get in lane', () => {
    const traffic = new TrafficModel(net, { density: 3000, startClock: 8 * 3600, seed: 5, demand })
    traffic.populate()
    let worst = Infinity
    const used = new Set<number>()
    const seen = new Set<string>()
    let leftTurns = 0
    let leftTurnsInLane = 0
    for (let i = 0; i < 900; i++) {
      // Cars about to turn left from a multi-lane street: in which lane?
      for (const a of traffic.agents) {
        if (a.mode !== Mode.Car || a.idx + 1 >= a.edges.length) continue
        const edge = a.edges[a.idx]
        const lanes = net.edgeLanes[edge]
        if (lanes < 2 || net.segLength[net.edgeSeg[edge]] < 100) continue
        const left = turnAngle(net.edgeEndHeading[edge], net.edgeStartHeading[a.edges[a.idx + 1]]) > 1
        const visit = `${a.id}:${a.idx}`
        if (left && net.segLength[net.edgeSeg[edge]] - a.offset < 15 && !seen.has(visit)) {
          seen.add(visit)
          leftTurns++
          if (a.lane === lanes - 1) leftTurnsInLane++
        }
      }
      traffic.step(0.5)
      if (i % 30 !== 29) continue
      const byLane = new Map<number, { offset: number; length: number }[]>()
      for (const a of traffic.agents) {
        if (a.mode !== Mode.Car) continue
        used.add(a.lane)
        const key = a.edges[a.idx] * 4 + a.lane
        byLane.set(key, [...(byLane.get(key) ?? []), a])
      }
      for (const list of byLane.values()) {
        list.sort((p, q) => p.offset - q.offset)
        for (let k = 1; k < list.length; k++) worst = Math.min(worst, list[k].offset - list[k].length - list[k - 1].offset)
      }
    }
    expect(used.has(1) && used.has(2)).toBe(true)
    expect(worst).toBeGreaterThan(-0.5)
    expect(leftTurns).toBeGreaterThan(20)
    expect(leftTurnsInLane / leftTurns).toBeGreaterThan(0.8)
    expect(traffic.stats().strandedTrips).toBe(0)
  }, 120_000)
})

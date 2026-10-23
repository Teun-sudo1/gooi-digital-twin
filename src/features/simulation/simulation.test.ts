import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { LngLat } from '../../types/geo'
import type { RoadNetworkFile, RoadSegmentRecord } from '../../types/simulation'
import { demandAt, TrafficSimulation } from './engine'
import { buildRoadGraph } from './graph'
import { findRoute } from './routing'

const huizen = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../public/data/huizen-roads.json', import.meta.url)), 'utf8'),
) as RoadNetworkFile

/**
 * Tiny synthetic network, ~100 m blocks:
 *
 *   0 ── 1 ── 2
 *   │         │
 *   3 ──────► 4     (3→4 is one-way)
 */
function tinyNetwork(): RoadNetworkFile {
  const nodes: LngLat[] = [
    [5.2, 52.3009],
    [5.2015, 52.3009],
    [5.203, 52.3009],
    [5.2, 52.3],
    [5.203, 52.3],
  ]
  const seg = (id: string, from: number, to: number, oneway = false): RoadSegmentRecord => ({
    id,
    way: 1,
    name: id,
    class: 'residential',
    speed: 30,
    speedSource: 'osm',
    oneway,
    roundabout: false,
    from,
    to,
    length: 0,
    coords: [nodes[from], nodes[to]],
  })
  return {
    meta: {
      description: 'test',
      source: 'test',
      license: 'test',
      osmTimestamp: null,
      bbox: [5.199, 52.299, 5.204, 52.302],
      generated: '',
    },
    nodes,
    segments: [seg('a', 0, 1), seg('b', 1, 2), seg('c', 0, 3), seg('d', 2, 4), seg('e', 3, 4, true)],
  }
}

const segmentsOf = (graph: ReturnType<typeof buildRoadGraph>, roads: number[]) =>
  roads.map((id) => graph.roads[id].segmentId)

describe('routing', () => {
  const graph = buildRoadGraph(tinyNetwork())

  it('takes the shorter one-way street when driving with it', () => {
    const route = findRoute(graph, 3, 4)!
    expect(segmentsOf(graph, route.roads)).toEqual(['e'])
  })

  it('never drives against a one-way street', () => {
    const route = findRoute(graph, 4, 3)!
    expect(segmentsOf(graph, route.roads)).toEqual(['d', 'b', 'a', 'c'])
  })

  it('detours around a closed road', () => {
    const route = findRoute(graph, 3, 4, new Set(['e']))!
    expect(segmentsOf(graph, route.roads)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('returns null when every way is closed', () => {
    expect(findRoute(graph, 3, 4, new Set(['e', 'a']))).toBeNull()
  })
})

describe('Huizen road network', () => {
  const graph = buildRoadGraph(huizen)

  it('has trip ends for every kind of demand', () => {
    expect(graph.zones.residential.length).toBeGreaterThan(100)
    expect(graph.zones.arterial.length).toBeGreaterThan(50)
    expect(graph.zones.gateways.length).toBeGreaterThanOrEqual(2)
  })

  it('routes between arbitrary junctions along connected roads', () => {
    const { all } = graph.zones
    for (let i = 0; i < 50; i++) {
      const from = all[(i * 7919) % all.length]
      const to = all[(i * 104_729 + 13) % all.length]
      if (from === to) continue
      const route = findRoute(graph, from, to)
      expect(route, `route ${from} → ${to}`).not.toBeNull()
      const roads = route!.roads.map((id) => graph.roads[id])
      expect(roads[0].from).toBe(from)
      expect(roads[roads.length - 1].to).toBe(to)
      for (let k = 1; k < roads.length; k++) expect(roads[k].from).toBe(roads[k - 1].to)
    }
  })
})

describe('traffic simulation', () => {
  const graph = buildRoadGraph(huizen)
  const [west, south, east, north] = huizen.meta.bbox

  it('follows a weekday demand profile', () => {
    expect(demandAt(8 * 3600)).toBeGreaterThan(demandAt(3 * 3600) * 10)
    expect(demandAt(7.5 * 3600)).toBeCloseTo((0.85 + 1.0) / 2)
  })

  it('moves cars along the network and completes trips', () => {
    const sim = new TrafficSimulation(graph, { density: 250, startClock: 8 * 3600, seed: 42 })
    sim.populate()
    expect(sim.vehicles.length).toBeGreaterThan(200)

    for (let i = 0; i < 1200; i++) sim.step(0.5) // ten simulated minutes
    const stats = sim.getStats()

    expect(stats.activeVehicles).toBeGreaterThan(150)
    expect(stats.completedTrips).toBeGreaterThan(50)
    expect(stats.totalDistanceKm).toBeGreaterThan(100)
    expect(stats.averageSpeedKmh).toBeGreaterThan(10)
    expect(stats.averageSpeedKmh).toBeLessThan(60)
    expect(stats.delayedVehicles).toBeLessThanOrEqual(stats.activeVehicles)
    expect(stats.clock).toBeCloseTo(8 * 3600 + 600)

    for (const vehicle of sim.vehicles) {
      const pose = sim.pose(vehicle)
      expect(Number.isFinite(pose.lng) && Number.isFinite(pose.lat)).toBe(true)
      // Within the network extent (ways may run slightly past the query box).
      expect(pose.lng).toBeGreaterThan(west - 0.02)
      expect(pose.lng).toBeLessThan(east + 0.02)
      expect(pose.lat).toBeGreaterThan(south - 0.02)
      expect(pose.lat).toBeLessThan(north + 0.02)
      expect(vehicle.offset).toBeLessThanOrEqual(graph.roads[vehicle.route.roads[vehicle.routeIndex]].lengthMeters)
    }
  })

  it('keeps cars apart on the same road', () => {
    const sim = new TrafficSimulation(graph, { density: 400, startClock: 17 * 3600, seed: 7 })
    sim.populate()
    for (let i = 0; i < 600; i++) sim.step(0.5)
    const byRoad = new Map<number, number[]>()
    for (const v of sim.vehicles) {
      const id = v.route.roads[v.routeIndex]
      byRoad.set(id, [...(byRoad.get(id) ?? []), v.offset])
    }
    let overlaps = 0
    let pairs = 0
    for (const offsets of byRoad.values()) {
      offsets.sort((a, b) => a - b)
      for (let k = 1; k < offsets.length; k++) {
        pairs++
        if (offsets[k] - offsets[k - 1] < 2) overlaps++
      }
    }
    // Merging at junctions can briefly squeeze cars together; it must stay rare.
    expect(overlaps / Math.max(pairs, 1)).toBeLessThan(0.05)
  })

  it('does not count a clock jump as travel time', () => {
    const sim = new TrafficSimulation(graph, { density: 300, startClock: 8 * 3600, seed: 5 })
    sim.populate()
    for (let i = 0; i < 120; i++) sim.step(0.5)
    sim.jumpTo(17 * 3600)
    for (let i = 0; i < 600; i++) sim.step(0.5)
    expect(sim.getStats().averageJourneyMinutes).toBeLessThan(20)
  })

  it('reroutes cars around a closed road', () => {
    const sim = new TrafficSimulation(graph, { density: 300, startClock: 8 * 3600, seed: 3 })
    sim.populate()
    // Close the busiest segment among the cars' remaining routes.
    const counts = new Map<string, number>()
    for (const v of sim.vehicles) {
      for (const id of v.route.roads.slice(v.routeIndex + 1)) {
        const segment = graph.roads[id].segmentId
        counts.set(segment, (counts.get(segment) ?? 0) + 1)
      }
    }
    const [busiest] = [...counts].sort((a, b) => b[1] - a[1])[0]
    sim.setClosedSegments([busiest])
    for (const v of sim.vehicles) {
      const upcoming = v.route.roads.slice(v.routeIndex + 1).map((id) => graph.roads[id].segmentId)
      expect(upcoming).not.toContain(busiest)
      for (let k = v.routeIndex + 1; k < v.route.roads.length; k++) {
        expect(graph.roads[v.route.roads[k]].from).toBe(graph.roads[v.route.roads[k - 1]].to)
      }
    }
    for (let i = 0; i < 200; i++) sim.step(0.5)
    expect(sim.getStats().activeVehicles).toBeGreaterThan(100)
  })
})

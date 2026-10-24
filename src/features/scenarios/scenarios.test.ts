import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Mode, type Intervention, type NetworkFile } from '../../types/simulation'
import { buildNetwork, MODE_BIT, toLngLat, type Network } from '../simulation/network'
import { findRoute } from '../simulation/routing'
import { tinyNetwork } from '../simulation/testNetwork'
import { TrafficModel } from '../simulation/traffic'
import { buildScenarioNetwork, nearestJunction, pickSegment, validInterventions } from './scenarioNetwork'

const segmentsOf = (net: Network, edges: Int32Array) => [...edges].map((e) => net.edgeSeg[e])
const route = (net: Network, mode: Mode, from: number, to: number) => {
  const r = findRoute(net, mode, from, to)
  return r ? segmentsOf(net, r.edges) : null
}

describe('road edits', () => {
  const file = tinyNetwork()

  it('detours around a closed street, and restores the original', () => {
    const closed = buildScenarioNetwork(file, [{ kind: 'access', segment: 4, access: 'closed' }]).net
    expect(route(closed, Mode.Car, 3, 4)).toEqual([2, 0, 1, 3])
    expect(route(closed, Mode.Foot, 3, 4)).toEqual([2, 0, 1, 3])
    const both = buildScenarioNetwork(file, [
      { kind: 'access', segment: 4, access: 'closed' },
      { kind: 'access', segment: 0, access: 'closed' },
    ]).net
    expect(findRoute(both, Mode.Car, 3, 4)).toBeNull()
    expect(route(buildScenarioNetwork(file, []).net, Mode.Car, 3, 4)).toEqual([4])
  })

  it('keeps car-free and pedestrian streets open to the right modes', () => {
    const carFree = buildScenarioNetwork(file, [{ kind: 'access', segment: 4, access: 'no-cars' }]).net
    expect(route(carFree, Mode.Car, 3, 4)).toEqual([2, 0, 1, 3])
    expect(route(carFree, Mode.Bike, 3, 4)).toEqual([4])
    const walking = buildScenarioNetwork(file, [{ kind: 'access', segment: 4, access: 'foot-only' }]).net
    expect(route(walking, Mode.Bike, 3, 4)).toEqual([2, 0, 1, 3])
    expect(route(walking, Mode.Foot, 3, 4)).toEqual([4])
    const bus = buildScenarioNetwork(file, [{ kind: 'access', segment: 4, access: 'bus-only' }]).net
    expect(route(bus, Mode.Car, 3, 4)).toEqual([2, 0, 1, 3])
  })

  it('changes the speed limit, and routes avoid a slowed street', () => {
    const { net } = buildScenarioNetwork(file, [{ kind: 'speed', segment: 4, kmh: 5 }])
    const edge = [...net.edgeSeg].indexOf(4)
    expect(net.edgeSpeed[Mode.Car][edge]).toBeCloseTo(5 / 3.6)
    // 200 m at 5 km/h is slower than the 400 m detour at 30 km/h.
    expect(route(net, Mode.Car, 3, 4)).toEqual([2, 0, 1, 3])
    const faster = buildScenarioNetwork(file, [{ kind: 'speed', segment: 0, kmh: 120 }]).net
    expect(faster.maxSpeed[Mode.Car]).toBeCloseTo(120 / 3.6)
  })

  it('adds cycle paths for bikes and pedestrians, keeping existing edge ids', () => {
    const base = buildNetwork(file)
    const [lng, lat] = toLngLat(file.meta.projection, 60, 40)
    const path: Intervention = { kind: 'cycle-path', id: 'p1', from: 3, to: 1, points: [[lng, lat]] }
    const scenario = buildScenarioNetwork(file, [path])
    const { net } = scenario
    expect(scenario.baseEdges).toBe(base.edgeCount)
    expect([...net.edgeSeg.slice(0, base.edgeCount)]).toEqual([...base.edgeSeg])
    expect(net.segmentCount).toBe(6)
    expect(route(net, Mode.Bike, 3, 1)).toEqual([5])
    expect(route(net, Mode.Foot, 1, 3)).toEqual([5])
    expect(route(net, Mode.Car, 3, 1)).toEqual([2, 0])
    expect(net.names[net.segName[5]]).toBe('New cycle path')
  })

  it('ignores malformed edits', () => {
    const list = [
      { kind: 'access', segment: 99, access: 'closed' },
      { kind: 'access', segment: 1, access: 'open-sesame' },
      { kind: 'speed', segment: 1, kmh: 999 },
      { kind: 'cycle-path', id: 'x', from: 2, to: 2, points: [] },
      { kind: 'teleport' },
      null,
      { kind: 'speed', segment: 1, kmh: 50 },
    ]
    expect(validInterventions(file, list)).toEqual([{ kind: 'speed', segment: 1, kmh: 50 }])
    expect(validInterventions(file, 'nope')).toEqual([])
  })

  it('picks the nearest street and junction', () => {
    const scenario = buildScenarioNetwork(file, [])
    const [lng, lat] = toLngLat(file.meta.projection, 100, 3) // just above the 3–4 street
    expect(pickSegment(scenario, lng, lat, 20, 31)?.segment).toBe(4)
    expect(pickSegment(scenario, lng, lat, 2, 31)).toBeNull()
    const near4 = toLngLat(file.meta.projection, 195, 4)
    expect(nearestJunction(scenario, near4[0], near4[1], 20)?.node).toBe(4)
  })
})

describe('rerouting traffic on the Gooi network', () => {
  const file = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../public/data/gooi-network.json', import.meta.url)), 'utf8'),
  ) as NetworkFile

  it('reroutes trips away from closed roads straight away', () => {
    const base = buildScenarioNetwork(file, [])
    const sim = new TrafficModel(base.net, { density: 1500, startClock: 8 * 3600, seed: 11 })
    sim.populate()
    for (let i = 0; i < 60; i++) sim.step(0.5)

    // Close the ten street segments that most car routes still have ahead of them.
    const usage = new Map<number, number>()
    for (const a of sim.agents) {
      if (a.mode !== Mode.Car) continue
      for (let k = a.idx + 1; k < a.edges.length; k++) {
        const s = base.net.edgeSeg[a.edges[k]]
        usage.set(s, (usage.get(s) ?? 0) + 1)
      }
    }
    const busiest = [...usage.entries()].sort((p, q) => q[1] - p[1]).slice(0, 10).map(([s]) => s)
    const closed = buildScenarioNetwork(
      file,
      busiest.map((segment) => ({ kind: 'access', segment, access: 'closed' })),
    )
    const carsBefore = sim.stats().cars
    sim.setNetwork(closed.net)
    for (let i = 0; i < 40; i++) sim.step(0.5)

    const stats = sim.stats()
    expect(stats.reroutedTrips).toBeGreaterThan(50)
    expect(stats.cars).toBeGreaterThan(carsBefore * 0.8)
    const bit = MODE_BIT[Mode.Car]
    for (const a of sim.agents) {
      if (a.mode !== Mode.Car) continue
      for (let k = a.idx + 1; k < a.edges.length; k++) expect(closed.net.edgeModes[a.edges[k]] & bit).toBe(bit)
    }
  })

  it('takes cyclists off a removed cycle path', () => {
    const scenarioNet = buildScenarioNetwork(file, [])
    const sim = new TrafficModel(scenarioNet.net, { density: 300, startClock: 8 * 3600, seed: 4 })
    sim.populate()
    const count = sim.agents.length
    // Pretend one cyclist is on an added path; removing all paths makes those edges stale.
    const cyclist = sim.agents.find((a) => a.mode === Mode.Bike)!
    sim.setNetwork(scenarioNet.net, cyclist.edges[cyclist.idx])
    expect(sim.agents.includes(cyclist)).toBe(false)
    expect(sim.agents.length).toBeLessThan(count)
    expect(sim.stats().strandedTrips).toBeGreaterThan(0)
  })
})

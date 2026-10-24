import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_STRIDE, Kind, Mode, type DemandFile, type NetworkFile, type TransitFile } from '../../types/simulation'
import { WEATHER_EFFECTS } from '../environment/environment'
import { nightFactor, sunElevation } from '../map/lighting'
import { buildNetwork, edgeLength, toLngLat, type Network } from './network'
import { buildScenarioNetwork } from '../scenarios/scenarioNetwork'
import { BusFleet, matchLines } from './buses'
import { findRoute, PathTree } from './routing'
import { ROAD_ID_LIMIT, TrafficModel } from './traffic'
import { tinyNetwork } from './testNetwork'
import { TransitModel } from './transit'

const read = <T,>(path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/data/${path}`, import.meta.url)), 'utf8')) as T
const networkFile = read<NetworkFile>('gooi-network.json')
const transitFile = read<TransitFile>('gooi-transit.json')
const demandFile = read<DemandFile>('gooi-demand.json')

const segmentsOf = (net: Network, edges: Int32Array) => [...edges].map((e) => net.edgeSeg[e])
const cost = (net: Network, mode: Mode, edges: Int32Array) =>
  [...edges].reduce((sum, e) => sum + edgeLength(net, e) / net.edgeSpeed[mode][e], 0)

describe('routing per mode', () => {
  const net = buildNetwork(tinyNetwork())

  it('lets cars use a one-way street only in its direction', () => {
    expect(segmentsOf(net, findRoute(net, Mode.Car, 3, 4)!.edges)).toEqual([4])
    expect(segmentsOf(net, findRoute(net, Mode.Car, 4, 3)!.edges)).toEqual([3, 1, 0, 2])
  })

  it('lets bikes and pedestrians use it both ways', () => {
    expect(segmentsOf(net, findRoute(net, Mode.Bike, 4, 3)!.edges)).toEqual([4])
    expect(segmentsOf(net, findRoute(net, Mode.Foot, 4, 3)!.edges)).toEqual([4])
  })

  it('gives the same routes from path trees as from A*', () => {
    expect(segmentsOf(net, new PathTree(net, Mode.Car, 3, 'to').route(4)!.edges)).toEqual([3, 1, 0, 2])
    expect(segmentsOf(net, new PathTree(net, Mode.Car, 3, 'from').route(4)!.edges)).toEqual([4])
  })
})

describe('Gooi street network', () => {
  const net = buildNetwork(networkFile)

  it('covers all modes', () => {
    for (const mode of [Mode.Car, Mode.Bike, Mode.Foot]) {
      expect(net.edgeSpeed[mode].some((v) => v > 0)).toBe(true)
    }
  })

  it('routes cars along connected edges, as fast through trees as with A*', () => {
    const traffic = new TrafficModel(net, { seed: 3 })
    const [car] = traffic.zoneInfo
    for (let i = 0; i < 25; i++) {
      const home = car.homes[(i * 7919) % car.homes.length]
      const zone = car.zones[(i * 104_729) % car.zones.length]
      const viaTree = new PathTree(net, Mode.Car, zone, 'to').route(home)
      const direct = findRoute(net, Mode.Car, home, zone)
      expect(viaTree === null).toBe(direct === null)
      if (!viaTree || !direct) continue
      expect(cost(net, Mode.Car, viaTree.edges)).toBeCloseTo(cost(net, Mode.Car, direct.edges), 3)
      const e = viaTree.edges
      for (let k = 1; k < e.length; k++) expect(net.edgeFrom[e[k]]).toBe(net.edgeTo[e[k - 1]])
    }
  })
})

describe('street traffic', () => {
  const net = buildNetwork(networkFile)
  // The network itself: roads leaving the region run a little past its box.
  const lngs = Array.from({ length: net.nodeCount }, (_, i) => toLngLat(net.projection, net.nodeX[i], net.nodeY[i]))
  const margin = 0.002
  const west = Math.min(...lngs.map((p) => p[0])) - margin
  const east = Math.max(...lngs.map((p) => p[0])) + margin
  const south = Math.min(...lngs.map((p) => p[1])) - margin
  const north = Math.max(...lngs.map((p) => p[1])) + margin

  it('moves cars and bikes realistically and keeps them on the map', () => {
    const sim = new TrafficModel(net, { density: 2000, startClock: 8 * 3600, seed: 42 })
    sim.populate()
    for (let i = 0; i < 1200; i++) sim.step(0.5) // ten simulated minutes
    const stats = sim.stats()
    expect(stats.cars).toBeGreaterThan(1500)
    expect(stats.bikes).toBeGreaterThan(500)
    expect(stats.averageCarSpeedKmh).toBeGreaterThan(20)
    expect(stats.averageCarSpeedKmh).toBeLessThan(90)
    expect(stats.averageBikeSpeedKmh).toBeGreaterThan(10)
    expect(stats.averageBikeSpeedKmh).toBeLessThan(26)
    expect(stats.averageCarJourneyMinutes).toBeGreaterThan(2)
    expect(stats.delayedCars).toBeLessThan(stats.cars)

    const frame = new Float32Array(AGENT_STRIDE * 10_000)
    const n = sim.writeFrame(frame, null)
    expect(n).toBe(sim.agents.length)
    const kinds = new Set<number>()
    for (let i = 0; i < n; i++) {
      const [lng, lat] = toLngLat(net.projection, frame[i * AGENT_STRIDE], frame[i * AGENT_STRIDE + 1])
      expect(lng).toBeGreaterThan(west)
      expect(lng).toBeLessThan(east)
      expect(lat).toBeGreaterThan(south)
      expect(lat).toBeLessThan(north)
      kinds.add(frame[i * AGENT_STRIDE + 3])
    }
    for (const kind of [Kind.Hatchback, Kind.Sedan, Kind.Suv, Kind.Van, Kind.Bike]) expect(kinds.has(kind)).toBe(true)
  })

  it('keeps cars from overlapping each other', () => {
    const sim = new TrafficModel(net, { density: 3000, startClock: 8 * 3600, seed: 21 })
    sim.populate()
    let worst = Infinity
    for (let i = 0; i < 600; i++) {
      sim.step(0.5)
      if (i % 60 !== 59) continue
      const byEdge = new Map<number, { offset: number; length: number }[]>()
      for (const a of sim.agents) {
        if (a.mode !== Mode.Car) continue
        const list = byEdge.get(a.edges[a.idx]) ?? []
        list.push(a)
        byEdge.set(a.edges[a.idx], list)
      }
      for (const list of byEdge.values()) {
        list.sort((p, q) => p.offset - q.offset)
        for (let k = 1; k < list.length; k++) worst = Math.min(worst, list[k].offset - list[k].length - list[k - 1].offset)
      }
    }
    // Bumper to bumper at worst, never inside each other.
    expect(worst).toBeGreaterThan(-0.5)
  })

  it('starts trips where people live, in proportion to CBS population', () => {
    const sim = new TrafficModel(net, { density: 1000, startClock: 8 * 3600, seed: 3, demand: demandFile })
    const [car] = sim.zoneInfo
    const w = car.homeWeights!
    const each = [...w].map((c, i) => c - (i ? w[i - 1] : 0))
    expect(Math.max(...each)).toBeGreaterThan(5 * (each.reduce((a, b) => a + b, 0) / each.length))
    expect(car.zoneWeights).not.toBeNull()
  })

  it('lets the weather change demand and speeds', () => {
    const sim = new TrafficModel(net, { density: 1000, startClock: 8 * 3600, seed: 3 })
    const cars = sim.target(Mode.Car)
    const bikes = sim.target(Mode.Bike)
    sim.weather = WEATHER_EFFECTS['heavy-rain']
    expect(sim.target(Mode.Car)).toBeGreaterThan(cars)
    expect(sim.target(Mode.Bike)).toBeLessThan(bikes * 0.6)
  })

  it('measures congestion per street', () => {
    const sim = new TrafficModel(net, { density: 2500, startClock: 8 * 3600, seed: 5 })
    sim.populate()
    for (let i = 0; i < 120; i++) sim.step(0.5)
    expect(sim.carTime.filter((t) => t > 15).length).toBeGreaterThan(300)
    expect(sim.delayedTime.some((t) => t > 0)).toBe(true)
  })

  it('simulates pedestrians only around a street-level view', () => {
    const sim = new TrafficModel(net, { density: 500, startClock: 13 * 3600, seed: 9 })
    sim.viewport = { minX: -600, minY: -600, maxX: 600, maxY: 600, zoom: 16.5 }
    for (let i = 0; i < 120; i++) sim.step(0.5)
    expect(sim.stats().pedestrians).toBeGreaterThan(50)
    sim.viewport = { ...sim.viewport, zoom: 12 }
    for (let i = 0; i < 4; i++) sim.step(0.5)
    expect(sim.stats().pedestrians).toBe(0)
  })

  it('does not count a clock jump as travel time', () => {
    const sim = new TrafficModel(net, { density: 1000, startClock: 8 * 3600, seed: 5 })
    sim.populate()
    for (let i = 0; i < 120; i++) sim.step(0.5)
    sim.jumpTo(17 * 3600)
    for (let i = 0; i < 600; i++) sim.step(0.5)
    expect(sim.stats().averageCarJourneyMinutes).toBeLessThan(30)
  })
})

describe('public transport', () => {
  const transit = new TransitModel(transitFile)
  const frame = new Float32Array(AGENT_STRIDE * 2000)
  const scenario = buildScenarioNetwork(networkFile, [])
  const runs = matchLines(transit, scenario.net)
  const busesAt = (clock: number) => {
    const traffic = new TrafficModel(scenario.net, { density: 0, startClock: clock, seed: 1 })
    const fleet = new BusFleet(transit, runs, traffic)
    fleet.reset(clock)
    return fleet.stats().buses
  }

  it('runs buses and trains by day and rests at night', () => {
    transit.writeFrame(8 * 3600, frame)
    expect(busesAt(8 * 3600)).toBeGreaterThan(20)
    expect(transit.counts.trains).toBeGreaterThan(3)
    transit.writeFrame(3.5 * 3600, frame)
    expect(transit.counts.trains).toBe(0)
  })

  it('follows the real weekday timetable', () => {
    expect(transit.timetableDate).toMatch(/^\d{8}$/)
    const infos = transit.infos
    expect(infos.every((l) => l.schedule === 'timetable')).toBe(true)
    expect(infos.reduce((sum, l) => sum + l.tripsPerDay, 0)).toBeGreaterThan(2000)
    // Night buses only run at weekends, so not on the weekday timetable.
    expect(infos.filter((l) => l.ref.startsWith('N')).every((l) => l.tripsPerDay === 0)).toBe(true)
    // Busy daytime, quiet early morning.
    expect(busesAt(4.5 * 3600)).toBeLessThan(busesAt(12 * 3600) / 3)
  })

  it('names stops from the timetable feed', () => {
    const named = transit.lines.flatMap((l) => l.stopNames).filter(Boolean)
    expect(named.length).toBeGreaterThan(500)
    expect(named.some((n) => n!.startsWith('Huizen, '))).toBe(true)
  })

  it('places trains on their routes, deterministically', () => {
    const n = transit.writeFrame(9 * 3600, frame)
    const again = new Float32Array(AGENT_STRIDE * 2000)
    expect(transit.writeFrame(9 * 3600, again)).toBe(n)
    expect([...again.slice(0, n * AGENT_STRIDE)]).toEqual([...frame.slice(0, n * AGENT_STRIDE)])
    for (let i = 0; i < n; i++) {
      const [lng, lat] = toLngLat(transitFile.meta.projection, frame[i * AGENT_STRIDE], frame[i * AGENT_STRIDE + 1])
      expect(lng).toBeGreaterThan(5.05)
      expect(lng).toBeLessThan(5.39)
      expect(lat).toBeGreaterThan(52.15)
      expect(lat).toBeLessThan(52.37)
    }
    const train = frame[6]
    expect(transit.inspectTrain(train, 9 * 3600)?.type).toBe('train')
  })

  it('drives buses through traffic, close to the timetable', () => {
    const traffic = new TrafficModel(scenario.net, { density: 1500, startClock: 10 * 3600, seed: 8 })
    traffic.populate()
    const fleet = new BusFleet(transit, runs, traffic)
    fleet.reset(traffic.clock)
    for (let i = 0; i < 1200; i++) {
      traffic.step(0.5)
      fleet.step(0.5, traffic.clock)
    }
    const stats = fleet.stats()
    expect(stats.buses).toBeGreaterThan(20)
    expect(stats.busDelayMinutes).toBeLessThan(2)
    // Cars queue behind moving buses.
    expect(traffic.externals.length).toBeGreaterThan(5)
    const bus = fleet.buses[0]
    expect(fleet.inspect(bus.id)).toMatchObject({ type: 'bus', line: bus.line.info.index, capacity: 80 })
    expect(fleet.buses.every((b) => b.onBoard <= 80)).toBe(true)
    // The departure board of a bus's next stop lists that bus as on its way.
    const coming = fleet.buses.find((b) => b.stopIdx < b.stops.length && b.stopLine[b.stopIdx] >= 0 && b.stopIdx + 1 < b.stops.length)!
    const board = fleet.board(coming.line.info.index, coming.stopLine[coming.stopIdx], traffic.clock)!
    expect(board.departures.some((d) => d.busId === coming.id && d.status !== 'scheduled')).toBe(true)
    expect(board.lines.length).toBeGreaterThan(0)
    // Simulated passengers ride the buses, and the route diagram shows the whole line.
    expect(fleet.buses.reduce((n, b) => n + b.onBoard, 0)).toBeGreaterThan(50)
    const info = fleet.inspect(bus.id)
    if (info?.type !== 'bus' || !info.route) throw new Error('no route')
    expect(info.route.forward.stops.length).toBeGreaterThan(3)
    expect(info.route.forward.buses.some((b) => b.id === bus.id)).toBe(true)
    const waiting = [...info.route.forward.stops, ...(info.route.back?.stops ?? [])].reduce((n, s) => n + s.waiting, 0)
    expect(waiting).toBeGreaterThan(0)
    const busiest = fleet.buses.map((b) => fleet.route(b.line.info.index)).filter((r) => r.back).length
    expect(busiest).toBeGreaterThan(5)
  })

  it('diverts buses around a closed street and rejoins the route', () => {
    const traffic = new TrafficModel(scenario.net, { density: 300, startClock: 11 * 3600, seed: 2 })
    const fleet = new BusFleet(transit, runs, traffic)
    fleet.reset(traffic.clock)
    // A bus with a matched street well ahead of it.
    let target: { id: number; segment: number; d: number } | null = null
    for (const bus of fleet.buses) {
      const run = runs[bus.line.info.index].find((r) => r.d0 > bus.d + 600 && r.d1 < bus.end - 1500 && r.d1 - r.d0 > 40)
      if (run) {
        target = { id: bus.id, segment: scenario.net.edgeSeg[run.edge], d: run.d1 }
        break
      }
    }
    expect(target).not.toBeNull()
    const closed = buildScenarioNetwork(networkFile, [{ kind: 'access', segment: target!.segment, access: 'closed' }])
    traffic.setNetwork(closed.net)
    fleet.networkChanged()
    let diverted = false
    for (let i = 0; i < 2400; i++) {
      traffic.step(0.5)
      fleet.step(0.5, traffic.clock)
      const bus = fleet.buses.find((b) => b.id === target!.id)
      if (!bus || bus.d > target!.d + 50) break
      if (bus.detour) diverted = true
    }
    expect(diverted).toBe(true)
    const after = fleet.buses.find((b) => b.id === target!.id)
    if (after) expect(after.d).toBeGreaterThan(target!.d)
  })
})

describe('comparing with the original network', () => {
  const scenario = buildScenarioNetwork(networkFile, [])

  it('forks the traffic and measures both runs', () => {
    const sim = new TrafficModel(scenario.net, { density: 1500, startClock: 8 * 3600, seed: 12 })
    sim.populate()
    const copy = sim.fork(scenario.net, 13)
    expect(copy.agents.length).toBe(sim.agents.filter((a) => a.mode !== Mode.Foot).length)
    expect(copy.agents[0]).not.toBe(sim.agents[0])
    sim.resetMeasures()
    copy.resetMeasures()
    for (let i = 0; i < 600; i++) {
      sim.step(0.5)
      copy.step(0.5)
    }
    for (const m of [sim.measures, copy.measures]) {
      expect(m.seconds).toBeCloseTo(300)
      expect(m.carKm).toBeGreaterThan(100)
      expect(m.journeys).toBeGreaterThan(10)
      expect(m.flow.some((v) => v > 20)).toBe(true)
    }
    // Same network and demand: similar results.
    expect(copy.measures.carKm / sim.measures.carKm).toBeGreaterThan(0.8)
    expect(copy.measures.carKm / sim.measures.carKm).toBeLessThan(1.25)
  })

  it('describes a followed car', () => {
    const sim = new TrafficModel(scenario.net, { density: 500, startClock: 9 * 3600, seed: 4 })
    sim.populate()
    const car = sim.agents.find((a) => a.mode === Mode.Car)!
    const info = sim.inspect(car.id % ROAD_ID_LIMIT)
    expect(info).toMatchObject({ type: 'road', vehicle: car.kind })
    if (info?.type === 'road') expect(info.remainingKm).toBeGreaterThan(0)
    expect(sim.inspect(ROAD_ID_LIMIT - 1)).toBeNull()
  })
})

describe('day and night', () => {
  it('follows the sun over the Gooi', () => {
    const june = new Date(Date.UTC(2026, 5, 21, 12))
    const december = new Date(Date.UTC(2026, 11, 21, 12))
    expect(sunElevation(13.5 * 3600, june)).toBeGreaterThan(55) // solar noon, midsummer
    expect(sunElevation(12.5 * 3600, december)).toBeLessThan(16) // low winter sun
    expect(sunElevation(0, june)).toBeLessThan(-5)
    expect(nightFactor(30)).toBe(0)
    expect(nightFactor(-12)).toBe(1)
    expect(nightFactor(-2)).toBeGreaterThan(0)
    expect(nightFactor(-2)).toBeLessThan(1)
  })
})

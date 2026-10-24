import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_STRIDE, Kind, Mode, type NetworkFile, type TransitFile } from '../../types/simulation'
import { nightFactor, sunElevation } from '../map/lighting'
import { buildNetwork, edgeLength, toLngLat, type Network } from './network'
import { findRoute, PathTree } from './routing'
import { TrafficModel } from './traffic'
import { tinyNetwork } from './testNetwork'
import { TransitModel } from './transit'

const read = <T,>(path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/data/${path}`, import.meta.url)), 'utf8')) as T
const networkFile = read<NetworkFile>('gooi-network.json')
const transitFile = read<TransitFile>('gooi-transit.json')

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
  const [west, south, east, north] = networkFile.meta.bbox

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
      expect(lng).toBeGreaterThan(west - 0.03)
      expect(lng).toBeLessThan(east + 0.03)
      expect(lat).toBeGreaterThan(south - 0.03)
      expect(lat).toBeLessThan(north + 0.03)
      kinds.add(frame[i * AGENT_STRIDE + 3])
    }
    for (const kind of [Kind.Hatchback, Kind.Sedan, Kind.Suv, Kind.Van, Kind.Bike]) expect(kinds.has(kind)).toBe(true)
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

  it('runs buses and trains by day and rests at night', () => {
    transit.writeFrame(8 * 3600, frame)
    expect(transit.counts.buses).toBeGreaterThan(20)
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
    transit.writeFrame(12 * 3600, frame)
    const midday = transit.counts.buses
    transit.writeFrame(4.5 * 3600, frame)
    expect(transit.counts.buses).toBeLessThan(midday / 3)
  })

  it('places vehicles on their routes, deterministically', () => {
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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WEATHER_EFFECTS, type Weather } from '../src/features/environment/environment'
import { buildScenarioNetwork } from '../src/features/scenarios/scenarioNetwork'
import { BusFleet, matchLines } from '../src/features/simulation/buses'
import { applyLanes, readRoadGeometry, type LanesFile, type RoadGeometryFile } from '../src/features/simulation/lanes'
import { buildSignalPlan, Signals } from '../src/features/simulation/signals'
import { TrafficModel } from '../src/features/simulation/traffic'
import { TransitModel } from '../src/features/simulation/transit'
import { Mode, type DemandFile, type NetworkFile, type SignalsFile, type TransitFile } from '../src/types/simulation'

/*
 * Deep simulation analysis: runs the whole regional model, with buses, for
 * half an hour of simulated time in several situations, checks health rules
 * in each (no vehicles inside each other, nobody stuck, plausible speeds,
 * buses near the timetable, finite numbers) and writes a report to
 * checks-output/simulation-health.md.
 *
 *   npm run check:deep
 */

const read = <T,>(path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../public/data/${path}`, import.meta.url)), 'utf8')) as T
const networkFile = read<NetworkFile>('gooi-network.json')
const transitFile = read<TransitFile>('gooi-transit.json')
const demand = read<DemandFile>('gooi-demand.json')
const signalsFile = read<SignalsFile>('gooi-signals.json')
const lanesFile = read<LanesFile>('gooi-lanes.json')
const laneSources = { file: lanesFile, geometry: readRoadGeometry(read<RoadGeometryFile>('gooi-road-geometry.json')) }

const MINUTES = 30
const DT = 0.5
const DENSITY = 3000

interface Situation {
  name: string
  clock: number
  lanes?: boolean
  lights?: boolean
  weather?: Weather
  /** Close the busiest main road after the start, and compare with the original. */
  closure?: boolean
}

const SITUATIONS: Situation[] = [
  { name: 'Morning rush', clock: 8 * 3600 },
  { name: 'Morning rush, traffic lights on', clock: 8 * 3600, lights: true },
  { name: 'Morning rush, one lane everywhere', clock: 8 * 3600, lanes: false },
  { name: 'Evening rush in heavy rain', clock: 17.5 * 3600, weather: 'heavy-rain' },
  { name: 'Night', clock: 2 * 3600 },
  { name: 'Busiest main road closed', clock: 8 * 3600, closure: true },
]

interface Row {
  situation: string
  cars: number
  target: number
  speedKmh: number
  delayedShare: number
  journeyMin: number | null
  stranded: number
  rerouted: number
  worstGapM: number
  busDelayMin: number | null
  busesLateShare: number
  carKmChange: string
  msPerSimMinute: number
  problems: string[]
}

function simulate(situation: Situation): Row {
  const scenario = buildScenarioNetwork(networkFile, [])
  const net = scenario.net
  applyLanes(net, laneSources, situation.lanes ?? true)
  const traffic = new TrafficModel(net, { density: DENSITY, startClock: situation.clock, seed: 7, demand })
  if (situation.weather) traffic.weather = { ...WEATHER_EFFECTS[situation.weather] }
  traffic.signals = new Signals(buildSignalPlan(net, signalsFile.points))
  traffic.signals.enabled = situation.lights ?? false
  const transit = new TransitModel(transitFile)
  const fleet = new BusFleet(transit, matchLines(transit, net), traffic)
  traffic.populate()
  fleet.reset(traffic.clock)

  // The comparison run on the original network, and the closure on the main one.
  let original: TrafficModel | null = null
  if (situation.closure) {
    for (let i = 0; i < 240; i++) traffic.step(DT)
    const flow = traffic.measures.flow
    const main = new Set(['primary', 'secondary', 'trunk'])
    let busiest = -1
    for (let s = 0; s < flow.length; s++) if (main.has(net.classes[net.segClass[s]]) && (busiest < 0 || flow[s] > flow[busiest])) busiest = s
    original = traffic.fork(net, 8)
    const closed = buildScenarioNetwork(networkFile, [{ kind: 'access', segment: busiest, access: 'closed' }])
    applyLanes(closed.net, laneSources, true)
    traffic.setNetwork(closed.net, Infinity, true)
    fleet.networkChanged()
    traffic.resetMeasures()
    original.resetMeasures()
  }

  const problems: string[] = []
  let worst = Infinity
  let carSamples = 0
  let targetSamples = 0
  let samples = 0
  let finite = true
  const started = performance.now()
  const steps = (MINUTES * 60) / DT
  for (let i = 0; i < steps; i++) {
    traffic.step(DT)
    fleet.step(DT, traffic.clock)
    original?.step(DT)
    if (i % 60 !== 59) continue
    samples++
    const stats = traffic.stats()
    carSamples += stats.cars
    targetSamples += traffic.target(Mode.Car)
    const byLane = new Map<number, { offset: number; length: number }[]>()
    for (const a of traffic.agents) {
      if (!Number.isFinite(a.offset) || !Number.isFinite(a.speed)) finite = false
      if (a.mode !== Mode.Car) continue
      const key = a.edges[a.idx] * 4 + a.lane
      const list = byLane.get(key)
      if (list) list.push(a)
      else byLane.set(key, [a])
    }
    for (const list of byLane.values()) {
      list.sort((p, q) => p.offset - q.offset)
      for (let k = 1; k < list.length; k++) worst = Math.min(worst, list[k].offset - list[k].length - list[k - 1].offset)
    }
  }
  const elapsed = performance.now() - started
  const stats = traffic.stats()
  const buses = fleet.stats()
  const m = traffic.measures
  const delayedShare = m.carSeconds ? m.delayedCarSeconds / m.carSeconds : 0
  const cars = Math.round(carSamples / samples)
  const target = Math.round(targetSamples / samples)

  // Health rules.
  if (!finite) problems.push('non-finite positions or speeds')
  if (worst < -0.5) problems.push(`cars overlap by ${(-worst).toFixed(1)} m`)
  if (stats.strandedTrips > cars * 0.01 + 5) problems.push(`${stats.strandedTrips} trips stranded`)
  if (target > 50 && (cars < target * 0.6 || cars > target * 1.3)) problems.push(`${cars} cars against a target of ${target}`)
  if (stats.cars > 50 && (stats.averageCarSpeedKmh < 15 || stats.averageCarSpeedKmh > 110)) problems.push(`average car speed ${stats.averageCarSpeedKmh.toFixed(0)} km/h`)
  if (delayedShare > (situation.closure ? 0.6 : 0.45)) problems.push(`${Math.round(delayedShare * 100)}% of car time delayed`)
  if (buses.busDelayMinutes !== null && buses.busDelayMinutes > 6) problems.push(`buses ${buses.busDelayMinutes.toFixed(1)} min late on average`)
  if (situation.closure && stats.reroutedTrips === 0) problems.push('nobody rerouted around the closure')

  return {
    situation: situation.name,
    cars,
    target,
    speedKmh: Math.round(stats.averageCarSpeedKmh * 10) / 10,
    delayedShare: Math.round(delayedShare * 1000) / 10,
    journeyMin: stats.averageCarJourneyMinutes === null ? null : Math.round(stats.averageCarJourneyMinutes * 10) / 10,
    stranded: stats.strandedTrips,
    rerouted: stats.reroutedTrips,
    worstGapM: Math.round(worst * 10) / 10,
    busDelayMin: buses.busDelayMinutes === null ? null : Math.round(buses.busDelayMinutes * 10) / 10,
    busesLateShare: buses.buses ? Math.round((buses.busesLate / buses.buses) * 100) : 0,
    carKmChange: original ? `${Math.round((m.carKm / Math.max(1, original.measures.carKm) - 1) * 100)}%` : '–',
    msPerSimMinute: Math.round(elapsed / MINUTES),
    problems,
  }
}

function report(rows: Row[]) {
  const head = '| Situation | Cars (target) | Speed km/h | Delayed % | Journey min | Stranded | Rerouted | Closest gap m | Bus delay min | Buses late % | Car km vs original | ms per sim min | Problems |'
  const lines = rows.map((r) =>
    `| ${r.situation} | ${r.cars} (${r.target}) | ${r.speedKmh} | ${r.delayedShare} | ${r.journeyMin ?? '–'} | ${r.stranded} | ${r.rerouted} | ${r.worstGapM} | ${r.busDelayMin ?? '–'} | ${r.busesLateShare} | ${r.carKmChange} | ${r.msPerSimMinute} | ${r.problems.join('; ') || 'none'} |`,
  )
  const md = [
    '# Simulation health',
    '',
    `Generated ${new Date().toISOString()}. Each situation runs ${MINUTES} simulated minutes of the whole region (${DENSITY} cars at peak, with buses). All figures are model output.`,
    '',
    head,
    head.replace(/[^|]+/g, ' --- '),
    ...lines,
    '',
  ].join('\n')
  const dir = fileURLToPath(new URL('../checks-output/', import.meta.url))
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}simulation-health.md`, md)
  writeFileSync(`${dir}simulation-health.json`, JSON.stringify(rows, null, 2))
  console.log(md)
}

describe('simulation health', () => {
  const rows: Row[] = []
  for (const situation of SITUATIONS) {
    it(situation.name, () => {
      const row = simulate(situation)
      rows.push(row)
      expect(row.problems).toEqual([])
    })
  }
  it('writes the report', () => {
    report(rows)
    // Traffic lights hold traffic up a little; lanes let more through.
    const [rush, lights, oneLane] = rows
    if (rush && lights) expect(lights.speedKmh).toBeLessThanOrEqual(rush.speedKmh + 2)
    if (rush && oneLane) expect(oneLane.delayedShare).toBeGreaterThanOrEqual(rush.delayedShare - 2)
  })
})

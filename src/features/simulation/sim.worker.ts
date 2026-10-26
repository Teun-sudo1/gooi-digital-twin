/// <reference lib="webworker" />
import {
  AGENT_STRIDE,
  Mode,
  type Comparison,
  type ComparisonSide,
  type DemandFile,
  type FollowInfo,
  type FromWorker,
  type Intervention,
  type NetworkFile,
  type SignalsFile,
  type StreetChange,
  type ToWorker,
  type TransitFile,
  type Viewport,
  type WeatherEffects,
} from '../../types/simulation'
import {
  buildScenarioNetwork,
  nearestJunction,
  pickSegment,
  validInterventions,
  type ScenarioNetwork,
} from '../scenarios/scenarioNetwork'
import { BusFleet, matchLines, type BusMeasures } from './buses'
import { fetchJson, fromLngLat, MODE_BIT, toLngLat, type Network } from './network'
import { findRoute, type Route } from './routing'
import { applyLanes, readRoadGeometry, type LaneSources, type LanesFile, type RoadGeometry, type RoadGeometryFile } from './lanes'
import { buildSignalPlan, Signals } from './signals'
import { CO2_KG_PER_KM, ROAD_ID_LIMIT, TrafficModel, type Measures } from './traffic'
import { BUS_ID_BASE, TRAIN_ID_BASE, TransitModel } from './transit'

/*
 * Runs the simulation off the main thread, so routing and stepping thousands
 * of agents never stalls map interaction. About 30 times a second it posts
 * the positions of visible agents as a transferable Float32Array. It waits
 * for the main thread to acknowledge each frame before sending the next.
 *
 * Road edits arrive as a whole scenario, which rebuilds the street network.
 * At the first edit the model is forked: a copy keeps running on the original
 * network in step with the edited one, so the two can be compared.
 */

declare const self: DedicatedWorkerGlobalScope

const TICK_MS = 33
/** Largest simulated step (s); bigger ticks are split so car-following stays stable. */
const MAX_SUBSTEP = 0.5
const STATS_INTERVAL = 250
const COMPARISON_INTERVAL = 1500
const CONGESTION_INTERVAL = 1000
/** Car-seconds on a street before its congestion is shown (a lone waiting car isn't a jam). */
const CONGESTION_MIN_TIME = 15
/** Simulated seconds a street keeps its colour after its last car. */
const CONGESTION_MEMORY = 300
const MAX_STREET_CHANGES = 400

interface Run {
  traffic: TrafficModel
  fleet: BusFleet
}

let networkFile: NetworkFile | null = null
let scenario: ScenarioNetwork | null = null
let originalNet: Network | null = null
let main: Run | null = null
/** The original network, running alongside while a scenario is active. */
let baseline: Run | null = null
let transit: TransitModel | null = null
let lanesFile: LanesFile | null = null
/** Measured carriageways (empty when the file is missing or belongs to another network). */
let roadGeometry: RoadGeometry = new Map()
let lanesOn = true
let playing = true
let speed = 5
let viewport: Viewport | null = null
let follow: number | null = null
/** Applied to models created later too (the comparison copy). */
let weather: WeatherEffects | null = null
/** The stop whose departure board is open. */
let board: { line: number; stop: number } | null = null
let awaitingAck = false
/** Latest requested time of day; applied once per tick so a dragged slider doesn't queue up jumps. */
let pendingClock: number | null = null
let lastTick = 0
let lastStats = 0
let lastComparison = 0
let lastCongestion = 0
const sentGeometry = new Set<number>()
const sentCongestionGeometry = new Set<number>()
/** Smoothed congestion level and last time with traffic, per segment. */
let congestionLevel = new Float32Array(0)
let congestionSeen = new Float32Array(0)
const agentBuffer = new Float32Array(AGENT_STRIDE * 25_000)
const transitBuffer = new Float32Array(AGENT_STRIDE * 2_000)

const post = (message: FromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer)

function runs() {
  return baseline ? [main!, baseline] : [main!]
}

function resetMeasures() {
  for (const run of runs()) {
    run.traffic.resetMeasures()
    run.fleet.resetMeasures()
  }
}

function tick() {
  const started = performance.now()
  const realDt = Math.min((started - lastTick) / 1000, 0.25)
  lastTick = started
  if (main && transit) {
    const { traffic, fleet } = main
    if (pendingClock !== null) {
      for (const run of runs()) {
        run.traffic.jumpTo(pendingClock)
        run.fleet.reset(run.traffic.clock)
      }
      resetMeasures()
      pendingClock = null
      lastStats = 0 // report the new time straight away
    }
    if (playing) {
      let remaining = realDt * speed
      while (remaining > 1e-6) {
        const dt = Math.min(remaining, MAX_SUBSTEP)
        for (const run of runs()) {
          run.traffic.step(dt)
          run.fleet.step(dt, run.traffic.clock)
        }
        remaining -= dt
      }
    }
    if (!awaitingAck) {
      const followed = follow ?? -1
      const agentCount = traffic.writeFrame(agentBuffer, viewport, followed)
      let transitCount = transit.writeFrame(traffic.clock, transitBuffer)
      transitCount = fleet.writeFrame(transitBuffer, transitCount, viewport, followed)
      const agents = agentBuffer.slice(0, agentCount * AGENT_STRIDE)
      const transitFrame = transitBuffer.slice(0, transitCount * AGENT_STRIDE)
      const signals = new Uint8Array(traffic.signals?.plan.heads.length ?? 0)
      traffic.signals?.writeStates(signals)
      awaitingAck = true
      post(
        { type: 'frame', agents, agentCount, transit: transitFrame, transitCount, signals },
        [agents.buffer, transitFrame.buffer, signals.buffer],
      )
    }
    if (started - lastStats > STATS_INTERVAL) {
      lastStats = started
      const buses = fleet.stats()
      post({
        type: 'stats',
        stats: { ...traffic.stats(), ...transit.counts, ...buses, buses: transit.counts.buses + buses.buses },
      })
      if (follow !== null) post({ type: 'follow', id: follow, info: inspect(follow) })
      if (board) post({ type: 'board', board: fleet.board(board.line, board.stop, traffic.clock) })
    }
    if (started - lastCongestion > CONGESTION_INTERVAL) {
      lastCongestion = started
      reportCongestion()
    }
    if (baseline && started - lastComparison > COMPARISON_INTERVAL) {
      lastComparison = started
      post({ type: 'comparison', comparison: compare() })
    }
  }
  setTimeout(tick, Math.max(0, TICK_MS - (performance.now() - started)))
}

function segmentCoordinates(net: Network, segment: number) {
  const coordinates: [number, number][] = []
  for (let k = net.geomStart[segment]; k < net.geomStart[segment + 1]; k++) {
    const [lng, lat] = toLngLat(net.projection, net.geomX[k], net.geomY[k])
    coordinates.push([Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6])
  }
  return coordinates
}

/** Sends the congestion level of every street with recent car traffic. */
function reportCongestion() {
  if (!main || !scenario) return
  const { traffic } = main
  const count = Math.min(traffic.carTime.length, scenario.baseSegments)
  if (congestionLevel.length !== count) {
    congestionLevel = new Float32Array(count).fill(-1)
    congestionSeen = new Float32Array(count).fill(-Infinity)
  }
  const clock = traffic.clock
  const segments: number[] = []
  const levels: number[] = []
  const geometry: { segment: number; coordinates: [number, number][] }[] = []
  for (let s = 0; s < count; s++) {
    const time = traffic.carTime[s]
    if (time >= CONGESTION_MIN_TIME) {
      const level = traffic.delayedTime[s] / time
      congestionLevel[s] = congestionLevel[s] < 0 ? level : congestionLevel[s] * 0.6 + level * 0.4
      congestionSeen[s] = clock
      traffic.carTime[s] = 0
      traffic.delayedTime[s] = 0
    }
    const age = (clock - congestionSeen[s] + 86_400) % 86_400
    if (congestionLevel[s] < 0 || age > CONGESTION_MEMORY) continue
    segments.push(s)
    levels.push(congestionLevel[s])
    if (!sentCongestionGeometry.has(s)) {
      sentCongestionGeometry.add(s)
      geometry.push({ segment: s, coordinates: segmentCoordinates(scenario.net, s) })
    }
  }
  const segmentArray = Int32Array.from(segments)
  const levelArray = Float32Array.from(levels)
  post({ type: 'congestion', segments: segmentArray, levels: levelArray, geometry }, [segmentArray.buffer, levelArray.buffer])
}

function inspect(id: number): FollowInfo | null {
  if (!main || !transit) return null
  if (id < ROAD_ID_LIMIT) return main.traffic.inspect(id)
  if (id >= BUS_ID_BASE && id < TRAIN_ID_BASE) return main.fleet.inspect(id)
  return transit.inspectTrain(id, main.traffic.clock)
}

function side(m: Measures, buses: BusMeasures): ComparisonSide {
  const hours = m.seconds / 3600
  const carKmPerHour = hours > 0 ? m.carKm / hours : 0
  return {
    journeyMinutes: m.journeys ? m.journeySeconds / m.journeys / 60 : null,
    carSpeedKmh: m.carSeconds ? m.carKm / (m.carSeconds / 3600) : 0,
    carKmPerHour,
    delayedShare: m.carSeconds ? m.delayedCarSeconds / m.carSeconds : 0,
    co2KgPerHour: carKmPerHour * CO2_KG_PER_KM,
    busDelayMinutes: buses.busSeconds ? buses.delaySeconds / buses.busSeconds / 60 : null,
  }
}

/** The edited network against the original, since the last edit. */
function compare(): Comparison | null {
  if (!main || !baseline || !scenario) return null
  const a = baseline.traffic.measures
  const b = main.traffic.measures
  const hours = Math.max(a.seconds, 1) / 3600
  const net = scenario.net
  const streets: StreetChange[] = []
  const count = Math.min(a.flow.length, b.flow.length, scenario.baseSegments)
  // Streets whose traffic clearly changed (enough cars to tell a change from chance).
  for (let s = 0; s < count; s++) {
    const before = a.flow[s]
    const after = b.flow[s]
    const most = Math.max(before, after)
    const diff = after - before
    if (most < 15 || Math.abs(diff) < 8 || Math.abs(diff) < 0.35 * most) continue
    streets.push({ segment: s, original: before / hours, scenario: after / hours })
  }
  streets.sort((p, q) => Math.abs(q.scenario - q.original) - Math.abs(p.scenario - p.original))
  streets.length = Math.min(streets.length, MAX_STREET_CHANGES)
  for (const street of streets) {
    if (sentGeometry.has(street.segment)) continue
    sentGeometry.add(street.segment)
    street.coordinates = segmentCoordinates(net, street.segment)
  }
  return {
    minutes: a.seconds / 60,
    original: side(a, baseline.fleet.measures),
    scenario: side(b, main.fleet.measures),
    streets,
  }
}

async function init(message: Extract<ToWorker, { type: 'init' }>) {
  try {
    const [file, transitFile, demand, signalsFile, lanes, geometry] = await Promise.all([
      fetchJson<NetworkFile>(message.networkUrl),
      fetchJson<TransitFile>(message.transitUrl),
      // Without neighbourhood figures, trips are spread evenly.
      fetchJson<DemandFile>(message.demandUrl).catch(() => null),
      // Without mapped signals, every junction uses the right-of-way rules.
      fetchJson<SignalsFile>(message.signalsUrl).catch(() => null),
      // Without lane data, lanes are assumed from the street type.
      fetchJson<LanesFile>(message.lanesUrl).catch(() => null),
      // Without measured carriageways, lanes sit at standard widths beside the street's line.
      fetchJson<RoadGeometryFile>(message.roadGeometryUrl).catch(() => null),
    ])
    lanesFile = lanes
    // Rows are by segment: only use them with the network they were measured on.
    roadGeometry = readRoadGeometry(geometry?.meta.network === file.meta.generated ? geometry : null)
    lanesOn = message.lanes
    networkFile = file
    scenario = buildScenarioNetwork(file, [])
    originalNet = scenario.net
    applyLanes(scenario.net, laneSources(scenario), lanesOn)
    transit = new TransitModel(transitFile)
    const traffic = new TrafficModel(scenario.net, { density: message.density, startClock: message.clock, seed: Date.now(), demand })
    traffic.viewport = viewport
    if (weather) traffic.weather = weather
    if (signalsFile) {
      traffic.signals = new Signals(buildSignalPlan(scenario.net, signalsFile.points))
      traffic.signals.enabled = message.signals
    }
    const fleet = new BusFleet(transit, matchLines(transit, scenario.net), traffic)
    main = { traffic, fleet }
    playing = message.playing
    speed = message.speed
    traffic.populate()
    fleet.reset(traffic.clock)
    post({
      type: 'ready',
      projection: file.meta.projection,
      lines: transit.infos,
      timetableDate: transit.timetableDate,
      signals: traffic.signals?.plan.heads.map(({ x, y, bearing }) => ({ x, y, bearing })) ?? [],
    })
    lastTick = performance.now()
    tick()
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

function applyScenario(list: Intervention[]) {
  if (!networkFile || !main || !scenario || !originalNet) return
  const interventions = validInterventions(networkFile, list)
  // Start comparing at the first edit; stop when the original network is restored.
  if (interventions.length && !baseline) {
    const traffic = main.traffic.fork(originalNet, Date.now() + 1)
    baseline = { traffic, fleet: main.fleet.fork(traffic) }
  } else if (!interventions.length && baseline) {
    baseline = null
    post({ type: 'comparison', comparison: null })
  }
  const previous = scenario.roadIds
  const next = buildScenarioNetwork(networkFile, interventions)
  // Cycle paths are appended in order: if one was removed, later path edges changed id.
  const pathsKept = previous.every((id, i) => next.roadIds[i] === id)
  applyLanes(next.net, laneSources(next), lanesOn)
  scenario = next
  // Counts run for the whole scenario and restart when the original network is restored.
  main.traffic.setNetwork(next.net, pathsKept ? Infinity : next.baseEdges, interventions.length === 0)
  main.fleet.networkChanged()
  resetMeasures()
  lastStats = 0
  lastComparison = performance.now()
}

/** Lane counts and measured carriageways, plus the lanes of roads added in a scenario. */
function laneSources(s: ScenarioNetwork | null): LaneSources {
  return { file: lanesFile, geometry: roadGeometry, added: s ? { first: s.baseSegments, lanes: s.newLanes } : undefined }
}

/** The junction nearest to a point (within 400 m) where cars can drive off, or -1. */
function nearestCarNode(net: Network, lng: number, lat: number) {
  const [x, y] = fromLngLat(net.projection, lng, lat)
  let best = -1
  let bestD = 400
  for (let n = 0; n < net.nodeCount; n++) {
    const d = Math.hypot(net.nodeX[n] - x, net.nodeY[n] - y)
    if (d >= bestD) continue
    for (let k = net.outStart[n]; k < net.outStart[n + 1]; k++) {
      if (net.edgeModes[net.outEdges[k]] & MODE_BIT[Mode.Car]) {
        bestD = d
        best = n
        break
      }
    }
  }
  return best
}

/** Starts a car on the fastest route through the waypoints; returns its id, or null. */
function drive(waypoints: unknown): number | null {
  if (!main || !Array.isArray(waypoints) || waypoints.length < 2 || waypoints.length > 30) return null
  const net = main.traffic.net
  const nodes: number[] = []
  for (const p of waypoints) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
    const node = nearestCarNode(net, p[0], p[1])
    if (node < 0) return null
    nodes.push(node)
  }
  const legs: Route[] = []
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] === nodes[i - 1]) continue
    const leg = findRoute(net, Mode.Car, nodes[i - 1], nodes[i])
    if (!leg) return null
    legs.push(leg)
  }
  if (!legs.length) return null
  const route: Route = {
    edges: Int32Array.from(legs.flatMap((l) => [...l.edges])),
    lengthMeters: legs.reduce((sum, l) => sum + l.lengthMeters, 0),
    freeFlowSeconds: legs.reduce((sum, l) => sum + l.freeFlowSeconds, 0),
  }
  return main.traffic.addCar(route)
}

function pick(message: Extract<ToWorker, { type: 'pick' }>) {
  if (!scenario) return
  const [lng, lat] = message.lngLat
  const radius = Math.min(Math.max(message.radius, 1), 500)
  post({
    type: 'pick',
    id: message.id,
    segment: message.target === 'segment' ? pickSegment(scenario, lng, lat, radius, message.mask) : null,
    junction: message.target === 'junction' ? nearestJunction(scenario, lng, lat, radius) : null,
  })
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data
  switch (message.type) {
    case 'init':
      void init(message)
      break
    case 'play':
      playing = message.playing
      break
    case 'speed':
      speed = message.speed
      break
    case 'density':
      if (main) for (const run of runs()) run.traffic.density = message.density
      break
    case 'clock':
      pendingClock = message.clock
      break
    case 'viewport':
      viewport = message.viewport
      if (main) main.traffic.viewport = viewport
      break
    case 'ack':
      awaitingAck = false
      break
    case 'scenario':
      applyScenario(message.interventions)
      break
    case 'pick':
      pick(message)
      break
    case 'drive':
      post({ type: 'drive', id: message.id, car: drive(message.waypoints) })
      break
    case 'weather':
      if (main) for (const run of runs()) run.traffic.weather = { ...message.effects }
      weather = { ...message.effects }
      break
    case 'signals':
      if (main) for (const run of runs()) if (run.traffic.signals) run.traffic.signals.enabled = message.enabled === true
      break
    case 'lanes':
      lanesOn = message.enabled === true
      if (scenario) applyLanes(scenario.net, laneSources(scenario), lanesOn)
      if (originalNet && originalNet !== scenario?.net) applyLanes(originalNet, laneSources(null), lanesOn)
      break
    case 'stop':
      board = message.line === null || !Number.isInteger(message.line) || !Number.isInteger(message.stop) ? null : { line: message.line, stop: message.stop }
      if (!board) post({ type: 'board', board: null })
      lastStats = 0
      break
    case 'follow':
      follow = typeof message.id === 'number' && Number.isFinite(message.id) ? message.id : null
      lastStats = 0
      break
  }
}

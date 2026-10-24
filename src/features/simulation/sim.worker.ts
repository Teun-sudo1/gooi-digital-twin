/// <reference lib="webworker" />
import {
  AGENT_STRIDE,
  type FromWorker,
  type Intervention,
  type NetworkFile,
  type ToWorker,
  type TransitFile,
  type Viewport,
} from '../../types/simulation'
import {
  buildScenarioNetwork,
  nearestJunction,
  pickSegment,
  validInterventions,
  type ScenarioNetwork,
} from '../scenarios/scenarioNetwork'
import { fetchJson } from './network'
import { TrafficModel } from './traffic'
import { TransitModel } from './transit'

/*
 * Runs the simulation off the main thread, so routing and stepping thousands
 * of agents never stalls map interaction. About 30 times a second it posts
 * the positions of visible agents as a transferable Float32Array. It waits
 * for the main thread to acknowledge each frame before sending the next.
 * Road edits arrive as a whole scenario, which rebuilds the street network.
 */

declare const self: DedicatedWorkerGlobalScope

const TICK_MS = 33
/** Largest simulated step (s); bigger ticks are split so car-following stays stable. */
const MAX_SUBSTEP = 0.5
const STATS_INTERVAL = 250

let networkFile: NetworkFile | null = null
let scenario: ScenarioNetwork | null = null
let traffic: TrafficModel | null = null
let transit: TransitModel | null = null
let playing = true
let speed = 5
let viewport: Viewport | null = null
let awaitingAck = false
/** Latest requested time of day; applied once per tick so a dragged slider doesn't queue up jumps. */
let pendingClock: number | null = null
let lastTick = 0
let lastStats = 0
const agentBuffer = new Float32Array(AGENT_STRIDE * 25_000)
const transitBuffer = new Float32Array(AGENT_STRIDE * 2_000)

const post = (message: FromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer)

function tick() {
  const started = performance.now()
  const realDt = Math.min((started - lastTick) / 1000, 0.25)
  lastTick = started
  if (traffic && transit) {
    if (pendingClock !== null) {
      traffic.jumpTo(pendingClock)
      pendingClock = null
      lastStats = 0 // report the new time straight away
    }
    if (playing) {
      let remaining = realDt * speed
      while (remaining > 1e-6) {
        const dt = Math.min(remaining, MAX_SUBSTEP)
        traffic.step(dt)
        remaining -= dt
      }
    }
    if (!awaitingAck) {
      const agentCount = traffic.writeFrame(agentBuffer, viewport)
      const transitCount = transit.writeFrame(traffic.clock, transitBuffer)
      const agents = agentBuffer.slice(0, agentCount * AGENT_STRIDE)
      const transitFrame = transitBuffer.slice(0, transitCount * AGENT_STRIDE)
      awaitingAck = true
      post({ type: 'frame', agents, agentCount, transit: transitFrame, transitCount }, [agents.buffer, transitFrame.buffer])
    }
    if (started - lastStats > STATS_INTERVAL) {
      lastStats = started
      post({ type: 'stats', stats: { ...traffic.stats(), ...transit.counts } })
    }
  }
  setTimeout(tick, Math.max(0, TICK_MS - (performance.now() - started)))
}

async function init(message: Extract<ToWorker, { type: 'init' }>) {
  try {
    const [file, transitFile] = await Promise.all([
      fetchJson<NetworkFile>(message.networkUrl),
      fetchJson<TransitFile>(message.transitUrl),
    ])
    networkFile = file
    scenario = buildScenarioNetwork(file, [])
    traffic = new TrafficModel(scenario.net, { density: message.density, startClock: message.clock, seed: Date.now() })
    transit = new TransitModel(transitFile)
    traffic.viewport = viewport
    playing = message.playing
    speed = message.speed
    traffic.populate()
    post({ type: 'ready', projection: file.meta.projection, lines: transit.infos, timetableDate: transit.timetableDate })
    lastTick = performance.now()
    tick()
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

function applyScenario(list: Intervention[]) {
  if (!networkFile || !traffic || !scenario) return
  const interventions = validInterventions(networkFile, list)
  const previous = scenario.pathIds
  const next = buildScenarioNetwork(networkFile, interventions)
  // Cycle paths are appended in order: if one was removed, later path edges changed id.
  const pathsKept = previous.every((id, i) => next.pathIds[i] === id)
  scenario = next
  // Counts run for the whole scenario and restart when the original network is restored.
  traffic.setNetwork(next.net, pathsKept ? Infinity : next.baseEdges, interventions.length === 0)
  lastStats = 0
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
      if (traffic) traffic.density = message.density
      break
    case 'clock':
      pendingClock = message.clock
      break
    case 'viewport':
      viewport = message.viewport
      if (traffic) traffic.viewport = viewport
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
  }
}

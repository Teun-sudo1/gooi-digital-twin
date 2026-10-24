/// <reference lib="webworker" />
import {
  AGENT_STRIDE,
  type FromWorker,
  type NetworkFile,
  type ToWorker,
  type TransitFile,
  type Viewport,
} from '../../types/simulation'
import { buildNetwork, fetchJson } from './network'
import { TrafficModel } from './traffic'
import { TransitModel } from './transit'

/*
 * Runs the simulation off the main thread, so routing and stepping thousands
 * of agents never stalls map interaction. About 30 times a second it posts
 * the positions of visible agents as a transferable Float32Array. It waits
 * for the main thread to acknowledge each frame before sending the next.
 */

declare const self: DedicatedWorkerGlobalScope

const TICK_MS = 33
/** Largest simulated step (s); bigger ticks are split so car-following stays stable. */
const MAX_SUBSTEP = 0.5
const STATS_INTERVAL = 250

let traffic: TrafficModel | null = null
let transit: TransitModel | null = null
let playing = true
let speed = 5
let viewport: Viewport | null = null
let awaitingAck = false
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
    const [networkFile, transitFile] = await Promise.all([
      fetchJson<NetworkFile>(message.networkUrl),
      fetchJson<TransitFile>(message.transitUrl),
    ])
    const net = buildNetwork(networkFile)
    traffic = new TrafficModel(net, { density: message.density, startClock: message.clock, seed: Date.now() })
    transit = new TransitModel(transitFile)
    traffic.viewport = viewport
    playing = message.playing
    speed = message.speed
    traffic.populate()
    post({ type: 'ready', projection: networkFile.meta.projection, lines: transit.infos, timetableDate: transit.timetableDate })
    lastTick = performance.now()
    tick()
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
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
      traffic?.jumpTo(message.clock)
      break
    case 'viewport':
      viewport = message.viewport
      if (traffic) traffic.viewport = viewport
      break
    case 'ack':
      awaitingAck = false
      break
  }
}

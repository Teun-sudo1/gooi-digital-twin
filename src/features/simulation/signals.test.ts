import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Mode, type DemandFile, type NetworkFile, type SignalsFile } from '../../types/simulation'
import { buildNetwork } from './network'
import { buildSignalPlan, Signals, SignalState } from './signals'
import { TrafficModel } from './traffic'

const read = <T,>(path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/data/${path}`, import.meta.url)), 'utf8')) as T

describe('traffic lights', () => {
  const net = buildNetwork(read<NetworkFile>('gooi-network.json'))
  const plan = buildSignalPlan(net, read<SignalsFile>('gooi-signals.json').points)
  const name = (e: number) => net.names[net.segName[net.edgeSeg[e]]] ?? ''
  const approachesOf = (c: number) => plan.approaches.map((a, i) => ({ ...a, index: i })).filter((a) => a.controller === c)

  it('make one junction of the corners of a large crossing', () => {
    expect(plan.controllers.length).toBeGreaterThan(50)
    // Stichtseweg × Randweg Oost in Huizen: two dual carriageways, four junction points.
    const crossing = plan.controllers.findIndex((_, c) => {
      const names = new Set(approachesOf(c).map((a) => name(a.edge)))
      return names.has('Stichtseweg') && names.has('Randweg Oost')
    })
    expect(crossing).toBeGreaterThanOrEqual(0)
    const approaches = approachesOf(crossing)
    // Vehicles stop only where they enter; the links inside run freely.
    const inside = new Set(approaches.map((a) => net.edgeTo[a.edge]))
    expect(inside.size).toBeGreaterThan(1)
    for (const a of approaches) expect(plan.internal[a.edge]).toBe(0)
    // Separate phases for each direction, and for left turns.
    expect(plan.controllers[crossing].phases.filter((p) => p.left).length).toBe(2)
  })

  it('never show green to two phases of a junction at once, and give everyone a turn', () => {
    const signals = new Signals(plan)
    const greenSeen = new Set<number>()
    for (let t = 0; t < 900; t++) {
      // Traffic waiting everywhere, turning left and going straight on.
      for (const a of plan.approaches) {
        signals.detect(a.edge, 20, 0, false)
        signals.detect(a.edge, 20, 0, true)
      }
      signals.step(1)
      for (let c = 0; c < plan.controllers.length; c++) {
        const green = new Set<string>()
        for (const a of approachesOf(c)) {
          for (const left of [false, true]) {
            if (signals.state(a.edge, left) !== SignalState.Green) continue
            const ctl = plan.controllers[c]
            green.add(`${a.axis}:${left && ctl.left[a.axis] >= 0}`)
            greenSeen.add(a.index)
          }
        }
        expect(green.size).toBeLessThanOrEqual(1)
      }
    }
    expect(greenSeen.size).toBe(plan.approaches.length)
  })

  it('skip directions with nobody waiting', () => {
    const signals = new Signals(plan)
    const c = plan.controllers.findIndex((ctl) => ctl.through[0] >= 0 && ctl.through[1] >= 0 && ctl.phases.every((p) => p.axis >= 0))
    const main = approachesOf(c).filter((a) => a.axis === 0)
    const side = approachesOf(c).find((a) => a.axis === 1)!
    let sideGreen = 0
    let mainGreen = 0
    for (let t = 0; t < 300; t++) {
      for (const a of main) signals.detect(a.edge, 20, 8, false)
      signals.step(1)
      if (signals.state(side.edge, false) === SignalState.Green) sideGreen++
      if (signals.state(main[0].edge, false) === SignalState.Green) mainGreen++
    }
    expect(sideGreen).toBeLessThan(15)
    expect(mainGreen).toBeGreaterThan(270)
  })

  it('let traffic flow, without stopping inside junctions, and can be switched off', () => {
    const traffic = new TrafficModel(net, { density: 2500, startClock: 8 * 3600, seed: 5, demand: read<DemandFile>('gooi-demand.json') })
    traffic.signals = new Signals(plan)
    traffic.populate()
    let waitingAtLights = 0
    let stoppedInside = 0
    for (let i = 0; i < 1200; i++) {
      traffic.step(0.5)
      if (i % 20) continue
      for (const a of traffic.agents) {
        if (a.mode !== Mode.Car || a.speed > 0.3) continue
        if (plan.internal[a.edges[a.idx]]) stoppedInside++
        else if (plan.approachOf[a.edges[a.idx]] >= 0) waitingAtLights++
      }
    }
    const stats = traffic.stats()
    expect(stats.strandedTrips).toBe(0)
    expect(stats.averageCarSpeedKmh).toBeGreaterThan(30)
    expect(waitingAtLights).toBeGreaterThan(200)
    // Only where a queue from the next junction reaches back.
    expect(stoppedInside).toBeLessThan(waitingAtLights / 5)

    traffic.signals.enabled = false
    expect(traffic.signals.state(plan.approaches[0].edge, false)).toBe(-1)
    expect(traffic.signals.isInternal(plan.approaches[0].edge)).toBe(false)
  }, 120_000)
})

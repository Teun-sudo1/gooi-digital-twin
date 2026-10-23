import type { Feature, Point } from 'geojson'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { useAppStore } from '../../store/useAppStore'
import { useSimulationStore } from '../../store/useSimulationStore'
import { TrafficSimulation } from './engine'
import type { RoadGraph } from './graph'

const SOURCE = 'sim-vehicles'
const LAYER = 'sim-vehicles'
/** Largest simulated time step (s); bigger frames are split so car-following stays stable. */
const MAX_SUBSTEP = 0.5
/** How often stats are pushed to React (ms). The map itself updates every frame. */
const PUBLISH_INTERVAL = 250
/** Simulated seconds between points on the trend chart. */
const HISTORY_INTERVAL = 300
const HISTORY_LENGTH = 144 // 12 simulated hours

export const VEHICLE_COLORS = { moving: '#f4b860', delayed: '#ff6b5e' }

/** Draws a small top-down car (pointing up) for use as a map icon. */
function carIcon(color: string) {
  const ratio = 2
  const width = 10 * ratio
  const height = 20 * ratio
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
  ctx.beginPath()
  ctx.roundRect(1.5, 1.5, width - 3, height - 3, 6)
  ctx.fill()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.roundRect(2.5, 1, width - 5, height - 3, 5)
  ctx.fill()
  // Windscreen, so the direction of travel is readable.
  ctx.fillStyle = 'rgba(12, 16, 22, 0.75)'
  ctx.beginPath()
  ctx.roundRect(5, 9, width - 10, 6, 2)
  ctx.fill()
  return { image: ctx.getImageData(0, 0, width, height), pixelRatio: ratio }
}

/**
 * Runs the simulation in a requestAnimationFrame loop and draws the cars
 * through a single GeoJSON source and symbol layer. No per-vehicle DOM
 * elements are created. React only receives throttled statistics.
 */
export class SimulationController {
  readonly sim: TrafficSimulation
  private map: MapLibreMap
  private frame = 0
  private lastFrame = 0
  private lastPublish = 0
  /** Simulated seconds since the last trend-chart sample. */
  private sinceSample = 0
  private disposed = false

  constructor(map: MapLibreMap, graph: RoadGraph) {
    this.map = map
    const { density } = useSimulationStore.getState()
    this.sim = new TrafficSimulation(graph, { density, startClock: 7.5 * 3600, seed: Date.now() })
    this.sim.populate()
    this.addLayers()
    this.render()
    this.publish(true)
    this.setPlaying(true)
  }

  setPlaying(playing: boolean) {
    useSimulationStore.setState({ playing })
    if (playing && !this.frame && !this.disposed) {
      this.lastFrame = performance.now()
      this.frame = requestAnimationFrame(this.tick)
    } else if (!playing && this.frame) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    }
  }

  setSpeed(speed: number) {
    useSimulationStore.setState({ speed })
  }

  setDensity(density: number) {
    this.sim.density = density
    useSimulationStore.setState({ density })
  }

  /** Jumps to another time of day. The trend chart restarts because its timeline is broken. */
  setClock(clock: number) {
    this.sim.jumpTo(clock)
    this.publish(true)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.frame = 0
    // The map may already be gone when React unmounts after a map teardown.
    if (this.map.getStyle()) {
      if (this.map.getLayer(LAYER)) this.map.removeLayer(LAYER)
      if (this.map.getSource(SOURCE)) this.map.removeSource(SOURCE)
    }
  }

  private tick = (now: number) => {
    // Clamp long gaps (background tab, breakpoints) so the model never jumps far.
    const realDt = Math.min((now - this.lastFrame) / 1000, 0.1)
    this.lastFrame = now
    let remaining = realDt * useSimulationStore.getState().speed
    this.sinceSample += remaining
    while (remaining > 1e-6) {
      const dt = Math.min(remaining, MAX_SUBSTEP)
      this.sim.step(dt)
      remaining -= dt
    }
    this.render()
    if (now - this.lastPublish > PUBLISH_INTERVAL) this.publish(false)
    this.frame = requestAnimationFrame(this.tick)
  }

  private addLayers() {
    const map = this.map
    for (const [name, color] of [
      ['sim-car', VEHICLE_COLORS.moving],
      ['sim-car-delayed', VEHICLE_COLORS.delayed],
    ] as const) {
      if (!map.hasImage(name)) {
        const { image, pixelRatio } = carIcon(color)
        map.addImage(name, image, { pixelRatio })
      }
    }
    map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    // Inserted below the 3D buildings so buildings hide the cars behind them.
    map.addLayer(
      {
        id: LAYER,
        type: 'symbol',
        source: SOURCE,
        layout: {
          'icon-image': ['case', ['get', 'd'], 'sim-car-delayed', 'sim-car'],
          'icon-rotate': ['get', 'b'],
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          // Drawn larger than true scale below zoom 18 so traffic stays readable.
          'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.3, 15, 0.6, 17, 1.05, 19, 2.2],
          visibility: useAppStore.getState().layerVisibility.traffic ? 'visible' : 'none',
        },
      },
      map.getLayer('buildings-3d') ? 'buildings-3d' : undefined,
    )
  }

  private render() {
    const features: Feature<Point>[] = []
    for (const vehicle of this.sim.vehicles) {
      const pose = this.sim.pose(vehicle)
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pose.lng, pose.lat] },
        properties: { b: pose.bearing, d: pose.delayed },
      })
    }
    this.map.getSource<GeoJSONSource>(SOURCE)?.setData({ type: 'FeatureCollection', features })
  }

  private publish(resetHistory: boolean) {
    this.lastPublish = performance.now()
    const stats = this.sim.getStats()
    let { history } = useSimulationStore.getState()
    if (resetHistory || this.sinceSample >= HISTORY_INTERVAL) {
      const point = {
        clock: stats.clock,
        activeVehicles: stats.activeVehicles,
        averageSpeedKmh: stats.averageSpeedKmh,
        delayedVehicles: stats.delayedVehicles,
      }
      history = resetHistory ? [point] : [...history, point].slice(-HISTORY_LENGTH)
      this.sinceSample = 0
    }
    useSimulationStore.setState({ stats, history })
  }
}

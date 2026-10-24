import type { Feature, LineString, Point } from 'geojson'
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { useAppStore } from '../../store/useAppStore'
import { useSimulationStore } from '../../store/useSimulationStore'
import {
  AGENT_STRIDE,
  Kind,
  type FromWorker,
  type Projection,
  type ToWorker,
  type TransitLineInfo,
} from '../../types/simulation'
import { agentIcon, registerIcons } from './icons'
import { fromLngLat, toLngLat } from './network'

const AGENTS = 'sim-agents'
const TRANSIT = 'sim-transit'
const ROUTES = 'transit-routes'
const STOPS = 'transit-stops'
const FONT = ['Noto Sans Regular']
/** Simulated seconds between trend-chart samples. */
const HISTORY_INTERVAL = 300
const HISTORY_LENGTH = 144

/** Vehicles are drawn at true scale from zoom 17 up, and larger than life below that. */
const VEHICLE_SIZE: ExpressionSpecification = ['interpolate', ['exponential', 2], ['zoom'], 12, 0.45, 15, 0.65, 16, 0.75, 17, 0.85, 20, 5.44]
/** People are small: cyclists and pedestrians are drawn larger than life so they stay visible. */
const PEOPLE_BOOST: ExpressionSpecification = ['match', ['get', 'k'], Kind.Pedestrian, 3.2, Kind.Bike, 1.8, 1]
const PEOPLE_BOOST_CLOSE: ExpressionSpecification = ['match', ['get', 'k'], Kind.Pedestrian, 1.6, Kind.Bike, 1.2, 1]
const AGENT_SIZE: ExpressionSpecification = [
  'interpolate', ['exponential', 2], ['zoom'],
  12, ['*', 0.45, PEOPLE_BOOST],
  15, ['*', 0.65, PEOPLE_BOOST],
  16, ['*', 0.75, PEOPLE_BOOST],
  17, ['*', 0.85, PEOPLE_BOOST],
  20, ['*', 5.44, PEOPLE_BOOST_CLOSE],
]
/** Train carriages stay at true scale (they are long enough to see). */
const TRAIN_SIZE: ExpressionSpecification = ['interpolate', ['exponential', 2], ['zoom'], 14, 0.085, 20, 5.44]

type Pool = Feature<Point, Record<string, string | number>>[]

/** Dark or light text, whichever reads better on a line colour. */
function readableOn(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16)
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return luminance > 0.6 ? '#111418' : '#ffffff'
}

/**
 * Main-thread side of the simulation. Starts the worker, draws what it sends
 * through MapLibre GeoJSON sources (one feature per visible agent, reused
 * between frames), tells it which part of the map is visible, and passes
 * throttled statistics to React.
 */
export class SimulationClient {
  private worker: Worker
  private map: MapLibreMap
  private projection: Projection | null = null
  private lines: TransitLineInfo[] = []
  private agentPool: Pool = []
  private transitPool: Pool = []
  private lastRender = 0
  private lastSample = -1
  private resetHistory = true
  private night = 0
  private disposed = false
  private viewportTimer = 0

  constructor(map: MapLibreMap) {
    this.map = map
    const state = useSimulationStore.getState()
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.onMessage(event.data)
    this.worker.onerror = (event) => {
      useSimulationStore.setState({ status: 'error', error: `Simulation worker failed: ${event.message}` })
    }
    const base = new URL(import.meta.env.BASE_URL, window.location.href)
    this.post({
      type: 'init',
      networkUrl: new URL('data/gooi-network.json', base).href,
      transitUrl: new URL('data/gooi-transit.json', base).href,
      clock: state.startClock,
      density: state.density,
      speed: state.speed,
      playing: true,
    })
    useSimulationStore.setState({ playing: true })
    map.on('move', this.onMove)
    map.on('moveend', this.sendViewport)
  }

  setPlaying(playing: boolean) {
    this.post({ type: 'play', playing })
    useSimulationStore.setState({ playing })
  }

  setSpeed(speed: number) {
    this.post({ type: 'speed', speed })
    useSimulationStore.setState({ speed })
  }

  setDensity(density: number) {
    this.post({ type: 'density', density })
    useSimulationStore.setState({ density })
  }

  /** Jump to another time of day; the trend chart restarts because its timeline is broken. */
  setClock(clock: number) {
    this.post({ type: 'clock', clock })
    this.resetHistory = true
  }

  /** 0 = day, 1 = night: fades vehicle headlights in and out. */
  setNight(night: number) {
    this.night = night
    if (!this.map.getLayer('sim-headlights')) return
    this.map.setLayoutProperty('sim-headlights', 'visibility', night > 0.05 && this.trafficVisible() ? 'visible' : 'none')
    this.map.setPaintProperty('sim-headlights', 'icon-opacity', Math.min(1, night) * 0.85)
  }

  dispose() {
    this.disposed = true
    this.worker.terminate()
    this.map.off('move', this.onMove)
    this.map.off('moveend', this.sendViewport)
    window.clearTimeout(this.viewportTimer)
    if (!this.map.getStyle()) return
    for (const layer of ['sim-trains', 'sim-transit', 'sim-agents', 'sim-headlights', STOPS, ROUTES]) {
      if (this.map.getLayer(layer)) this.map.removeLayer(layer)
    }
    for (const source of [AGENTS, TRANSIT, ROUTES, STOPS]) {
      if (this.map.getSource(source)) this.map.removeSource(source)
    }
  }

  private post(message: ToWorker) {
    if (!this.disposed) this.worker.postMessage(message)
  }

  private trafficVisible() {
    return useAppStore.getState().layerVisibility.traffic
  }

  private onMove = () => {
    if (this.viewportTimer) return
    this.viewportTimer = window.setTimeout(() => {
      this.viewportTimer = 0
      this.sendViewport()
    }, 200)
  }

  private sendViewport = () => {
    if (!this.projection) return
    const bounds = this.map.getBounds()
    const [x1, y1] = fromLngLat(this.projection, bounds.getWest(), bounds.getSouth())
    const [x2, y2] = fromLngLat(this.projection, bounds.getEast(), bounds.getNorth())
    this.post({
      type: 'viewport',
      viewport: { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2), zoom: this.map.getZoom() },
    })
  }

  private onMessage(message: FromWorker) {
    if (this.disposed) return
    switch (message.type) {
      case 'ready':
        this.projection = message.projection
        this.lines = message.lines
        registerIcons(this.map, message.lines)
        this.addLayers()
        this.setNight(this.night)
        this.sendViewport()
        useSimulationStore.setState({ status: 'ready', lines: message.lines, timetableDate: message.timetableDate })
        break
      case 'error':
        console.error('[simulation]', message.message)
        useSimulationStore.setState({
          status: 'error',
          error: 'The street and transit networks could not be loaded, so the simulation is unavailable.',
        })
        break
      case 'frame':
        this.render(message.agents, message.agentCount, message.transit, message.transitCount)
        this.post({ type: 'ack' })
        break
      case 'stats': {
        const { stats } = message
        let { history } = useSimulationStore.getState()
        const since = (stats.clock - this.lastSample + 86_400) % 86_400
        if (this.resetHistory || since >= HISTORY_INTERVAL) {
          const point = {
            clock: stats.clock,
            cars: stats.cars,
            bikes: stats.bikes,
            averageCarSpeedKmh: stats.averageCarSpeedKmh,
            delayedCars: stats.delayedCars,
          }
          history = this.resetHistory ? [point] : [...history, point].slice(-HISTORY_LENGTH)
          this.lastSample = stats.clock
          this.resetHistory = false
        }
        useSimulationStore.setState({ stats, history })
        break
      }
    }
  }

  private render(agents: Float32Array, agentCount: number, transit: Float32Array, transitCount: number) {
    const projection = this.projection
    if (!projection) return
    // When zoomed out, motion per frame is sub-pixel: redraw ~10× per second to save work.
    const now = performance.now()
    if (this.map.getZoom() < 13 && now - this.lastRender < 90) return
    this.lastRender = now

    const fill = (pool: Pool, data: Float32Array, count: number, transitLayer: boolean) => {
      for (let i = 0; i < count; i++) {
        const o = i * AGENT_STRIDE
        let feature = pool[i]
        if (!feature) {
          feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }
          pool[i] = feature
        }
        feature.geometry.coordinates = toLngLat(projection, data[o], data[o + 1])
        const kind = data[o + 3]
        const props = feature.properties
        props.b = data[o + 2]
        props.k = kind
        if (!transitLayer) props.i = agentIcon(kind, data[o + 4], data[o + 5])
        else if (kind === Kind.Bus) {
          const line = this.lines[data[o + 4]]
          props.i = `bus-${line.colour}`
          props.r = line.ref
          props.c = line.colour
          props.t = readableOn(line.colour)
        } else props.i = `train-${data[o + 5]}`
      }
      return pool.slice(0, count)
    }

    this.map.getSource<GeoJSONSource>(AGENTS)?.setData({ type: 'FeatureCollection', features: fill(this.agentPool, agents, agentCount, false) })
    this.map.getSource<GeoJSONSource>(TRANSIT)?.setData({ type: 'FeatureCollection', features: fill(this.transitPool, transit, transitCount, true) })
  }

  private addLayers() {
    const map = this.map
    const before = map.getLayer('buildings-3d') ? 'buildings-3d' : undefined
    const visibility = useAppStore.getState().layerVisibility
    const show = (on: boolean) => (on ? 'visible' : 'none')
    const empty = { type: 'FeatureCollection' as const, features: [] }

    const routes: Feature<LineString>[] = this.lines.map((line) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: line.coordinates },
      properties: { colour: line.colour, mode: line.mode },
    }))
    const stops: Feature<Point>[] = this.lines.flatMap((line) =>
      line.stops.map((coordinates) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates },
        properties: { colour: line.colour, mode: line.mode },
      })),
    )
    map.addSource(ROUTES, { type: 'geojson', data: { type: 'FeatureCollection', features: routes } })
    map.addSource(STOPS, { type: 'geojson', data: { type: 'FeatureCollection', features: stops } })
    map.addSource(AGENTS, { type: 'geojson', data: empty })
    map.addSource(TRANSIT, { type: 'geojson', data: empty })

    map.addLayer(
      {
        id: ROUTES,
        type: 'line',
        source: ROUTES,
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: show(visibility.transitRoutes) },
        paint: {
          'line-color': ['get', 'colour'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 2, 17, 3.5],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.55, 16, 0.35],
        },
      },
      before,
    )
    map.addLayer(
      {
        id: STOPS,
        type: 'circle',
        source: STOPS,
        minzoom: 13.5,
        layout: { visibility: show(visibility.transitRoutes) },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.5, 2, 17, 4.5],
          'circle-color': '#ffffff',
          'circle-stroke-color': ['get', 'colour'],
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13.5, 1, 17, 2],
          'circle-pitch-alignment': 'map',
        },
      },
      before,
    )
    const vehicleLayout = {
      'icon-rotate': ['get', 'b'] as ExpressionSpecification,
      'icon-rotation-alignment': 'map' as const,
      'icon-pitch-alignment': 'map' as const,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    }
    map.addLayer(
      {
        id: 'sim-headlights',
        type: 'symbol',
        source: AGENTS,
        filter: ['<=', ['get', 'k'], Kind.Truck],
        layout: {
          ...vehicleLayout,
          'icon-image': 'beam',
          'icon-anchor': 'bottom',
          // Start the beam at the front of the car (~2.3 m ahead of its centre).
          'icon-offset': [0, -4.6],
          'icon-size': VEHICLE_SIZE,
          visibility: 'none',
        },
        paint: { 'icon-opacity': 0 },
      },
      before,
    )
    map.addLayer(
      {
        id: 'sim-agents',
        type: 'symbol',
        source: AGENTS,
        layout: { ...vehicleLayout, 'icon-image': ['get', 'i'], 'icon-size': AGENT_SIZE, visibility: show(visibility.traffic) },
      },
      before,
    )
    map.addLayer(
      {
        id: 'sim-trains',
        type: 'symbol',
        source: TRANSIT,
        filter: ['==', ['get', 'k'], Kind.TrainCar],
        layout: { ...vehicleLayout, 'icon-image': ['get', 'i'], 'icon-size': TRAIN_SIZE, visibility: show(visibility.transit) },
      },
      before,
    )
    map.addLayer(
      {
        id: 'sim-transit',
        type: 'symbol',
        source: TRANSIT,
        filter: ['==', ['get', 'k'], Kind.Bus],
        layout: {
          ...vehicleLayout,
          'icon-image': ['get', 'i'],
          'icon-size': VEHICLE_SIZE,
          // Line number badge from zoom 15.
          'text-field': ['step', ['zoom'], '', 15, ['get', 'r']],
          'text-font': FONT,
          'text-size': 10,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-rotation-alignment': 'viewport',
          visibility: show(visibility.transit),
        },
        paint: { 'text-color': ['get', 't'], 'text-halo-color': ['get', 'c'], 'text-halo-width': 2.5 },
      },
      before,
    )
  }
}

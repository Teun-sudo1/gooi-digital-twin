import type { Feature, LineString, Point } from 'geojson'
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { useAppStore } from '../../store/useAppStore'
import { useSimulationStore } from '../../store/useSimulationStore'
import {
  AGENT_STRIDE,
  Kind,
  type FromWorker,
  type Intervention,
  type JunctionInfo,
  type Projection,
  type SegmentInfo,
  type ToWorker,
  type TransitLineInfo,
} from '../../types/simulation'
import { AgentLayer, INSTANCE_FLOATS, InstanceFlag, MODEL_MIN_ZOOM } from './agentLayer'
import { agentIcon, CAR_COLOURS, CLOTHING_COLOURS, registerIcons } from './icons'
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

export interface PickResult {
  segment: SegmentInfo | null
  junction: JunctionInfo | null
}

const rgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
const PAINT = CAR_COLOURS.map(rgb)
const CLOTHING = CLOTHING_COLOURS.map(rgb)
const TROUSERS = ['#2b3442', '#3d3a36', '#1f2a44', '#4a4f57'].map(rgb)
const FRAME = rgb('#30343b')
const CARGO = rgb('#e9ecef')
const BUS_BODY = rgb('#f1f3f5')
const TRAIN = [
  [rgb('#ffc917'), rgb('#003082')], // NS
  [rgb('#f1f3f5'), rgb('#c92a2a')], // international
]

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
  private models: AgentLayer | null = null
  private instances = new Float32Array(0)
  private scenario: Intervention[] = []
  private picks = new Map<number, (result: PickResult) => void>()
  private nextPick = 1

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
    // Show the chosen time immediately; cleared once the simulation reports it.
    useSimulationStore.setState({ draftClock: clock })
  }

  /** Replace the road edits in the simulation (an empty list restores the original network). */
  setScenario(interventions: Intervention[]) {
    this.scenario = interventions
    if (this.projection) this.post({ type: 'scenario', interventions })
  }

  /** Nearest street matching `mask` (SegmentFlag bits) or nearest cycling junction, within `radius` metres. */
  pick(target: 'segment' | 'junction', lngLat: [number, number], radius: number, mask = 0): Promise<PickResult> {
    if (!this.projection) return Promise.resolve({ segment: null, junction: null })
    const id = this.nextPick++
    this.post({ type: 'pick', id, target, lngLat, radius, mask })
    return new Promise((resolve) => this.picks.set(id, resolve))
  }

  /** 0 = day, 1 = night: fades vehicle headlights in and out. */
  setNight(night: number) {
    this.night = night
    this.models?.setNight(night)
    if (!this.map.getLayer('sim-headlights')) return
    this.map.setLayoutProperty('sim-headlights', 'visibility', night > 0.05 && this.trafficVisible() ? 'visible' : 'none')
    this.map.setPaintProperty('sim-headlights', 'icon-opacity', Math.min(1, night) * 0.85)
  }

  dispose() {
    this.disposed = true
    this.worker.terminate()
    for (const resolve of this.picks.values()) resolve({ segment: null, junction: null })
    this.picks.clear()
    this.map.off('move', this.onMove)
    this.map.off('moveend', this.sendViewport)
    window.clearTimeout(this.viewportTimer)
    if (!this.map.getStyle()) return
    for (const layer of ['sim-agents-3d', 'sim-trains', 'sim-transit', 'sim-agents', 'sim-headlights', STOPS, ROUTES]) {
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
        if (this.scenario.length) this.post({ type: 'scenario', interventions: this.scenario })
        useSimulationStore.setState({ status: 'ready', lines: message.lines, timetableDate: message.timetableDate })
        break
      case 'error':
        console.error('[simulation]', message.message)
        useSimulationStore.setState({
          status: 'error',
          error: 'The street and transit networks could not be loaded, so the simulation is unavailable.',
        })
        break
      case 'pick':
        this.picks.get(message.id)?.({ segment: message.segment, junction: message.junction })
        this.picks.delete(message.id)
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
        const { draftClock } = useSimulationStore.getState()
        const caughtUp = draftClock === null || Math.abs(((stats.clock - draftClock + 129_600) % 86_400) - 43_200) < 120
        useSimulationStore.setState({ stats, history, draftClock: caughtUp ? null : draftClock })
        break
      }
    }
  }

  private render(agents: Float32Array, agentCount: number, transit: Float32Array, transitCount: number) {
    const projection = this.projection
    if (!projection) return
    // When zoomed out, motion per frame is sub-pixel: redraw ~10× per second to save work.
    const now = performance.now()
    const zoom = this.map.getZoom()
    if (zoom < 13 && now - this.lastRender < 90) return
    this.lastRender = now

    // Close up, agents are 3D models; further out, flat icons (cheaper and easier to see).
    if (zoom >= MODEL_MIN_ZOOM - 0.25) this.renderModels(agents, agentCount, transit, transitCount)
    if (zoom >= MODEL_MIN_ZOOM + 0.25) return

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

  /** Builds per-instance data for the 3D layer, grouped by kind. */
  private renderModels(agents: Float32Array, agentCount: number, transit: Float32Array, transitCount: number) {
    const layer = this.models
    if (!layer) return
    const { traffic, transit: showTransit } = useAppStore.getState().layerVisibility
    const projection = this.projection!
    const kinds = 9
    const counts = new Array<number>(kinds).fill(0)
    const sources: [Float32Array, number][] = []
    if (traffic) sources.push([agents, agentCount])
    if (showTransit) sources.push([transit, transitCount])
    for (const [data, count] of sources) for (let i = 0; i < count; i++) counts[data[i * AGENT_STRIDE + 3]]++
    const starts = new Array<number>(kinds).fill(0)
    for (let k = 1; k < kinds; k++) starts[k] = starts[k - 1] + counts[k - 1]
    const total = starts[kinds - 1] + counts[kinds - 1]
    if (this.instances.length < total * INSTANCE_FLOATS) this.instances = new Float32Array(Math.ceil(total * 1.3) * INSTANCE_FLOATS)
    const out = this.instances
    const fill = [...starts]
    for (const [data, count] of sources) {
      for (let i = 0; i < count; i++) {
        const o = i * AGENT_STRIDE
        const kind = data[o + 3]
        const variant = data[o + 4]
        const flags = data[o + 5]
        const [lng, lat] = toLngLat(projection, data[o], data[o + 1])
        const [dx, dy] = layer.offset(lng, lat)
        let primary: [number, number, number]
        let secondary: [number, number, number]
        if (kind <= Kind.Truck) {
          primary = PAINT[variant] ?? PAINT[0]
          secondary = kind === Kind.Truck ? CARGO : primary
        } else if (kind === Kind.Bike) {
          primary = CLOTHING[variant] ?? CLOTHING[0]
          secondary = FRAME
        } else if (kind === Kind.Pedestrian) {
          primary = CLOTHING[variant] ?? CLOTHING[0]
          secondary = TROUSERS[variant % TROUSERS.length]
        } else if (kind === Kind.Bus) {
          primary = BUS_BODY
          secondary = rgb(this.lines[variant]?.colour ?? '#2f9e6e')
        } else {
          ;[primary, secondary] = TRAIN[flags] ?? TRAIN[0]
        }
        const w = fill[kind]++ * INSTANCE_FLOATS
        out[w] = dx
        out[w + 1] = dy
        out[w + 2] = (data[o + 2] * Math.PI) / 180
        out[w + 3] = primary[0]
        out[w + 4] = primary[1]
        out[w + 5] = primary[2]
        out[w + 6] = secondary[0]
        out[w + 7] = secondary[1]
        out[w + 8] = secondary[2]
        out[w + 9] = kind <= Kind.Truck && flags & 1 ? InstanceFlag.Braking : 0
      }
    }
    layer.setInstances(out.subarray(0, total * INSTANCE_FLOATS), starts, counts)
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
        maxzoom: MODEL_MIN_ZOOM,
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
        maxzoom: MODEL_MIN_ZOOM,
        type: 'symbol',
        source: AGENTS,
        layout: { ...vehicleLayout, 'icon-image': ['get', 'i'], 'icon-size': AGENT_SIZE, visibility: show(visibility.traffic) },
      },
      before,
    )
    map.addLayer(
      {
        id: 'sim-trains',
        maxzoom: MODEL_MIN_ZOOM,
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
        maxzoom: MODEL_MIN_ZOOM,
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
    // 3D models share the depth buffer with the buildings, drawn after them.
    this.models = new AgentLayer(this.projection!.lng0, this.projection!.lat0)
    this.models.setNight(this.night)
    map.addLayer(this.models, map.getLayer('label-water') ? 'label-water' : undefined)
  }
}

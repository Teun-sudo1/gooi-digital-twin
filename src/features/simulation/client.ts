import type { Feature, LineString, Point } from 'geojson'
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { useAppStore } from '../../store/useAppStore'
import { DAY_SLOTS, emptyDay, SLOT_SECONDS, useSimulationStore } from '../../store/useSimulationStore'
import {
  AGENT_STRIDE,
  Kind,
  type FromWorker,
  type Intervention,
  type WeatherEffects,
  type JunctionInfo,
  type Projection,
  type SignalHead,
  type SegmentInfo,
  type ToWorker,
  type TransitLineInfo,
} from '../../types/simulation'
import { LANES } from '../map/style'
import { AgentLayer, INSTANCE_FLOATS, InstanceFlag, MODEL_MIN_ZOOM } from './agentLayer'
import { agentIcon, CAR_COLOURS, CLOTHING_COLOURS, registerIcons } from './icons'
import { fromLngLat, toLngLat } from './network'

const AGENTS = 'sim-agents'
const TRANSIT = 'sim-transit'
const ROUTES = 'transit-routes'
const STOPS = 'transit-stops'
const BUS_LABELS = 'sim-bus-labels'
const FOLLOW_RING = 'sim-follow-ring'
const CONGESTION = 'congestion'
/** Busy → standing: yellow, orange, red. Free-flowing streets aren't coloured. */
export const CONGESTION_COLOURS = ['#e2b203', '#f76808', '#c62a2f']
/** Share of time held up from which a street counts as busy. */
const BUSY = 0.12
const FONT = ['Noto Sans Regular']
/** Traffic lights are drawn within this distance (m) of the view centre. */
const SIGNAL_REACH = 2500
/** Simulated seconds between trend-chart samples. */

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
  private labelPool: Pool = []
  private lastRender = 0
  /** Running totals for the quarter hour the simulation is in. */
  private slot = -1
  private slotSum = { samples: 0, cars: 0, bikes: 0, speed: 0, delayed: 0 }
  private night = 0
  private disposed = false
  private viewportTimer = 0
  private models: AgentLayer | null = null
  private instances = new Float32Array(0)
  private scenario: Intervention[] = []
  /** Latest frame, kept for picking vehicles and following one. */
  private lastAgents: Float32Array = new Float32Array(0)
  private lastAgentCount = 0
  private lastTransit: Float32Array = new Float32Array(0)
  private lastTransitCount = 0
  private signalHeads: SignalHead[] = []
  private signalStates: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private unsubscribe: () => void
  private follow: number | null = null
  private weather: WeatherEffects | null = null
  private congestionGeometry = new Map<number, [number, number][]>()
  private chase = false
  /** Where the followed vehicle is (latest frame); the camera glides towards it every screen frame. */
  private followTarget: { lng: number; lat: number; heading: number } | null = null
  private cameraFrame = 0
  private cameraTime = 0
  private picks = new Map<number, (result: PickResult) => void>()
  private drives = new Map<number, (car: number | null) => void>()
  private rides = new Map<number, (bus: { id: number; lngLat: [number, number] } | null) => void>()
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
      demandUrl: new URL('data/gooi-demand.json', base).href,
      signalsUrl: new URL('data/gooi-signals.json', base).href,
      signals: useAppStore.getState().layerVisibility.trafficLights,
      lanesUrl: new URL('data/gooi-lanes.json', base).href,
      roadGeometryUrl: new URL('data/gooi-road-geometry.json', base).href,
      lanes: useAppStore.getState().layerVisibility.lanes,
      clock: state.startClock,
      density: state.density,
      speed: state.speed,
      playing: true,
    })
    useSimulationStore.setState({ playing: true })
    map.on('move', this.onMove)
    map.on('moveend', this.sendViewport)
    // The Traffic lights toggle switches the lights in the simulation, not just their drawing.
    this.unsubscribe = useAppStore.subscribe((s, prev) => {
      const enabled = s.layerVisibility.trafficLights
      if (enabled !== prev.layerVisibility.trafficLights) this.post({ type: 'signals', enabled })
      const lanes = s.layerVisibility.lanes
      if (lanes !== prev.layerVisibility.lanes) this.post({ type: 'lanes', enabled: lanes })
    })
  }

  setPlaying(playing: boolean) {
    this.post({ type: 'play', playing })
    useSimulationStore.setState({ playing })
  }

  setSpeed(speed: number) {
    this.post({ type: 'speed', speed })
    useSimulationStore.setState({ speed })
  }

  /** Changes the amount of traffic; the day chart starts over, as earlier values no longer compare. */
  setDensity(density: number) {
    this.post({ type: 'density', density })
    this.slot = -1
    useSimulationStore.setState({ density, day: emptyDay() })
  }

  /** Jump to another time of day; the day chart keeps what it has and fills in the new time. */
  setClock(clock: number) {
    this.post({ type: 'clock', clock })
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

  /** Starts a car on a route through the waypoints (lng/lat); resolves to its id to follow, or null. */
  drive(waypoints: [number, number][]): Promise<number | null> {
    if (!this.projection) return Promise.resolve(null)
    const id = this.nextPick++
    this.post({ type: 'drive', id, waypoints })
    return new Promise((resolve) => this.drives.set(id, resolve))
  }

  /** A bus in service with a long way to go, to ride along with; resolves to its id and position, or null. */
  ride(): Promise<{ id: number; lngLat: [number, number] } | null> {
    if (!this.projection) return Promise.resolve(null)
    const id = this.nextPick++
    this.post({ type: 'ride', id })
    return new Promise((resolve) => this.rides.set(id, resolve))
  }

  /** Nearest vehicle to a point within `radius` metres (from the latest frame), or null. */
  pickVehicle(lngLat: [number, number], radius: number): number | null {
    if (!this.projection) return null
    const [x, y] = fromLngLat(this.projection, lngLat[0], lngLat[1])
    let best: number | null = null
    let bestD = radius
    for (const [data, count] of [[this.lastAgents, this.lastAgentCount], [this.lastTransit, this.lastTransitCount]] as const) {
      for (let i = 0; i < count; i++) {
        const o = i * AGENT_STRIDE
        const d = Math.hypot(data[o] - x, data[o + 1] - y)
        if (d < bestD) {
          bestD = d
          best = data[o + 6]
        }
      }
    }
    return best
  }

  /** Follow a vehicle with the camera (null stops). */
  setFollow(id: number | null) {
    this.follow = id
    this.followTarget = null
    this.post({ type: 'follow', id })
    useSimulationStore.setState({ followId: id, followInfo: null })
    if (id === null) this.map.getSource<GeoJSONSource>(FOLLOW_RING)?.setData({ type: 'FeatureCollection', features: [] })
  }

  setWeather(effects: WeatherEffects) {
    this.weather = effects
    this.post({ type: 'weather', effects })
  }

  /** Open the departure board of a stop (null closes it). */
  openStop(stop: { line: number; stop: number } | null) {
    this.post({ type: 'stop', line: stop?.line ?? null, stop: stop?.stop ?? 0 })
    useSimulationStore.setState({ stop, board: null })
  }

  /** Turn the map with the followed vehicle. */
  setChase(chase: boolean) {
    this.chase = chase
    useSimulationStore.setState({ chase })
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
    this.unsubscribe()
    cancelAnimationFrame(this.cameraFrame)
    this.worker.terminate()
    for (const resolve of this.picks.values()) resolve({ segment: null, junction: null })
    this.picks.clear()
    this.map.off('move', this.onMove)
    this.map.off('moveend', this.sendViewport)
    window.clearTimeout(this.viewportTimer)
    if (!this.map.getStyle()) return
    for (const layer of [CONGESTION, FOLLOW_RING, BUS_LABELS, 'sim-agents-3d', 'sim-trains', 'sim-transit', 'sim-agents', 'sim-headlights', STOPS, ROUTES]) {
      if (this.map.getLayer(layer)) this.map.removeLayer(layer)
    }
    for (const source of [AGENTS, TRANSIT, ROUTES, STOPS, BUS_LABELS, FOLLOW_RING, CONGESTION]) {
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
        this.signalHeads = message.signals
        registerIcons(this.map, message.lines)
        this.addLayers()
        this.setNight(this.night)
        this.sendViewport()
        if (this.scenario.length) this.post({ type: 'scenario', interventions: this.scenario })
        if (this.weather) this.post({ type: 'weather', effects: this.weather })
        useSimulationStore.setState({ status: 'ready', lines: message.lines, timetableDate: message.timetableDate })
        break
      case 'laneMarkings':
        this.map.getSource<GeoJSONSource>(LANES)?.setData({
          type: 'FeatureCollection',
          features: message.features.map(({ coordinates, ...properties }) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties })),
        })
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
      case 'drive':
        this.drives.get(message.id)?.(message.car)
        this.drives.delete(message.id)
        break
      case 'ride':
        this.rides.get(message.id)?.(message.bus)
        this.rides.delete(message.id)
        break
      case 'frame':
        this.signalStates = message.signals
        this.lastAgents = message.agents
        this.lastAgentCount = message.agentCount
        this.lastTransit = message.transit
        this.lastTransitCount = message.transitCount
        this.render(message.agents, message.agentCount, message.transit, message.transitCount)
        this.updateFollow()
        this.post({ type: 'ack' })
        break
      case 'follow':
        if (message.id !== this.follow) break
        if (!message.info) {
          // Arrived, or left the modelled area.
          useSimulationStore.setState({ followInfo: null, followGone: true })
          this.setFollow(null)
        } else useSimulationStore.setState({ followInfo: message.info, followGone: false })
        break
      case 'comparison':
        useSimulationStore.setState({ comparison: message.comparison })
        break
      case 'board':
        if (useSimulationStore.getState().stop) useSimulationStore.setState({ board: message.board })
        break
      case 'congestion': {
        for (const { segment, coordinates } of message.geometry) this.congestionGeometry.set(segment, coordinates)
        const features: Feature<LineString>[] = []
        message.segments.forEach((segment, i) => {
          const coordinates = this.congestionGeometry.get(segment)
          if (coordinates) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { level: message.levels[i] } })
        })
        this.map.getSource<GeoJSONSource>(CONGESTION)?.setData({ type: 'FeatureCollection', features })
        break
      }
      case 'stats': {
        const { stats } = message
        // Average the samples per quarter hour; coming back to a quarter hour starts it afresh.
        const slot = Math.floor(stats.clock / SLOT_SECONDS) % DAY_SLOTS
        const sum = this.slotSum
        if (slot !== this.slot) {
          this.slot = slot
          Object.assign(sum, { samples: 0, cars: 0, bikes: 0, speed: 0, delayed: 0 })
        }
        sum.samples++
        sum.cars += stats.cars
        sum.bikes += stats.bikes
        sum.speed += stats.averageCarSpeedKmh
        sum.delayed += stats.delayedCars
        const day = [...useSimulationStore.getState().day]
        day[slot] = {
          clock: slot * SLOT_SECONDS,
          cars: sum.cars / sum.samples,
          bikes: sum.bikes / sum.samples,
          averageCarSpeedKmh: sum.speed / sum.samples,
          delayedCars: sum.delayed / sum.samples,
        }
        const { draftClock } = useSimulationStore.getState()
        const caughtUp = draftClock === null || Math.abs(((stats.clock - draftClock + 129_600) % 86_400) - 43_200) < 120
        useSimulationStore.setState({ stats, day, draftClock: caughtUp ? null : draftClock })
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
    if (zoom >= MODEL_MIN_ZOOM - 0.25) {
      this.renderModels(agents, agentCount, transit, transitCount)
      this.renderBusLabels(transit, transitCount)
    }
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

  /** Keeps the camera on the followed vehicle, easing towards it every frame. */
  private updateFollow() {
    if (this.follow === null || !this.projection) return
    for (const [data, count] of [[this.lastAgents, this.lastAgentCount], [this.lastTransit, this.lastTransitCount]] as const) {
      for (let i = 0; i < count; i++) {
        const o = i * AGENT_STRIDE
        if (data[o + 6] !== this.follow) continue
        const [lng, lat] = toLngLat(this.projection, data[o], data[o + 1])
        // No ring around the car in the cinematic drive.
        const ring = useAppStore.getState().cinematic === 'playing' ? [] : [{ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [lng, lat] }, properties: {} }]
        this.map.getSource<GeoJSONSource>(FOLLOW_RING)?.setData({ type: 'FeatureCollection', features: ring })
        this.followTarget = { lng, lat, heading: data[o + 2] }
        if (!this.cameraFrame) {
          this.cameraTime = performance.now()
          this.cameraFrame = requestAnimationFrame(this.glide)
        }
        return
      }
    }
  }

  /**
   * Eases the camera towards the followed vehicle on every screen frame, by
   * time rather than per simulation frame, so it moves smoothly between
   * frames. In the cinematic drive it eases slowly, smoothing over sharp
   * braking and steering; otherwise it keeps up closely.
   */
  private glide = (now: number) => {
    const target = this.followTarget
    if (this.follow === null || !target || this.disposed) {
      this.cameraFrame = 0
      return
    }
    const dt = Math.min(0.1, (now - this.cameraTime) / 1000)
    this.cameraTime = now
    // Don't fight a zoom or rotate gesture in progress.
    if (!this.map.isZooming() && !this.map.isRotating()) {
      const cinematic = useAppStore.getState().cinematic === 'playing'
      // Seconds for the camera to cover about two thirds of the way to the vehicle, and to turn with it.
      const [move, turn] = cinematic ? [0.9, 2.2] : [0.1, 0.6]
      const center = this.map.getCenter()
      const a = 1 - Math.exp(-dt / move)
      const camera: { center: [number, number]; bearing?: number } = {
        center: [center.lng + (target.lng - center.lng) * a, center.lat + (target.lat - center.lat) * a],
      }
      if (this.chase) {
        const bearing = this.map.getBearing()
        const diff = ((((target.heading - bearing) % 360) + 540) % 360) - 180
        camera.bearing = bearing + diff * (1 - Math.exp(-dt / turn))
      }
      this.map.jumpTo(camera)
    }
    this.cameraFrame = requestAnimationFrame(this.glide)
  }

  /** Line number badges above the 3D buses. */
  private renderBusLabels(transit: Float32Array, transitCount: number) {
    const projection = this.projection!
    let n = 0
    for (let i = 0; i < transitCount; i++) {
      const o = i * AGENT_STRIDE
      if (transit[o + 3] !== Kind.Bus) continue
      const line = this.lines[transit[o + 4]]
      if (!line) continue
      let feature = this.labelPool[n]
      if (!feature) {
        feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }
        this.labelPool[n] = feature
      }
      feature.geometry.coordinates = toLngLat(projection, transit[o], transit[o + 1])
      feature.properties.r = line.ref
      feature.properties.c = line.colour
      feature.properties.t = readableOn(line.colour)
      n++
    }
    this.map.getSource<GeoJSONSource>(BUS_LABELS)?.setData({ type: 'FeatureCollection', features: this.labelPool.slice(0, n) })
  }

  /** Builds per-instance data for the 3D layer, grouped by kind. */
  private renderModels(agents: Float32Array, agentCount: number, transit: Float32Array, transitCount: number) {
    const layer = this.models
    if (!layer) return
    const { traffic, transit: showTransit, trafficLights } = useAppStore.getState().layerVisibility
    const projection = this.projection!
    const kinds = 10
    const counts = new Array<number>(kinds).fill(0)
    const sources: [Float32Array, number][] = []
    if (traffic) sources.push([agents, agentCount])
    if (showTransit) sources.push([transit, transitCount])
    for (const [data, count] of sources) for (let i = 0; i < count; i++) counts[data[i * AGENT_STRIDE + 3]]++
    // Traffic lights near the view centre.
    const centre = this.map.getCenter()
    const [cx, cy] = fromLngLat(projection, centre.lng, centre.lat)
    const lights: number[] = []
    if (trafficLights) {
      this.signalHeads.forEach((head, i) => {
        if (Math.hypot(head.x - cx, head.y - cy) < SIGNAL_REACH) lights.push(i)
      })
    }
    counts[Kind.TrafficLight] = lights.length
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
        out[w + 9] = (kind <= Kind.Truck || kind === Kind.Bus) && flags & 1 ? InstanceFlag.Braking : 0
      }
    }
    for (const i of lights) {
      const head = this.signalHeads[i]
      const [lng, lat] = toLngLat(projection, head.x, head.y)
      const [dx, dy] = layer.offset(lng, lat)
      const w = fill[Kind.TrafficLight]++ * INSTANCE_FLOATS
      out.fill(0, w, w + INSTANCE_FLOATS)
      out[w] = dx
      out[w + 1] = dy
      out[w + 2] = (head.bearing * Math.PI) / 180
      // The shader reads the light's state (0 green, 1 amber, 2 red) from the flags.
      out[w + 9] = this.signalStates[i] ?? 2
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
      line.stops.map((coordinates, s) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates },
        properties: { colour: line.colour, mode: line.mode, l: line.index, s },
      })),
    )
    // How congested each street is, under everything else the simulation draws.
    map.addSource(CONGESTION, { type: 'geojson', data: empty })
    map.addLayer(
      {
        id: CONGESTION,
        type: 'line',
        source: CONGESTION,
        minzoom: 11,
        filter: ['>=', ['get', 'level'], BUSY],
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: show(visibility.congestion) },
        paint: {
          'line-color': [
            'interpolate', ['linear'], ['get', 'level'],
            BUSY, CONGESTION_COLOURS[0], 0.35, CONGESTION_COLOURS[1], 0.6, CONGESTION_COLOURS[2],
          ],
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 1.5, 14, 3, 17, 6],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 17, 0.55],
        },
      },
      before,
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
    // Below the trees (scenery-3d), which can be made see-through.
    map.addLayer(this.models, map.getLayer('scenery-3d') ? 'scenery-3d' : map.getLayer('label-water') ? 'label-water' : undefined)

    // A ring on the ground around the followed vehicle.
    map.addSource(FOLLOW_RING, { type: 'geojson', data: empty })
    map.addLayer(
      {
        id: FOLLOW_RING,
        type: 'circle',
        source: FOLLOW_RING,
        paint: {
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 12, 7, 16, 14, 18, 40, 20, 150],
          'circle-color': 'rgba(0, 0, 0, 0)',
          'circle-stroke-color': '#7cc4ff',
          'circle-stroke-width': 2.5,
          'circle-pitch-alignment': 'map',
        },
      },
      before,
    )

    // Line numbers float above the 3D buses, on top of everything.
    map.addSource(BUS_LABELS, { type: 'geojson', data: empty })
    map.addLayer({
      id: BUS_LABELS,
      type: 'symbol',
      source: BUS_LABELS,
      minzoom: MODEL_MIN_ZOOM,
      layout: {
        'icon-image': ['concat', 'badge-', ['get', 'c']],
        'icon-text-fit': 'both',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'text-field': ['get', 'r'],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 18, 14],
        'text-anchor': 'bottom',
        'text-offset': [0, -1.1],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        visibility: show(visibility.transit),
      },
      paint: { 'text-color': ['get', 't'] },
    })
  }
}

/*
 * Domain types for the simulation. All traffic and travellers produced from
 * these types are SIMULATED. Only the networks themselves (streets, paths,
 * one-way rules, speed limits, bus and train routes and stops) come from
 * OpenStreetMap.
 */

/** Travel modes on the street network. Buses may use car streets and bus-only streets. */
export const Mode = { Car: 0, Bike: 1, Foot: 2, Bus: 3 } as const
export type Mode = (typeof Mode)[keyof typeof Mode]

/**
 * Agent kinds, shared by the worker (simulation) and the main thread
 * (icons). Numeric so frames can be sent as typed arrays.
 */
export const Kind = {
  Hatchback: 0,
  Sedan: 1,
  Suv: 2,
  Van: 3,
  Truck: 4,
  Bike: 5,
  Pedestrian: 6,
  Bus: 7,
  TrainCar: 8,
  TrafficLight: 9,
} as const
export type Kind = (typeof Kind)[keyof typeof Kind]

/** Per-segment permission flags, as written by scripts/fetch-osm.mjs. */
export const SegmentFlag = {
  CarForward: 1,
  CarBackward: 2,
  BikeForward: 4,
  BikeBackward: 8,
  Foot: 16,
  Roundabout: 32,
} as const

export interface Projection {
  lng0: number
  lat0: number
  /** Metres per degree of longitude / latitude at the centre. */
  kx: number
  ky: number
  /** Size of one stored coordinate unit in metres (0.1 = decimetres). */
  unit: number
}

/** public/data/gooi-network.json: column-oriented to keep the file small. */
export interface NetworkFile {
  meta: {
    description: string
    source: string
    license: string
    osmTimestamp: string | null
    generated: string
    /** west, south, east, north */
    bbox: [number, number, number, number]
    projection: Projection
  }
  classes: string[]
  names: string[]
  /** Flat [x0, y0, x1, y1, …] junction positions in projection units. */
  nodes: number[]
  segments: {
    from: number[]
    to: number[]
    cls: number[]
    name: number[]
    /** Car speed limit in km/h (0 when cars are not allowed). */
    speed: number[]
    flags: number[]
    way: number[]
    /** Interior points per segment, delta-encoded from the from-node. */
    geom: number[][]
  }
}

/** public/data/gooi-demand.json: CBS figures per neighbourhood (scripts/fetch-demand.mjs). */
export interface DemandFile {
  meta: { source: string; license: string; year: number; projection: Projection }
  areas: {
    code: string
    name: string
    municipality: string
    population: number
    businesses: number
    /** Outer rings in integer local metres, delta-encoded. */
    rings: number[][]
  }[]
}

/** How the weather changes travel, relative to dry weather (assumed). */
export interface WeatherEffects {
  carDemand: number
  bikeDemand: number
  carSpeed: number
  bikeSpeed: number
  busDemand: number
}

export interface TransitLineRecord {
  /** OSM relation id. */
  id: number
  mode: 'bus' | 'train'
  ref: string
  name: string
  from: string | null
  to: string | null
  operator: string | null
  colour: string | null
  /** Minutes between departures from the OSM interval tag, when mapped. */
  interval: number | null
  length: number
  /** Delta-encoded polyline in projection units. */
  geom: number[]
  /** Stop positions as metres along the line. */
  stops: number[]
  /** Stop names from the timetable feed, per stop (null when no timetable stop is near). */
  stopNames?: (string | null)[]
  /**
   * Real scheduled trips on the timetable's service day (from GTFS), each as
   * flat [seconds since midnight, metres along the line, …] anchor pairs.
   */
  trips?: number[][]
}

export interface TransitFile {
  meta: {
    source: string
    license: string
    osmTimestamp: string | null
    projection: Projection
    note: string
    /** Present when real timetables were added by scripts/fetch-timetables.mjs. */
    timetable?: { source: string; license: string; serviceDate: string; feedVersion: string }
  }
  lines: TransitLineRecord[]
}

/** Public description of a line, sent to the main thread for map display and legends. */
export interface TransitLineInfo {
  index: number
  id: number
  mode: 'bus' | 'train'
  ref: string
  name: string
  colour: string
  /** First and final stop, from OSM. */
  from: string | null
  to: string | null
  /** Where departures come from: a real GTFS timetable, an OSM interval tag, or an assumption. */
  schedule: 'timetable' | 'osm-interval' | 'assumed'
  /** Departures per day (timetable) or minutes between departures (otherwise). */
  tripsPerDay: number
  coordinates: [number, number][]
  /** Stop positions (lng, lat). */
  stops: [number, number][]
}

// ---------------------------------------------------------------------------
// Scenarios: changes to the street network made on the map (milestone 3)

/** Who may still use a street after an edit. Buses are timetable-driven and unaffected. */
/** `removed`: gone completely, from the map as well as from traffic. */
export type RoadAccess = 'closed' | 'removed' | 'no-cars' | 'foot-only' | 'bus-only'

/** Kinds of road that can be added (OSM highway classes). */
export type NewRoadType = 'cycleway' | 'residential' | 'tertiary' | 'primary'

export type Intervention =
  | { kind: 'access'; segment: number; access: RoadAccess }
  | { kind: 'speed'; segment: number; kmh: number }
  /**
   * A new road between two junctions, along `points` (lng/lat, without the junctions).
   * Cycle paths are two-way and open to pedestrians; streets also to bikes; main roads to cars only.
   * `lanes` is per direction; a one-way road runs from `from` to `to`.
   */
  | {
      kind: 'new-road'
      id: string
      road: NewRoadType
      from: number
      to: number
      points: [number, number][]
      kmh: number
      lanes: number
      oneway: boolean
    }

/** A street segment found under the pointer, described for the map and the edit list. */
export interface SegmentInfo {
  segment: number
  /** Set when the segment is a road added in the scenario. */
  roadId: string | null
  name: string | null
  roadClass: string
  coordinates: [number, number][]
  car: boolean
  bike: boolean
  foot: boolean
  /** Speed limit in the original network (0 when cars are not allowed). */
  speedKmh: number
}

export interface JunctionInfo {
  node: number
  coordinates: [number, number]
}

export interface SimulationStats {
  /** Simulated seconds since midnight. */
  clock: number
  cars: number
  bikes: number
  /** Pedestrians are only simulated around the current view. */
  pedestrians: number
  buses: number
  trains: number
  averageCarSpeedKmh: number
  averageBikeSpeedKmh: number
  averageCarJourneyMinutes: number | null
  delayedCars: number
  carKilometres: number
  bikeKilometres: number
  /** Cars only; see CO2_KG_PER_KM. */
  estimatedCo2Kg: number
  /** Average delay of buses in service against the timetable (null without buses). */
  busDelayMinutes: number | null
  /** Buses running three minutes late or more. */
  busesLate: number
  /** Buses on a diversion around a closed road. */
  busDetours: number
  /** Trips given a new route because of the current road changes. */
  reroutedTrips: number
  /** Trips that lost every way to their destination and left the network. */
  strandedTrips: number
}

// ---------------------------------------------------------------------------
// Worker messages

export interface Viewport {
  /** Visible area in local metres. */
  minX: number
  minY: number
  maxX: number
  maxY: number
  zoom: number
}

export type ToWorker =
  | { type: 'init'; networkUrl: string; transitUrl: string; demandUrl: string; signalsUrl: string; signals: boolean; lanesUrl: string; lanes: boolean; clock: number; density: number; speed: number; playing: boolean }
  | { type: 'play'; playing: boolean }
  | { type: 'speed'; speed: number }
  | { type: 'density'; density: number }
  | { type: 'clock'; clock: number }
  | { type: 'viewport'; viewport: Viewport }
  | { type: 'ack' }
  | { type: 'scenario'; interventions: Intervention[] }
  /** Follow one vehicle: its details are reported and it is always in the frame. */
  | { type: 'follow'; id: number | null }
  | { type: 'weather'; effects: WeatherEffects }
  /** Traffic lights on, or right-of-way rules at every junction. */
  | { type: 'signals'; enabled: boolean }
  /** Lanes from the map data, or one lane per direction everywhere. */
  | { type: 'lanes'; enabled: boolean }
  /** Show the departure board of a line's stop (null closes it). */
  | { type: 'stop'; line: number | null; stop: number }
  /** Find the street (or junction) nearest to a point, within `radius` metres. */
  | { type: 'pick'; id: number; target: 'segment' | 'junction'; lngLat: [number, number]; radius: number; mask: number }

/** Floats per agent in a frame: x, y, bearing, kind, colour, flags, id. */
export const AGENT_STRIDE = 7
/** Flag bits in a frame. */
export const AgentFlag = { Braking: 1, Delayed: 2 } as const

/** Details of a followed vehicle. */
export type FollowInfo =
  | {
      type: 'road'
      id: number
      vehicle: Kind
      speedKmh: number
      street: string | null
      destination: string | null
      remainingKm: number
      tripMinutes: number
      delayed: boolean
    }
  | {
      type: 'bus' | 'train'
      id: number
      /** Index into the transit lines. */
      line: number
      speedKmh: number
      /** Against the timetable, in minutes (trains run exactly to time). */
      delayMinutes: number
      nextStop: string | null
      /** Scheduled time at the next stop, seconds since midnight. */
      nextStopTime: number | null
      detour: boolean
      /** Simulated passengers on board (buses; assumed demand), and how many fit. */
      onBoard: number | null
      capacity: number | null
      /** The whole line as a schematic loop (buses only). */
      route: RouteDiagram | null
    }

/** One direction of a bus line for the route diagram. */
export interface RouteSide {
  /** Index into the transit lines. */
  line: number
  /** Stops in order, with simulated waiting passengers (assumed demand). */
  stops: { name: string | null; waiting: number }[]
  /** Buses on this direction: position in stops (fractional: 2.5 = halfway between the third and fourth stop). */
  buses: { id: number; at: number; delayMinutes: number }[]
}

/** A departure board for a stop (all lines within a short walk). */
export interface StopBoard {
  name: string | null
  /** Line indices serving the stop (one per line number). */
  lines: number[]
  /** Simulated passengers waiting, and those left behind by the last full bus. */
  waiting: number
  leftBehind: number
  departures: {
    /** Scheduled time, seconds since midnight. */
    time: number
    line: number
    to: string | null
    /** The bus on its way, when it is already running (null for trains and later trips). */
    busId: number | null
    delayMinutes: number
    status: 'scheduled' | 'approaching' | 'at-stop'
  }[]
}

export interface RouteDiagram {
  forward: RouteSide
  /** The return direction, when it is mapped. */
  back: RouteSide | null
}

/** Mapped traffic signals (public/data/gooi-signals.json), in local metres. */
export interface SignalsFile {
  attribution: string
  points: [number, number][]
}

/** A traffic light head, in local metres, facing `bearing` (degrees). */
export interface SignalHead {
  x: number
  y: number
  bearing: number
}

/** One side of a before/after comparison, measured since the last road change. */
export interface ComparisonSide {
  journeyMinutes: number | null
  carSpeedKmh: number
  carKmPerHour: number
  /** Share of car time spent below 40% of the limit. */
  delayedShare: number
  co2KgPerHour: number
  busDelayMinutes: number | null
}

/** Cars per hour on a street segment in both runs (geometry is sent the first time only). */
export interface StreetChange {
  segment: number
  coordinates?: [number, number][]
  original: number
  scenario: number
}

export interface Comparison {
  /** Simulated minutes since the last road change. */
  minutes: number
  original: ComparisonSide
  scenario: ComparisonSide
  streets: StreetChange[]
}

export type FromWorker =
  | { type: 'ready'; projection: Projection; lines: TransitLineInfo[]; timetableDate: string | null; signals: SignalHead[] }
  | { type: 'error'; message: string }
  /** Road surfaces and lane lines of multi-lane roads, as GeoJSON lines (lng/lat). */
  | { type: 'laneMarkings'; features: { coordinates: [number, number][]; kind: string; offset: number; width: number; motorway: boolean }[] }
  | { type: 'frame'; agents: Float32Array; agentCount: number; transit: Float32Array; transitCount: number; signals: Uint8Array }
  | { type: 'follow'; id: number; info: FollowInfo | null }
  | { type: 'comparison'; comparison: Comparison | null }
  | { type: 'board'; board: StopBoard | null }
  /**
   * How congested streets are: per segment, the share of car time spent held up
   * (0 = free flowing, 1 = standing). Geometry is sent the first time a segment appears.
   */
  | { type: 'congestion'; segments: Int32Array; levels: Float32Array; geometry: { segment: number; coordinates: [number, number][] }[] }
  | { type: 'stats'; stats: SimulationStats }
  | { type: 'pick'; id: number; segment: SegmentInfo | null; junction: JunctionInfo | null }

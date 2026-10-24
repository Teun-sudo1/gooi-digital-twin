/*
 * Domain types for the simulation. All traffic and travellers produced from
 * these types are SIMULATED. Only the networks themselves (streets, paths,
 * one-way rules, speed limits, bus and train routes and stops) come from
 * OpenStreetMap.
 */

/** Travel modes on the street network. */
export const Mode = { Car: 0, Bike: 1, Foot: 2 } as const
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
  /** Where departures come from: a real GTFS timetable, an OSM interval tag, or an assumption. */
  schedule: 'timetable' | 'osm-interval' | 'assumed'
  /** Departures per day (timetable) or minutes between departures (otherwise). */
  tripsPerDay: number
  coordinates: [number, number][]
  /** Stop positions (lng, lat). */
  stops: [number, number][]
}

export type Intervention =
  | { kind: 'close-road'; segment: number }
  | { kind: 'speed-limit'; segment: number; speedLimitKmh: number }

export interface Scenario {
  id: string
  name: string
  interventions: Intervention[]
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
  | { type: 'init'; networkUrl: string; transitUrl: string; clock: number; density: number; speed: number; playing: boolean }
  | { type: 'play'; playing: boolean }
  | { type: 'speed'; speed: number }
  | { type: 'density'; density: number }
  | { type: 'clock'; clock: number }
  | { type: 'viewport'; viewport: Viewport }
  | { type: 'ack' }

/** Floats per agent in a frame: x, y, bearing, kind, colour, flags. */
export const AGENT_STRIDE = 6
/** Flag bits in a frame. */
export const AgentFlag = { Braking: 1, Delayed: 2 } as const

export type FromWorker =
  | { type: 'ready'; projection: Projection; lines: TransitLineInfo[]; timetableDate: string | null }
  | { type: 'error'; message: string }
  | { type: 'frame'; agents: Float32Array; agentCount: number; transit: Float32Array; transitCount: number }
  | { type: 'stats'; stats: SimulationStats }

/*
 * Domain types for the traffic simulation and scenario editing. All traffic
 * produced from these types is SIMULATED. Only the road network itself
 * (geometry, one-way rules, speed limits) comes from OpenStreetMap.
 */
import type { LngLat } from './geo'

export type RoadClass =
  | 'motorway'
  | 'motorway_link'
  | 'trunk'
  | 'trunk_link'
  | 'primary'
  | 'primary_link'
  | 'secondary'
  | 'secondary_link'
  | 'tertiary'
  | 'tertiary_link'
  | 'unclassified'
  | 'residential'
  | 'living_street'

/** One road segment between two junctions, as stored in public/data/huizen-roads.json. */
export interface RoadSegmentRecord {
  id: string
  /** OpenStreetMap way id the segment was cut from, for traceability. */
  way: number
  name: string | null
  class: RoadClass
  speed: number
  /** 'osm' when taken from a maxspeed tag, 'default' when assumed from the road class. */
  speedSource: 'osm' | 'default'
  /** True when only drivable from `from` to `to`. */
  oneway: boolean
  /** Part of a roundabout, where circulating traffic has priority. */
  roundabout: boolean
  from: number
  to: number
  length: number
  coords: LngLat[]
}

export interface RoadNetworkFile {
  meta: {
    description: string
    source: string
    license: string
    osmTimestamp: string | null
    bbox: [number, number, number, number]
    generated: string
  }
  /** Junction positions, indexed by RoadSegmentRecord.from / .to. */
  nodes: LngLat[]
  segments: RoadSegmentRecord[]
}

/** A junction (or dead end) in the routable graph. */
export interface Intersection {
  id: number
  position: LngLat
  /** Local metric coordinates (see RoadGraph.project). */
  x: number
  y: number
  outgoing: number[]
  incoming: number[]
}

/**
 * A directed, drivable edge. A two-way street becomes two Roads sharing one
 * segmentId, so closing a segment closes both directions.
 */
export interface Road {
  id: number
  segmentId: string
  name: string | null
  roadClass: RoadClass
  from: number
  to: number
  /** Polyline in local metres, plus cumulative distance at each vertex. */
  xs: Float64Array
  ys: Float64Array
  cumulative: Float64Array
  lengthMeters: number
  speedLimitMs: number
  twoWay: boolean
  /** Right-of-way rank at the junction this road leads into; higher goes first. */
  priority: number
  /** Heading in radians (atan2 of dy, dx) at the start and end of the edge. */
  startHeading: number
  endHeading: number
}

export interface Route {
  roads: number[]
  lengthMeters: number
  freeFlowSeconds: number
}

export interface Vehicle {
  id: number
  route: Route
  /** Index into route.roads of the edge currently being driven. */
  routeIndex: number
  /** Metres travelled along the current edge. */
  offset: number
  /** Current speed in m/s. */
  speed: number
  /** Personal speed preference relative to the limit (e.g. 0.9 = drives 10% under). */
  desiredFactor: number
  departedAt: number
  /** Simulated seconds spent well below the speed limit. */
  slowFor: number
}

export type Intervention =
  | { kind: 'close-road'; segmentId: string }
  | { kind: 'speed-limit'; segmentId: string; speedLimitKmh: number }

export interface Scenario {
  id: string
  name: string
  interventions: Intervention[]
}

export interface SimulationStats {
  /** Simulated seconds since midnight. */
  clock: number
  activeVehicles: number
  averageSpeedKmh: number
  averageJourneyMinutes: number | null
  delayedVehicles: number
  totalDistanceKm: number
  estimatedCo2Kg: number
  completedTrips: number
}

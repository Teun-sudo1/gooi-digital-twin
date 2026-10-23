/*
 * Domain types for the traffic simulation (milestone 2) and scenario editing
 * (milestone 3). They are defined up front so map, simulation and scenario code
 * share one vocabulary, but nothing consumes them yet.
 */
import type { LngLat } from './geo'

export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'

/** A node in the routable road graph: a junction or a dead end. */
export interface Intersection {
  id: string
  position: LngLat
  /** Ids of the road segments that meet here. */
  roadIds: string[]
}

/** A directed edge between two intersections, following real road geometry. */
export interface Road {
  id: string
  /** OpenStreetMap way id the segment was derived from, for traceability. */
  osmWayId: number
  name?: string
  roadClass: RoadClass
  from: string
  to: string
  geometry: LngLat[]
  lengthMeters: number
  speedLimitKmh: number
  oneway: boolean
}

export interface Route {
  roadIds: string[]
  lengthMeters: number
}

export interface Vehicle {
  id: string
  route: Route
  /** Index into route.roadIds of the segment currently being driven. */
  segmentIndex: number
  /** Distance travelled along the current segment, in metres. */
  offsetMeters: number
  speedMs: number
  departedAt: number
}

export type Intervention =
  | { kind: 'close-road'; roadId: string }
  | { kind: 'speed-limit'; roadId: string; speedLimitKmh: number }

export interface Scenario {
  id: string
  name: string
  interventions: Intervention[]
}

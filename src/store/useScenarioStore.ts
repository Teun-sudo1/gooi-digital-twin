import { create } from 'zustand'
import type { Intervention, JunctionInfo, NewRoadType, RoadAccess, SegmentInfo } from '../types/simulation'

/** Editing tools in the road-changes panel. */
export type ScenarioTool = RoadAccess | 'speed' | 'new-road' | 'erase'

/** Changes to one existing street. */
export interface RoadEdit {
  segment: number
  name: string | null
  roadClass: string
  coordinates: [number, number][]
  access: RoadAccess | null
  speedKmh: number | null
  originalSpeedKmh: number
  /** For ordering the list, newest first. */
  order: number
}

/** How a new road is built (set in the panel before drawing). */
export interface RoadOptions {
  road: NewRoadType
  /** Per direction. */
  lanes: number
  kmh: number
  /** One-way in the drawing direction. */
  oneway: boolean
  /** A smooth curve through the clicked points rather than straight pieces. */
  curved: boolean
}

export interface NewRoad extends Omit<RoadOptions, 'curved'> {
  id: string
  from: number
  to: number
  /** Full line, including both junctions (already smoothed when drawn curved). */
  coordinates: [number, number][]
  lengthMeters: number
  order: number
}

/** A road being drawn: starts at a junction, then the clicked points. */
export interface RoadDraft {
  start: JunctionInfo
  points: [number, number][]
}

export const SPEED_CHOICES = [30, 50, 60, 80, 100]

/** Usual limit and lanes for each kind of new road. */
export const ROAD_DEFAULTS: Record<NewRoadType, { kmh: number; lanes: number }> = {
  cycleway: { kmh: 0, lanes: 1 },
  residential: { kmh: 30, lanes: 1 },
  tertiary: { kmh: 50, lanes: 1 },
  primary: { kmh: 80, lanes: 2 },
}

interface ScenarioState {
  tool: ScenarioTool | null
  speedKmh: number
  edits: Record<number, RoadEdit>
  roads: NewRoad[]
  roadOptions: RoadOptions
  draft: RoadDraft | null
  /** Street under the pointer for the active tool. */
  hover: SegmentInfo | null
  /** Short feedback for the last click that could not be applied. */
  message: string | null

  setTool: (tool: ScenarioTool | null) => void
  setSpeed: (kmh: number) => void
  /** Apply the active tool to a street; applying the same change again undoes it. */
  applyToSegment: (info: SegmentInfo) => void
  removeEdit: (segment: number) => void
  addRoad: (road: Omit<NewRoad, 'id' | 'order'>) => void
  removeRoad: (id: string) => void
  setRoadOptions: (options: Partial<RoadOptions>) => void
  setDraft: (draft: RoadDraft | null) => void
  setHover: (hover: SegmentInfo | null) => void
  setMessage: (message: string | null) => void
  /** Restore the original network. */
  reset: () => void
}

let order = 0

export const useScenarioStore = create<ScenarioState>((set, get) => ({
  tool: null,
  speedKmh: 30,
  edits: {},
  roads: [],
  roadOptions: { road: 'residential', lanes: 1, kmh: 30, oneway: false, curved: true },
  draft: null,
  hover: null,
  message: null,

  setTool: (tool) => set({ tool: get().tool === tool ? null : tool, draft: null, hover: null, message: null }),
  setSpeed: (speedKmh) => set({ speedKmh }),
  applyToSegment: (info) => {
    const { tool, speedKmh, edits } = get()
    if (!tool || tool === 'new-road') return
    if (info.roadId) {
      // A road added in this scenario is simply taken away again.
      if (tool === 'erase' || tool === 'removed') get().removeRoad(info.roadId)
      else set({ message: 'New roads can only be removed. Draw it again with other settings.' })
      return
    }
    if (tool === 'erase') {
      get().removeEdit(info.segment)
      return
    }
    const current: RoadEdit = edits[info.segment] ?? {
      segment: info.segment,
      name: info.name,
      roadClass: info.roadClass,
      coordinates: info.coordinates,
      access: null,
      speedKmh: null,
      originalSpeedKmh: info.speedKmh,
      order: 0,
    }
    const next = { ...current, order: ++order }
    if (tool === 'speed') next.speedKmh = current.speedKmh === speedKmh || info.speedKmh === speedKmh ? null : speedKmh
    else next.access = current.access === tool ? null : tool
    const rest = { ...edits }
    delete rest[info.segment]
    set({ edits: next.access || next.speedKmh ? { ...rest, [info.segment]: next } : rest, message: null })
  },
  removeEdit: (segment) => {
    const rest = { ...get().edits }
    delete rest[segment]
    set({ edits: rest })
  },
  addRoad: (road) => set({ roads: [...get().roads, { ...road, id: `road-${Date.now()}-${++order}`, order }], draft: null }),
  removeRoad: (id) => set({ roads: get().roads.filter((r) => r.id !== id) }),
  setRoadOptions: (options) => {
    const next = { ...get().roadOptions, ...options }
    // A new kind of road starts from its usual limit and lanes.
    if (options.road && options.road !== get().roadOptions.road) Object.assign(next, ROAD_DEFAULTS[options.road])
    set({ roadOptions: next })
  },
  setDraft: (draft) => set({ draft }),
  setHover: (hover) => set({ hover }),
  setMessage: (message) => set({ message }),
  reset: () => set({ edits: {}, roads: [], draft: null, message: null }),
}))

/** The scenario as sent to the simulation worker. */
export function toInterventions(edits: Record<number, RoadEdit>, roads: NewRoad[]): Intervention[] {
  const list: Intervention[] = []
  for (const edit of Object.values(edits)) {
    if (edit.access) list.push({ kind: 'access', segment: edit.segment, access: edit.access })
    if (edit.speedKmh) list.push({ kind: 'speed', segment: edit.segment, kmh: edit.speedKmh })
  }
  for (const road of roads) {
    list.push({
      kind: 'new-road',
      id: road.id,
      road: road.road,
      from: road.from,
      to: road.to,
      points: road.coordinates.slice(1, -1),
      kmh: road.kmh,
      lanes: road.road === 'cycleway' ? 1 : road.lanes,
      oneway: road.road !== 'cycleway' && road.oneway,
    })
  }
  return list
}

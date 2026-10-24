import { create } from 'zustand'
import type { Intervention, JunctionInfo, RoadAccess, SegmentInfo } from '../types/simulation'

/** Editing tools in the road-changes panel. */
export type ScenarioTool = RoadAccess | 'speed' | 'cycle-path' | 'erase'

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

export interface CyclePath {
  id: string
  from: number
  to: number
  /** Full line, including both junctions. */
  coordinates: [number, number][]
  lengthMeters: number
  order: number
}

/** A cycle path being drawn: starts at a junction, then free bends. */
export interface CyclePathDraft {
  start: JunctionInfo
  points: [number, number][]
}

export const SPEED_CHOICES = [30, 50, 60, 80, 100]

interface ScenarioState {
  tool: ScenarioTool | null
  speedKmh: number
  edits: Record<number, RoadEdit>
  paths: CyclePath[]
  draft: CyclePathDraft | null
  /** Street under the pointer for the active tool. */
  hover: SegmentInfo | null
  /** Short feedback for the last click that could not be applied. */
  message: string | null

  setTool: (tool: ScenarioTool | null) => void
  setSpeed: (kmh: number) => void
  /** Apply the active tool to a street; applying the same change again undoes it. */
  applyToSegment: (info: SegmentInfo) => void
  removeEdit: (segment: number) => void
  addPath: (path: Omit<CyclePath, 'id' | 'order'>) => void
  removePath: (id: string) => void
  setDraft: (draft: CyclePathDraft | null) => void
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
  paths: [],
  draft: null,
  hover: null,
  message: null,

  setTool: (tool) => set({ tool: get().tool === tool ? null : tool, draft: null, hover: null, message: null }),
  setSpeed: (speedKmh) => set({ speedKmh }),
  applyToSegment: (info) => {
    const { tool, speedKmh, edits } = get()
    if (!tool || tool === 'cycle-path') return
    if (tool === 'erase') {
      if (info.pathId) get().removePath(info.pathId)
      else get().removeEdit(info.segment)
      return
    }
    if (info.pathId) {
      set({ message: 'New cycle paths can only be removed.' })
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
  addPath: (path) => set({ paths: [...get().paths, { ...path, id: `path-${Date.now()}-${++order}`, order }], draft: null }),
  removePath: (id) => set({ paths: get().paths.filter((p) => p.id !== id) }),
  setDraft: (draft) => set({ draft }),
  setHover: (hover) => set({ hover }),
  setMessage: (message) => set({ message }),
  reset: () => set({ edits: {}, paths: [], draft: null, message: null }),
}))

/** The scenario as sent to the simulation worker. */
export function toInterventions(edits: Record<number, RoadEdit>, paths: CyclePath[]): Intervention[] {
  const list: Intervention[] = []
  for (const edit of Object.values(edits)) {
    if (edit.access) list.push({ kind: 'access', segment: edit.segment, access: edit.access })
    if (edit.speedKmh) list.push({ kind: 'speed', segment: edit.segment, kmh: edit.speedKmh })
  }
  for (const path of paths) {
    list.push({ kind: 'cycle-path', id: path.id, from: path.from, to: path.to, points: path.coordinates.slice(1, -1) })
  }
  return list
}

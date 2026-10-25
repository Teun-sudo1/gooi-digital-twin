import type { MapMouseEvent, Map as MapLibreMap, PointLike } from 'maplibre-gl'
import { useEffect } from 'react'
import { useMapInstance } from '../../hooks/useMapInstance'
import { toInterventions, useScenarioStore } from '../../store/useScenarioStore'
import { useSimulationStore } from '../../store/useSimulationStore'
import type { SegmentInfo } from '../../types/simulation'
import type { SimulationClient } from '../simulation/client'
import { lineLength, smoothLine } from './curves'
import { addScenarioLayers, EDITS, removeScenarioLayers, showDraft, showEdits, showHover } from './scenarioLayers'
import { TOOL_BY_ID } from './tools'

/** Pick tolerance around the pointer, in screen pixels. */
const PICK_PX = 14
const SNAP_PX = 26
/** A second click this close to the last bend finishes the road (a double-click). */
const FINISH_PX = 10

/** Metres between two points (equirectangular; fine at street scale). */
export function metresBetween(a: [number, number], b: [number, number]) {
  const kx = 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110_574)
}

/** Ground distance covered by `px` screen pixels at a point (accounts for pitch). */
function radiusAt(map: MapLibreMap, point: { x: number; y: number }, px: number) {
  const a = map.unproject([point.x, point.y])
  const b = map.unproject([point.x + px, point.y])
  return metresBetween([a.lng, a.lat], [b.lng, b.lat])
}

const lngLatOf = (event: MapMouseEvent): [number, number] => [event.lngLat.lng, event.lngLat.lat]

/**
 * Road editing on the map: highlights the street under the pointer for the
 * active tool, applies the tool on click, draws new roads, and keeps
 * the simulation and the edit layers in sync with the scenario store.
 */
export function useScenarioEditing() {
  const map = useMapInstance()
  const controller = useSimulationStore((s) => (s.status === 'ready' ? s.controller : null))

  // Edit layers, and sending the scenario to the simulation.
  useEffect(() => {
    if (!map || !controller) return
    addScenarioLayers(map)
    const sync = () => {
      const { edits, roads } = useScenarioStore.getState()
      showEdits(map, Object.values(edits).sort((a, b) => a.order - b.order), roads)
      controller.setScenario(toInterventions(edits, roads))
    }
    sync()
    const unsubscribe = useScenarioStore.subscribe((state, previous) => {
      if (state.edits !== previous.edits || state.roads !== previous.roads) sync()
    })
    return () => {
      unsubscribe()
      removeScenarioLayers(map)
    }
  }, [map, controller])

  // Pointer interaction while a tool is active.
  useEffect(() => {
    if (!map || !controller) return
    return attachEditing(map, controller)
  }, [map, controller])
}

function attachEditing(map: MapLibreMap, controller: SimulationClient) {
  const store = useScenarioStore
  let cursor: [number, number] | null = null
  let snap: [number, number] | null = null
  let picking = false
  let queued: MapMouseEvent | null = null
  let disposed = false

  const canvas = map.getCanvas()
  const redrawDraft = () => showDraft(map, store.getState().draft, cursor, snap, store.getState().roadOptions.curved)

  /** Changed street or new road under the pointer (for the undo tool). */
  const editedAt = (point: { x: number; y: number }): SegmentInfo | null => {
    const box: [PointLike, PointLike] = [
      [point.x - PICK_PX / 2, point.y - PICK_PX / 2],
      [point.x + PICK_PX / 2, point.y + PICK_PX / 2],
    ]
    const hit = map.queryRenderedFeatures(box, { layers: [EDITS] })[0]
    if (!hit) return null
    const { edits, roads } = store.getState()
    const roadId = hit.properties.roadId as string | undefined
    if (roadId) {
      const road = roads.find((r) => r.id === roadId)
      return road ? { segment: -1, roadId, name: 'New road', roadClass: road.road, coordinates: road.coordinates, car: road.road !== 'cycleway', bike: true, foot: true, speedKmh: road.kmh } : null
    }
    const edit = edits[Number(hit.properties.segment)]
    return edit
      ? { segment: edit.segment, roadId: null, name: edit.name, roadClass: edit.roadClass, coordinates: edit.coordinates, car: true, bike: true, foot: true, speedKmh: edit.originalSpeedKmh }
      : null
  }

  const segmentAt = async (event: MapMouseEvent): Promise<SegmentInfo | null> => {
    const tool = store.getState().tool
    if (!tool) return null
    if (tool === 'erase') return editedAt(event.point)
    // Removing a road also takes away roads added in this scenario.
    if (tool === 'removed') {
      const added = editedAt(event.point)
      if (added?.roadId) return added
    }
    const result = await controller.pick('segment', lngLatOf(event), radiusAt(map, event.point, PICK_PX), TOOL_BY_ID[tool].mask)
    return result.segment
  }

  const junctionAt = async (event: MapMouseEvent, px: number) =>
    (await controller.pick('junction', lngLatOf(event), radiusAt(map, event.point, px))).junction

  const updateHover = async (event: MapMouseEvent) => {
    const tool = store.getState().tool
    if (tool === 'new-road') {
      cursor = lngLatOf(event)
      snap = (await junctionAt(event, SNAP_PX))?.coordinates ?? null
      redrawDraft()
      canvas.style.cursor = snap ? 'pointer' : 'crosshair'
      return
    }
    const hit = await segmentAt(event)
    if (disposed || store.getState().tool !== tool) return
    store.getState().setHover(hit)
    showHover(map, hit?.coordinates ?? null, tool)
    canvas.style.cursor = hit ? 'pointer' : 'crosshair'
  }

  // One pick in flight at a time; only the latest pointer position matters.
  const onMove = (event: MapMouseEvent) => {
    if (!store.getState().tool) return
    if (picking) {
      queued = event
      return
    }
    picking = true
    void updateHover(event).finally(() => {
      picking = false
      const next = queued
      queued = null
      if (next && !disposed) onMove(next)
    })
  }

  const finishRoad = async (event: MapMouseEvent | null) => {
    const { draft, setMessage, addRoad, roadOptions } = store.getState()
    if (!draft) return
    const points = [...draft.points]
    // The finishing click (or the last bend, for Enter) snaps to a junction.
    const last = points.pop()
    if (!last) return
    const point = event ? event.point : map.project(last)
    const lngLat = map.unproject(point)
    const junction = (await controller.pick('junction', [lngLat.lng, lngLat.lat], radiusAt(map, point, SNAP_PX))).junction
    if (!junction) {
      setMessage('Finish the road on a junction of a street or path.')
      return
    }
    if (junction.node === draft.start.node) {
      setMessage('The road has to end at a different junction.')
      return
    }
    const clicked = [draft.start.coordinates, ...points, junction.coordinates]
    const coordinates = roadOptions.curved ? smoothLine(clicked) : clicked
    const { curved: _, ...options } = roadOptions
    addRoad({ ...options, from: draft.start.node, to: junction.node, coordinates, lengthMeters: lineLength(coordinates) })
    setMessage(null)
    cursor = null
    redrawDraft()
  }

  const onClick = async (event: MapMouseEvent) => {
    const state = store.getState()
    const tool = state.tool
    if (!tool) return
    if (tool === 'new-road') {
      const { draft } = state
      if (!draft) {
        const start = await junctionAt(event, SNAP_PX)
        if (!start) state.setMessage('Start the road on a junction of a street or path.')
        else store.setState({ draft: { start, points: [] }, message: null })
        redrawDraft()
        return
      }
      const previous = draft.points.at(-1) ?? draft.start.coordinates
      const p = map.project(previous)
      if (draft.points.length && Math.hypot(p.x - event.point.x, p.y - event.point.y) < FINISH_PX) {
        await finishRoad(event)
        return
      }
      state.setDraft({ ...draft, points: [...draft.points, lngLatOf(event)] })
      redrawDraft()
      return
    }
    const hit = await segmentAt(event)
    if (store.getState().tool !== tool) return
    if (!hit) {
      state.setMessage(tool === 'erase' ? 'Click a highlighted change to undo it.' : 'No suitable street here. Try clicking closer to one.')
      return
    }
    state.applyToSegment(hit)
    showHover(map, null, tool)
  }

  const onKey = (event: KeyboardEvent) => {
    const el = event.target as HTMLElement | null
    if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return
    const state = store.getState()
    if (!state.tool) return
    if (event.key === 'Escape') {
      if (state.draft) state.setDraft(null)
      else state.setTool(null)
      redrawDraft()
    } else if (event.key === 'Enter' && state.draft) {
      void finishRoad(null)
    } else if (event.key === 'Backspace' && state.draft) {
      event.preventDefault()
      if (state.draft.points.length) state.setDraft({ ...state.draft, points: state.draft.points.slice(0, -1) })
      else state.setDraft(null)
      redrawDraft()
    }
  }

  // Tool changes: cursor, double-click zoom (used to finish a road), and clearing highlights.
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.tool !== previous.tool) {
      canvas.style.cursor = state.tool ? 'crosshair' : ''
      if (state.tool === 'new-road') map.doubleClickZoom.disable()
      else map.doubleClickZoom.enable()
      cursor = null
      snap = null
      showHover(map, null, null)
    }
    if (state.draft !== previous.draft || state.roadOptions !== previous.roadOptions) redrawDraft()
  })

  const onLeave = () => {
    cursor = null
    snap = null
    showHover(map, null, null)
    redrawDraft()
    store.getState().setHover(null)
  }

  const click = (event: MapMouseEvent) => void onClick(event)
  map.on('mousemove', onMove)
  map.on('click', click)
  map.on('mouseout', onLeave)
  window.addEventListener('keydown', onKey)
  return () => {
    disposed = true
    unsubscribe()
    map.off('mousemove', onMove)
    map.off('click', click)
    map.off('mouseout', onLeave)
    window.removeEventListener('keydown', onKey)
    map.doubleClickZoom.enable()
    canvas.style.cursor = ''
  }
}

import type { MapMouseEvent, Map as MapLibreMap, PointLike } from 'maplibre-gl'
import { useEffect } from 'react'
import { useMapInstance } from '../../hooks/useMapInstance'
import { toInterventions, useScenarioStore } from '../../store/useScenarioStore'
import { useSimulationStore } from '../../store/useSimulationStore'
import type { SegmentInfo } from '../../types/simulation'
import type { SimulationClient } from '../simulation/client'
import { addScenarioLayers, EDITS, removeScenarioLayers, showDraft, showEdits, showHover } from './scenarioLayers'
import { TOOL_BY_ID } from './tools'

/** Pick tolerance around the pointer, in screen pixels. */
const PICK_PX = 14
const SNAP_PX = 26
/** A second click this close to the last bend finishes the path (a double-click). */
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
 * active tool, applies the tool on click, draws new cycle paths, and keeps
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
      const { edits, paths } = useScenarioStore.getState()
      showEdits(map, Object.values(edits).sort((a, b) => a.order - b.order), paths)
      controller.setScenario(toInterventions(edits, paths))
    }
    sync()
    const unsubscribe = useScenarioStore.subscribe((state, previous) => {
      if (state.edits !== previous.edits || state.paths !== previous.paths) sync()
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
  const redrawDraft = () => showDraft(map, store.getState().draft, cursor, snap)

  /** Changed street or new cycle path under the pointer (for the undo tool). */
  const editedAt = (point: { x: number; y: number }): SegmentInfo | null => {
    const box: [PointLike, PointLike] = [
      [point.x - PICK_PX / 2, point.y - PICK_PX / 2],
      [point.x + PICK_PX / 2, point.y + PICK_PX / 2],
    ]
    const hit = map.queryRenderedFeatures(box, { layers: [EDITS] })[0]
    if (!hit) return null
    const { edits, paths } = store.getState()
    const pathId = hit.properties.pathId as string | undefined
    if (pathId) {
      const path = paths.find((p) => p.id === pathId)
      return path ? { segment: -1, pathId, name: 'New cycle path', roadClass: 'cycleway', coordinates: path.coordinates, car: false, bike: true, foot: true, speedKmh: 0 } : null
    }
    const edit = edits[Number(hit.properties.segment)]
    return edit
      ? { segment: edit.segment, pathId: null, name: edit.name, roadClass: edit.roadClass, coordinates: edit.coordinates, car: true, bike: true, foot: true, speedKmh: edit.originalSpeedKmh }
      : null
  }

  const segmentAt = async (event: MapMouseEvent): Promise<SegmentInfo | null> => {
    const tool = store.getState().tool
    if (!tool) return null
    if (tool === 'erase') return editedAt(event.point)
    const result = await controller.pick('segment', lngLatOf(event), radiusAt(map, event.point, PICK_PX), TOOL_BY_ID[tool].mask)
    return result.segment
  }

  const junctionAt = async (event: MapMouseEvent, px: number) =>
    (await controller.pick('junction', lngLatOf(event), radiusAt(map, event.point, px))).junction

  const updateHover = async (event: MapMouseEvent) => {
    const tool = store.getState().tool
    if (tool === 'cycle-path') {
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

  const finishPath = async (event: MapMouseEvent | null) => {
    const { draft, setMessage, addPath } = store.getState()
    if (!draft) return
    const points = [...draft.points]
    // The finishing click (or the last bend, for Enter) snaps to a junction.
    const last = points.pop()
    if (!last) return
    const point = event ? event.point : map.project(last)
    const lngLat = map.unproject(point)
    const junction = (await controller.pick('junction', [lngLat.lng, lngLat.lat], radiusAt(map, point, SNAP_PX))).junction
    if (!junction) {
      setMessage('Finish the path on a junction of a street or cycle path.')
      return
    }
    if (junction.node === draft.start.node) {
      setMessage('The path has to end at a different junction.')
      return
    }
    const coordinates = [draft.start.coordinates, ...points, junction.coordinates]
    let lengthMeters = 0
    for (let i = 1; i < coordinates.length; i++) lengthMeters += metresBetween(coordinates[i - 1], coordinates[i])
    addPath({ from: draft.start.node, to: junction.node, coordinates, lengthMeters })
    setMessage(null)
    cursor = null
    redrawDraft()
  }

  const onClick = async (event: MapMouseEvent) => {
    const state = store.getState()
    const tool = state.tool
    if (!tool) return
    if (tool === 'cycle-path') {
      const { draft } = state
      if (!draft) {
        const start = await junctionAt(event, SNAP_PX)
        if (!start) state.setMessage('Start the path on a junction of a street or cycle path.')
        else store.setState({ draft: { start, points: [] }, message: null })
        redrawDraft()
        return
      }
      const previous = draft.points.at(-1) ?? draft.start.coordinates
      const p = map.project(previous)
      if (draft.points.length && Math.hypot(p.x - event.point.x, p.y - event.point.y) < FINISH_PX) {
        await finishPath(event)
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
      void finishPath(null)
    } else if (event.key === 'Backspace' && state.draft) {
      event.preventDefault()
      if (state.draft.points.length) state.setDraft({ ...state.draft, points: state.draft.points.slice(0, -1) })
      else state.setDraft(null)
      redrawDraft()
    }
  }

  // Tool changes: cursor, double-click zoom (used to finish a path), and clearing highlights.
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.tool !== previous.tool) {
      canvas.style.cursor = state.tool ? 'crosshair' : ''
      if (state.tool === 'cycle-path') map.doubleClickZoom.disable()
      else map.doubleClickZoom.enable()
      cursor = null
      snap = null
      showHover(map, null, null)
    }
    if (state.draft !== previous.draft) redrawDraft()
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

import type { MapMouseEvent, MapLibreEvent } from 'maplibre-gl'
import { useEffect } from 'react'
import { useMapInstance } from '../../hooks/useMapInstance'
import { useScenarioStore } from '../../store/useScenarioStore'
import { useSimulationStore } from '../../store/useSimulationStore'

/** Pick tolerance around the pointer, in screen pixels. */
const PICK_PX = 16

/**
 * Click a car, bike, pedestrian, bus or train to follow it with the camera.
 * Dragging the map (or Esc) stops following. Inactive while a road-editing
 * tool is in use.
 */
export function useFollowVehicle() {
  const map = useMapInstance()
  const controller = useSimulationStore((s) => (s.status === 'ready' ? s.controller : null))

  useEffect(() => {
    if (!map || !controller) return
    const canvas = map.getCanvas()
    let hovering = false
    let lastMove = 0

    const radiusAt = (point: { x: number; y: number }) => {
      const a = map.unproject([point.x, point.y])
      const b = map.unproject([point.x + PICK_PX, point.y])
      return a.distanceTo(b)
    }
    const vehicleAt = (event: MapMouseEvent) =>
      controller.pickVehicle([event.lngLat.lng, event.lngLat.lat], radiusAt(event.point))

    const onClick = (event: MapMouseEvent) => {
      if (useScenarioStore.getState().tool) return
      const id = vehicleAt(event)
      if (id !== null) {
        useSimulationStore.setState({ followGone: false })
        controller.setFollow(id)
      }
    }
    const onMove = (event: MapMouseEvent) => {
      if (useScenarioStore.getState().tool || event.originalEvent.timeStamp - lastMove < 80) return
      lastMove = event.originalEvent.timeStamp
      const over = vehicleAt(event) !== null
      if (over !== hovering) {
        hovering = over
        canvas.style.cursor = over ? 'pointer' : ''
      }
    }
    // A drag by the user (not our own camera moves) hands the camera back.
    const onDragStart = (event: MapLibreEvent<MouseEvent | TouchEvent | undefined>) => {
      if (event.originalEvent && useSimulationStore.getState().followId !== null) controller.setFollow(null)
    }

    map.on('click', onClick)
    map.on('mousemove', onMove)
    map.on('dragstart', onDragStart)
    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
      map.off('dragstart', onDragStart)
    }
  }, [map, controller])
}

import type { Map as MapLibreMap } from 'maplibre-gl'
import { useEffect, useState } from 'react'
import { PLACES } from '../../data/places'
import { useMapInstance } from '../../hooks/useMapInstance'
import { speedKey } from '../../hooks/useKeyboardShortcuts'
import { useAppStore } from '../../store/useAppStore'
import { useSimulationStore } from '../../store/useSimulationStore'
import { DRIVE_CAMERA, DRIVE_SPEED, DRIVE_WAYPOINTS, flyTour } from './cinematic'

export interface Caption {
  title: string
  subtitle: string
}

/** Metres between two lng/lat points (fine at town scale). */
const metres = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 68_100, (a[1] - b[1]) * 110_574)

/** The town the camera is over, or the region when it's between towns. */
function townAt(map: MapLibreMap) {
  const { lng, lat } = map.getCenter()
  let best = 'Het Gooi'
  let bestD = 2200
  for (const place of PLACES) {
    if (place.id === 'region' || place.id === 'gooimeer') continue
    const d = metres([lng, lat], place.view.center)
    if (d < bestD) {
      bestD = d
      best = place.name
    }
  }
  return best
}

/**
 * The drive: start a car on the loop through the towns, fly the camera to it
 * and follow it; when it has done the loop, start another. Captions name the
 * town and the street it is on.
 */
async function drive(map: MapLibreMap, signal: AbortSignal, onCaption: (caption: Caption) => void) {
  const store = useSimulationStore
  const controller = store.getState().controller
  if (!controller) return
  const previousSpeed = store.getState().speed
  controller.setSpeed(DRIVE_SPEED)
  controller.setPlaying(true)
  let timer = 0
  // A chase camera: the car in the lower part of the screen, the road ahead above it.
  map.setPadding({ top: Math.round(map.getContainer().clientHeight * 0.45), bottom: 0, left: 0, right: 0 })
  const cleanup = () => {
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 })
    window.clearInterval(timer)
    controller.setFollow(null)
    controller.setChase(false)
    controller.setSpeed(previousSpeed)
  }
  signal.addEventListener('abort', cleanup)

  while (!signal.aborted) {
    onCaption({ title: 'Het Gooi', subtitle: 'A drive through every town, in simulated traffic' })
    // The start can be busy for a moment: try again until there's room.
    let car: number | null = null
    for (let attempt = 0; attempt < 20 && car === null && !signal.aborted; attempt++) {
      car = await controller.drive(DRIVE_WAYPOINTS)
      if (car === null) await new Promise((r) => setTimeout(r, 500))
    }
    if (car === null || signal.aborted) return
    // Fly down to the start, then ride along.
    await new Promise<void>((done) => {
      map.once('moveend', () => done())
      map.flyTo({ center: DRIVE_WAYPOINTS[0], ...DRIVE_CAMERA, duration: 6000, essential: true })
      signal.addEventListener('abort', () => done())
    })
    if (signal.aborted) return
    controller.setFollow(car)
    controller.setChase(true)
    // Until the car has finished the loop (or left the network).
    await new Promise<void>((done) => {
      window.clearInterval(timer)
      timer = window.setInterval(() => {
        const { followGone, followInfo } = store.getState()
        if (followGone || signal.aborted) {
          window.clearInterval(timer)
          done()
          return
        }
        const street = followInfo?.type === 'road' ? followInfo.street : null
        const speed = followInfo?.type === 'road' ? `${Math.round(followInfo.speedKmh)} km/h` : ''
        onCaption({ title: townAt(map), subtitle: [street, speed].filter(Boolean).join(' · ') })
      }, 1000)
    })
  }
}

/** Keys of cinematic mode itself: pause, speed, and the music's mute and next. */
const CINEMATIC_KEYS = /^([ 1-4mn=+_-])$/

/**
 * Runs the cinematic mode while it is playing, and returns the caption to
 * show. Esc, or moving the map yourself, ends it.
 */
export function useCinematic(): Caption | null {
  const map = useMapInstance()
  const playing = useAppStore((s) => s.cinematic === 'playing')
  const style = useAppStore((s) => s.cinematicStyle)
  const [caption, setCaption] = useState<Caption | null>(null)

  useEffect(() => {
    if (!map || !playing) return
    const controller = new AbortController()
    const stop = () => useAppStore.setState({ cinematic: null })
    // Only the visitor's own moves carry the browser event; the camera's don't.
    const onMove = (event: { originalEvent?: Event }) => {
      if (event.originalEvent) stop()
    }
    // Before the map's own shortcuts, so keys don't move the camera: Esc stops, Space
    // pauses, 1–4 and - + set the speed (M and N are the music's, see MusicControls).
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      event.stopPropagation()
      const key = event.key.toLowerCase()
      if (key === 'escape') {
        event.preventDefault()
        stop()
        return
      }
      // Other keys (Tab, Enter, the volume slider's arrows) work on the controls on screen.
      const onControl = (event.target as HTMLElement | null)?.closest?.('.cinematic-overlay')
      if (key === 'tab' || (onControl && !CINEMATIC_KEYS.test(key))) return
      event.preventDefault()
      if (event.repeat) return
      const sim = useSimulationStore.getState()
      if (key === ' ') sim.controller?.setPlaying(!sim.playing)
      else speedKey(key)
    }
    map.on('movestart', onMove)
    window.addEventListener('keydown', onKey, { capture: true })
    if (style === 'drive') void drive(map, controller.signal, setCaption)
    else void flyTour(map, controller.signal, (shot) => setCaption({ title: shot.title, subtitle: shot.subtitle }))
    return () => {
      controller.abort()
      map.off('movestart', onMove)
      window.removeEventListener('keydown', onKey, { capture: true })
      setCaption(null)
    }
  }, [map, playing, style])

  return caption
}

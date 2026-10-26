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
 * Gets the camera ready to ride along: the simulation at the ride's speed and a
 * chase camera with the vehicle low on the screen and the road ahead above it.
 * Puts everything back when `signal` aborts.
 */
function chaseCamera(map: MapLibreMap, signal: AbortSignal) {
  const store = useSimulationStore
  const controller = store.getState().controller!
  const previousSpeed = store.getState().speed
  controller.setSpeed(DRIVE_SPEED)
  controller.setPlaying(true)
  map.setPadding({ top: Math.round(map.getContainer().clientHeight * 0.45), bottom: 0, left: 0, right: 0 })
  signal.addEventListener('abort', () => {
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 })
    controller.setFollow(null)
    controller.setChase(false)
    controller.setSpeed(previousSpeed)
  })
}

/** Flies down to `center`, then follows vehicle `id` until it is gone, captioning every second. */
async function rideAlong(map: MapLibreMap, signal: AbortSignal, id: number, center: [number, number], caption: () => Caption | null, onCaption: (caption: Caption) => void) {
  const controller = useSimulationStore.getState().controller!
  await new Promise<void>((done) => {
    map.once('moveend', () => done())
    map.flyTo({ center, ...DRIVE_CAMERA, duration: 6000, essential: true })
    signal.addEventListener('abort', () => done())
  })
  if (signal.aborted) return
  controller.setFollow(id)
  controller.setChase(true)
  await new Promise<void>((done) => {
    const timer = window.setInterval(() => {
      if (useSimulationStore.getState().followGone || signal.aborted) {
        window.clearInterval(timer)
        done()
        return
      }
      const next = caption()
      if (next) onCaption(next)
    }, 1000)
    signal.addEventListener('abort', () => window.clearInterval(timer))
  })
}

/**
 * The drive: start a car on the loop through the towns, fly the camera to it
 * and follow it; when it has done the loop, start another. Captions name the
 * town and the street it is on.
 */
async function drive(map: MapLibreMap, signal: AbortSignal, onCaption: (caption: Caption) => void) {
  const controller = useSimulationStore.getState().controller
  if (!controller) return
  chaseCamera(map, signal)
  while (!signal.aborted) {
    onCaption({ title: 'Het Gooi', subtitle: 'A drive through every town, in simulated traffic' })
    // The start can be busy for a moment: try again until there's room.
    let car: number | null = null
    for (let attempt = 0; attempt < 20 && car === null && !signal.aborted; attempt++) {
      car = await controller.drive(DRIVE_WAYPOINTS)
      if (car === null) await new Promise((r) => setTimeout(r, 500))
    }
    if (car === null || signal.aborted) return
    await rideAlong(map, signal, car, DRIVE_WAYPOINTS[0], () => {
      const info = useSimulationStore.getState().followInfo
      const street = info?.type === 'road' ? info.street : null
      const speed = info?.type === 'road' ? `${Math.round(info.speedKmh)} km/h` : ''
      return { title: townAt(map), subtitle: [street, speed].filter(Boolean).join(' · ') }
    }, onCaption)
  }
}

/**
 * The bus ride: ride along with a bus on its timetabled trip, stop by stop;
 * when its trip ends, change to another bus. Captions name the line, the
 * next stop and the town.
 */
async function rideBus(map: MapLibreMap, signal: AbortSignal, onCaption: (caption: Caption) => void) {
  const controller = useSimulationStore.getState().controller
  if (!controller) return
  chaseCamera(map, signal)
  while (!signal.aborted) {
    const bus = await controller.ride()
    if (signal.aborted) return
    if (!bus) {
      // At night there may be no bus with a few stops to go: wait for the next one.
      onCaption({ title: 'Waiting for a bus', subtitle: 'No bus in service has a long way to go right now' })
      await new Promise((r) => setTimeout(r, 3000))
      continue
    }
    onCaption({ title: 'Het Gooi', subtitle: 'Riding along with a bus, in simulated traffic' })
    await rideAlong(map, signal, bus.id, bus.lngLat, () => {
      const { followInfo: info, lines } = useSimulationStore.getState()
      if (info?.type !== 'bus') return null
      const line = lines[info.line]
      const late = info.delayMinutes >= 1 ? `${Math.round(info.delayMinutes)} min late` : null
      const next = info.nextStop ? `Next stop ${info.nextStop}` : null
      return {
        title: `Bus ${line?.ref ?? ''}${line?.to ? ` to ${line.to}` : ''}`,
        subtitle: [townAt(map), next, `${Math.round(info.speedKmh)} km/h`, late].filter(Boolean).join(' · '),
      }
    }, onCaption)
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
    else if (style === 'ride') void rideBus(map, controller.signal, setCaption)
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

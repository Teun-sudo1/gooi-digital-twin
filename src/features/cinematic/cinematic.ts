import type { Map as MapLibreMap } from 'maplibre-gl'

/*
 * Cinematic mode, in two styles:
 * - drive: one car drives a loop through all the Gooi towns in ordinary
 *   (simulated) traffic, and the camera follows it, turning with it;
 * - ride: the camera rides along with a bus on its timetabled trip;
 * - fly: a slow camera flight from the whole region down to street level
 *   and back out. Each shot flies to a place, then drifts around it.
 * Both loop until the visitor stops them.
 */

export type CinematicStyle = 'drive' | 'ride' | 'fly'

/** The drive: a loop through every town, from and back to Hilversum (about 30 km). */
export const DRIVE_WAYPOINTS: [number, number][] = [
  [5.1745, 52.2245], // Hilversum
  [5.2265, 52.2565], // Laren
  [5.2585, 52.2545], // Eemnes
  [5.2445, 52.2728], // Blaricum
  [5.2405, 52.2992], // Huizen
  [5.1622, 52.2958], // Naarden
  [5.1625, 52.2745], // Bussum
  [5.1745, 52.2245], // Hilversum
]

/** Simulated seconds per real second during the drive and the bus ride: a 30 km loop in about 18 minutes. */
export const DRIVE_SPEED = 2
/** Camera while following the car. */
export const DRIVE_CAMERA = { zoom: 19, pitch: 70 }

export interface Shot {
  title: string
  subtitle: string
  center: [number, number]
  zoom: number
  pitch: number
  bearing: number
  /** Degrees to turn while holding the shot. */
  orbit: number
  /** Seconds to hold (and drift) once there. */
  hold: number
}

export const SHOTS: Shot[] = [
  { title: 'Het Gooi', subtitle: 'Huizen, Naarden, Bussum, Laren, Blaricum, Eemnes and Hilversum', center: [5.215, 52.268], zoom: 12.4, pitch: 50, bearing: -20, orbit: 20, hold: 9 },
  { title: 'Gooimeer', subtitle: 'The lake along the north of the region', center: [5.215, 52.317], zoom: 13.4, pitch: 58, bearing: -10, orbit: 25, hold: 9 },
  { title: 'Huizen', subtitle: 'Streets and traffic in the town centre', center: [5.2405, 52.2992], zoom: 16.4, pitch: 62, bearing: -22, orbit: 30, hold: 10 },
  { title: 'Stichtseweg × Randweg Oost', subtitle: 'Traffic through a large crossing', center: [5.2665, 52.2816], zoom: 18, pitch: 70, bearing: 35, orbit: 40, hold: 12 },
  { title: 'A27 at Eemnes', subtitle: 'Several lanes each way, overtaking on the left', center: [5.249, 52.2536], zoom: 17.3, pitch: 72, bearing: -12, orbit: 18, hold: 11 },
  { title: 'Laren', subtitle: 'Village streets among the trees', center: [5.2265, 52.2565], zoom: 16.6, pitch: 62, bearing: 60, orbit: 30, hold: 10 },
  { title: 'Naarden', subtitle: 'The fortress town', center: [5.1622, 52.2958], zoom: 15.4, pitch: 50, bearing: 10, orbit: 45, hold: 12 },
  { title: 'Bussum', subtitle: 'The town centre', center: [5.1625, 52.2745], zoom: 16.6, pitch: 64, bearing: -40, orbit: 30, hold: 10 },
  { title: 'Hilversum station', subtitle: 'Buses and trains on the real timetable', center: [5.1795, 52.2262], zoom: 17.2, pitch: 66, bearing: 20, orbit: 35, hold: 12 },
  { title: 'Het Gooi', subtitle: 'All of it simulated: streets, lanes, buses, trains and people', center: [5.2, 52.252], zoom: 12, pitch: 45, bearing: -12, orbit: 15, hold: 8 },
]

/** Seconds to fly between shots (longer for longer trips, as flyTo picks its own speed). */
const FLY = 9

/** Moves the camera and waits for it to arrive, or for the flight to be stopped. */
function move(map: MapLibreMap, signal: AbortSignal, run: () => void) {
  return new Promise<void>((done) => {
    if (signal.aborted) return done()
    const finish = () => {
      map.off('moveend', finish)
      signal.removeEventListener('abort', abort)
      done()
    }
    const abort = () => {
      map.stop()
      finish()
    }
    map.on('moveend', finish)
    signal.addEventListener('abort', abort)
    run()
  })
}

/** Flies the tour round and round until `signal` aborts; `onShot` is told each new place. */
export async function flyTour(map: MapLibreMap, signal: AbortSignal, onShot: (shot: Shot) => void) {
  while (!signal.aborted) {
    for (const shot of SHOTS) {
      if (signal.aborted) return
      onShot(shot)
      await move(map, signal, () =>
        map.flyTo({ center: shot.center, zoom: shot.zoom, pitch: shot.pitch, bearing: shot.bearing, duration: FLY * 1000, curve: 1.3, essential: true }),
      )
      // Drift: turn slowly around the place, closing in a little.
      await move(map, signal, () =>
        map.easeTo({
          bearing: shot.bearing + shot.orbit,
          zoom: shot.zoom + 0.25,
          duration: shot.hold * 1000,
          easing: (t) => t,
          essential: true,
        }),
      )
    }
  }
}

/** Times of day to start from (simulated clock, seconds since midnight). */
export const START_TIMES: { label: string; clock: number | null }[] = [
  { label: 'Now', clock: null },
  { label: 'Morning rush · 08:00', clock: 8 * 3600 },
  { label: 'Midday · 12:30', clock: 12.5 * 3600 },
  { label: 'Evening rush · 17:30', clock: 17.5 * 3600 },
  { label: 'Evening · 20:00', clock: 20 * 3600 },
  { label: 'Night · 23:30', clock: 23.5 * 3600 },
]

import type { CameraView, LngLat, Place } from '../types/geo'

/** Oude Haven area, the historic centre of Huizen. */
export const HUIZEN_CENTER: LngLat = [5.2405, 52.2992]

export const HUIZEN_VIEW: CameraView = {
  center: HUIZEN_CENTER,
  zoom: 15.4,
  pitch: 60,
  bearing: -22,
}

/**
 * Panning limit: the Gooi region (Hilversum in the south to the Gooimeer in the
 * north) plus a margin so the edges can still be framed comfortably.
 */
export const GOOI_BOUNDS: [LngLat, LngLat] = [
  [5.02, 52.15],
  [5.42, 52.39],
]

const view = (center: LngLat, zoom: number, pitch = 55, bearing = -15): CameraView => ({
  center,
  zoom,
  pitch,
  bearing,
})

export const PLACES: Place[] = [
  { id: 'huizen', name: 'Huizen', view: HUIZEN_VIEW },
  { id: 'blaricum', name: 'Blaricum', view: view([5.2445, 52.2728], 15) },
  { id: 'laren', name: 'Laren', view: view([5.2265, 52.2565], 15) },
  { id: 'eemnes', name: 'Eemnes', view: view([5.2585, 52.2545], 15) },
  { id: 'bussum', name: 'Bussum', view: view([5.1625, 52.2745], 15.2) },
  { id: 'naarden', name: 'Naarden', view: view([5.1622, 52.2958], 15.3, 50, 10) },
  { id: 'hilversum', name: 'Hilversum', view: view([5.1745, 52.2245], 15.2) },
  { id: 'gooimeer', name: 'Gooimeer', view: view([5.2150, 52.3170], 12.6, 50, -10) },
  { id: 'region', name: 'Whole region', view: view([5.2060, 52.2690], 11.4, 40, -10) },
]

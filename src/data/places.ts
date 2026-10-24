import type { CameraView, LngLat, Place } from '../types/geo'

/** Roughly the middle of the Gooi, between Laren, Blaricum and Bussum. */
export const REGION_CENTER: LngLat = [5.205, 52.262]

/** Home view: the whole Gooi region in perspective. */
export const REGION_VIEW: CameraView = {
  center: [5.2, 52.252],
  zoom: 12.1,
  pitch: 50,
  bearing: -12,
}

/**
 * Panning limit: the Gooi region (Hilversum in the south to the Gooimeer in the
 * north) plus a margin so the edges can still be framed comfortably.
 */
export const GOOI_BOUNDS: [LngLat, LngLat] = [
  [4.98, 52.12],
  [5.45, 52.4],
]

const view = (center: LngLat, zoom: number, pitch = 55, bearing = -15): CameraView => ({
  center,
  zoom,
  pitch,
  bearing,
})

export const PLACES: Place[] = [
  { id: 'region', name: 'Gooi region', view: REGION_VIEW },
  { id: 'hilversum', name: 'Hilversum', view: view([5.1745, 52.2245], 15.2) },
  { id: 'bussum', name: 'Bussum', view: view([5.1625, 52.2745], 15.2) },
  { id: 'naarden', name: 'Naarden', view: view([5.1622, 52.2958], 15.3, 50, 10) },
  { id: 'huizen', name: 'Huizen', view: view([5.2405, 52.2992], 15.4, 60, -22) },
  { id: 'blaricum', name: 'Blaricum', view: view([5.2445, 52.2728], 15) },
  { id: 'laren', name: 'Laren', view: view([5.2265, 52.2565], 15) },
  { id: 'eemnes', name: 'Eemnes', view: view([5.2585, 52.2545], 15) },
  { id: 'gooimeer', name: 'Gooimeer', view: view([5.215, 52.317], 12.6, 50, -10) },
]

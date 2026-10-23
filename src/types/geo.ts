/** Longitude/latitude pair in WGS84 (EPSG:4326), the order MapLibre and GeoJSON use. */
export type LngLat = [lng: number, lat: number]

export interface CameraView {
  center: LngLat
  zoom: number
  pitch: number
  bearing: number
}

export interface Place {
  id: string
  name: string
  view: CameraView
}

export type LayerGroupId =
  | 'buildings'
  | 'roads'
  | 'rail'
  | 'water'
  | 'green'
  | 'landuse'
  | 'labels'
  | 'traffic'

export interface LayerGroup {
  id: LayerGroupId
  label: string
  /** MapLibre style layer ids toggled together by this group. */
  layerIds: string[]
}

/** A geocoding hit from the PDOK Locatieserver. */
export interface SearchResult {
  id: string
  label: string
  /** PDOK result type, e.g. "adres", "weg", "woonplaats", "postcode", "gemeente". */
  type: string
  lngLat: LngLat
}

export type MapStatus = 'loading' | 'ready' | 'error'

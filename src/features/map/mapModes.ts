import type { LayerGroupId } from '../../types/geo'
import type { Basemap } from './layers'

export type MapMode = 'explore' | 'driving' | 'transit' | 'satellite'

export interface MapModeInfo {
  id: MapMode
  label: string
  description: string
  basemap: Basemap
  /** Layers this mode turns on or off; other layers keep the visitor's choice. */
  layers: Partial<Record<LayerGroupId, boolean>>
}

/** One-tap presets for what the map shows, like the modes in map apps. */
export const MAP_MODES: MapModeInfo[] = [
  {
    id: 'explore',
    label: 'Explore',
    description: 'The plain map, with the simulation on it',
    basemap: 'map',
    layers: { congestion: false, transitRoutes: false },
  },
  {
    id: 'driving',
    label: 'Driving',
    description: 'Streets coloured by simulated congestion',
    basemap: 'map',
    layers: { congestion: true, transitRoutes: false, traffic: true },
  },
  {
    id: 'transit',
    label: 'Transit',
    description: 'Bus and train routes and stops',
    basemap: 'map',
    layers: { congestion: false, transitRoutes: true, transit: true },
  },
  {
    id: 'satellite',
    label: 'Satellite',
    description: 'Aerial photos (PDOK Luchtfoto)',
    basemap: 'aerial',
    layers: { congestion: false, transitRoutes: false },
  },
]

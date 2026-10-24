import type { Map as MapLibreMap } from 'maplibre-gl'
import type { LayerGroup, LayerGroupId } from '../../types/geo'

/** User-facing layer toggles, each mapped onto the style layers in style.ts. */
export const LAYER_GROUPS: LayerGroup[] = [
  { id: 'traffic', label: 'Cars, bikes & pedestrians', layerIds: ['sim-agents', 'sim-headlights'] },
  { id: 'congestion', label: 'Congestion', layerIds: ['congestion'] },
  { id: 'transit', label: 'Buses & trains', layerIds: ['sim-transit', 'sim-trains', 'sim-bus-labels'] },
  // Only the map display of routes and stops; buses and trains keep running either way.
  { id: 'transitRoutes', label: 'Transit routes & stops', layerIds: ['transit-routes', 'transit-stops'] },
  { id: 'buildings', label: '3D buildings', layerIds: ['buildings-3d'] },
  // Drawn by the scenery layer (src/features/scenery), which follows these toggles itself.
  { id: 'trees', label: 'Trees', layerIds: [] },
  { id: 'streetLights', label: 'Street lighting', layerIds: [] },
  // Also switches the lights off in the simulation: junctions then use the right-of-way rules.
  { id: 'trafficLights', label: 'Traffic lights', layerIds: [] },
  {
    id: 'roads',
    label: 'Roads',
    layerIds: [
      'road-path',
      'road-minor',
      'road-major-casing',
      'road-major',
      'road-motorway-casing',
      'road-motorway',
    ],
  },
  { id: 'rail', label: 'Rail', layerIds: ['rail', 'rail-hatch'] },
  { id: 'water', label: 'Water', layerIds: ['water', 'water-shoreline', 'waterway'] },
  {
    id: 'green',
    label: 'Forest & parks',
    layerIds: ['landcover-wood', 'landcover-grass', 'landuse-park', 'park-outline'],
  },
  { id: 'landuse', label: 'Built-up areas', layerIds: ['landuse-residential', 'landuse-industrial'] },
  {
    id: 'labels',
    label: 'Labels',
    layerIds: ['label-water', 'label-waterway', 'label-road', 'label-park', 'label-place-minor', 'label-place-major'],
  },
]

export type LayerVisibility = Record<LayerGroupId, boolean>

export const DEFAULT_VISIBILITY: LayerVisibility = {
  buildings: true,
  roads: true,
  rail: true,
  water: true,
  green: true,
  landuse: true,
  labels: true,
  traffic: true,
  transit: true,
  // Explore mode: congestion and transit routes come with the Driving and Transit modes.
  transitRoutes: false,
  trees: true,
  streetLights: true,
  trafficLights: true,
  congestion: false,
}

/** Groups the aerial photos replace: drawing them would cover the photo. */
const COVERED_BY_AERIAL = new Set<LayerGroupId>(['water', 'green', 'landuse'])

export type Basemap = 'map' | 'aerial'

export function applyVisibility(map: MapLibreMap, visibility: LayerVisibility, basemap: Basemap = 'map') {
  const aerial = basemap === 'aerial'
  if (map.getLayer('aerial')) map.setLayoutProperty('aerial', 'visibility', aerial ? 'visible' : 'none')
  for (const group of LAYER_GROUPS) {
    const value = visibility[group.id] && !(aerial && COVERED_BY_AERIAL.has(group.id)) ? 'visible' : 'none'
    for (const layerId of group.layerIds) {
      if (map.getLayer(layerId) && map.getLayoutProperty(layerId, 'visibility') !== value) {
        map.setLayoutProperty(layerId, 'visibility', value)
      }
    }
  }
}

/** Roads are drawn lighter over aerial photos, so the photo shows through. */
const roadOpacity = new Map<string, unknown>()

export function applyBasemapStyle(map: MapLibreMap, basemap: Basemap) {
  for (const id of LAYER_GROUPS.find((g) => g.id === 'roads')!.layerIds) {
    if (!map.getLayer(id)) continue
    if (!roadOpacity.has(id)) roadOpacity.set(id, map.getPaintProperty(id, 'line-opacity') ?? 1)
    const original = roadOpacity.get(id) as number
    map.setPaintProperty(id, 'line-opacity', basemap === 'aerial' ? original * 0.45 : original)
  }
}

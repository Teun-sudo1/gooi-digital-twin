import type { Map as MapLibreMap } from 'maplibre-gl'
import type { LayerGroup, LayerGroupId } from '../../types/geo'

/** User-facing layer toggles, each mapped onto the style layers in style.ts. */
export const LAYER_GROUPS: LayerGroup[] = [
  { id: 'traffic', label: 'Simulated traffic', layerIds: ['sim-vehicles'] },
  { id: 'buildings', label: '3D buildings', layerIds: ['buildings-3d'] },
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
}

export function applyVisibility(map: MapLibreMap, visibility: LayerVisibility) {
  for (const group of LAYER_GROUPS) {
    const value = visibility[group.id] ? 'visible' : 'none'
    for (const layerId of group.layerIds) {
      if (map.getLayer(layerId) && map.getLayoutProperty(layerId, 'visibility') !== value) {
        map.setLayoutProperty(layerId, 'visibility', value)
      }
    }
  }
}

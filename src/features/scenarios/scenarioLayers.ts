import type { Feature, FeatureCollection, LineString, Point } from 'geojson'
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { LANE_WIDTH } from '../simulation/lanes'
import { NEW_ROADS } from '../map/style'
import type { NewRoad, RoadDraft, RoadEdit, ScenarioTool } from '../../store/useScenarioStore'
import { smoothLine } from './curves'
import { TOOL_BY_ID, TOOLS } from './tools'

/**
 * Map layers that show road edits, the street under the pointer and a road
 * being drawn. New roads themselves, and the cover over removed ones, are
 * drawn by the base style (NEW_ROADS), so they follow the theme.
 */

export const EDITS = 'scenario-edits'
const HOVER = 'scenario-hover'
const DRAFT = 'scenario-draft'
const FONT = ['Noto Sans Regular']
const LAYERS = ['scenario-edits-casing', EDITS, 'scenario-closed-dash', 'scenario-speed-label', HOVER, 'scenario-draft-line', 'scenario-draft-points']

/** Line width by zoom, scaled (zoom may only appear in a top-level interpolate). */
const width = (k: number): ExpressionSpecification => ['interpolate', ['exponential', 1.6], ['zoom'], 11, 2 * k, 14, 4 * k, 17, 9 * k, 20, 22 * k]
const WIDTH = width(1)
const CASING = width(1.6)
const COLOUR: ExpressionSpecification = [
  'match',
  ['get', 'kind'],
  ...TOOLS.flatMap((t) => [t.id, t.colour]),
  '#ffffff',
] as unknown as ExpressionSpecification
/** New car roads are drawn as roads by the style; their edit line only serves picking. */
const OPACITY: ExpressionSpecification = ['case', ['==', ['get', 'kind'], 'new-car-road'], 0, ['==', ['get', 'kind'], 'removed'], 0.55, 1]

const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] })

export function addScenarioLayers(map: MapLibreMap) {
  if (map.getSource(EDITS)) return
  // Below the 3D buildings, so they still hide edits behind them.
  const before = map.getLayer('buildings-3d') ? 'buildings-3d' : undefined
  for (const id of [EDITS, HOVER, DRAFT]) map.addSource(id, { type: 'geojson', data: empty() })
  const round = { 'line-cap': 'round', 'line-join': 'round' } as const

  map.addLayer(
    {
      id: 'scenario-edits-casing',
      type: 'line',
      source: EDITS,
      filter: ['!', ['match', ['get', 'kind'], ['new-car-road', 'removed'], true, false]],
      layout: round,
      paint: { 'line-color': '#0b0f14', 'line-opacity': 0.45, 'line-width': CASING },
    },
    before,
  )
  map.addLayer({ id: EDITS, type: 'line', source: EDITS, layout: round, paint: { 'line-color': COLOUR, 'line-opacity': OPACITY, 'line-width': WIDTH } }, before)
  map.addLayer(
    {
      id: 'scenario-closed-dash',
      type: 'line',
      source: EDITS,
      filter: ['match', ['get', 'kind'], ['closed', 'removed'], true, false],
      paint: { 'line-color': '#ffffff', 'line-width': width(0.35), 'line-dasharray': [1.2, 1.2] },
    },
    before,
  )
  map.addLayer(
    {
      id: 'scenario-speed-label',
      type: 'symbol',
      source: EDITS,
      filter: ['has', 'speed'],
      layout: {
        'symbol-placement': 'line-center',
        'text-field': ['get', 'speed'],
        'text-font': FONT,
        'text-size': 12,
        'text-allow-overlap': true,
        'text-rotation-alignment': 'viewport',
      },
      paint: { 'text-color': '#1a1206', 'text-halo-color': TOOL_BY_ID.speed.colour, 'text-halo-width': 3 },
    },
    before,
  )
  map.addLayer(
    { id: HOVER, type: 'line', source: HOVER, layout: round, paint: { 'line-color': ['get', 'colour'], 'line-opacity': 0.6, 'line-width': width(1.8) } },
    before,
  )
  map.addLayer(
    {
      id: 'scenario-draft-line',
      type: 'line',
      source: DRAFT,
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: round,
      paint: { 'line-color': TOOL_BY_ID['new-road'].colour, 'line-width': WIDTH, 'line-dasharray': [1.5, 1] },
    },
    before,
  )
  map.addLayer({
    id: 'scenario-draft-points',
    type: 'circle',
    source: DRAFT,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': ['match', ['get', 'role'], 'snap', 7, 4.5],
      'circle-color': ['match', ['get', 'role'], 'snap', 'rgba(0,0,0,0)', '#ffffff'],
      'circle-stroke-color': TOOL_BY_ID['new-road'].colour,
      'circle-stroke-width': 2.5,
      'circle-pitch-alignment': 'map',
    },
  })
}

export function removeScenarioLayers(map: MapLibreMap) {
  if (!map.getStyle()) return
  for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id)
  for (const id of [EDITS, HOVER, DRAFT]) if (map.getSource(id)) map.removeSource(id)
}

const line = (coordinates: [number, number][], properties: Record<string, string | number>): Feature<LineString> => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties,
})

/** How wide the base map draws a street of an OSM class, for covering a removed one. */
function mapSize(roadClass: string) {
  if (roadClass.startsWith('motorway') || roadClass.startsWith('trunk')) return 'motorway'
  if (/^(primary|secondary|tertiary)/.test(roadClass)) return 'major'
  if (/^(cycleway|footway|path|pedestrian|track|steps|bridleway)/.test(roadClass)) return 'path'
  return 'minor'
}

/** Road surface width in metres of a new road. */
export function newRoadWidth(road: NewRoad) {
  if (road.road === 'cycleway') return 2.6
  return road.lanes * (road.oneway ? 1 : 2) * LANE_WIDTH + 1
}

export function showEdits(map: MapLibreMap, edits: RoadEdit[], roads: NewRoad[]) {
  const features: Feature<LineString>[] = [
    ...roads.map((r) => line(r.coordinates, { kind: r.road === 'cycleway' ? 'new-road' : 'new-car-road', roadId: r.id })),
    ...edits.map((e) => {
      const props: Record<string, string | number> = { kind: e.access ?? 'speed', segment: e.segment }
      if (e.speedKmh) props.speed = String(e.speedKmh)
      return line(e.coordinates, props)
    }),
  ]
  map.getSource<GeoJSONSource>(EDITS)?.setData({ type: 'FeatureCollection', features })
  const drawn: Feature<LineString>[] = [
    ...edits.filter((e) => e.access === 'removed').map((e) => line(e.coordinates, { kind: 'removed', size: mapSize(e.roadClass) })),
    ...roads.map((r) => line(r.coordinates, { kind: 'road', road: r.road, width: newRoadWidth(r) })),
  ]
  map.getSource<GeoJSONSource>(NEW_ROADS)?.setData({ type: 'FeatureCollection', features: drawn })
}

export function showHover(map: MapLibreMap, coordinates: [number, number][] | null, tool: ScenarioTool | null) {
  const features = coordinates && tool ? [line(coordinates, { colour: TOOL_BY_ID[tool].colour })] : []
  map.getSource<GeoJSONSource>(HOVER)?.setData({ type: 'FeatureCollection', features })
}

/** The road drawn so far (smoothed when curved), the pointer position, and the junction it would snap to. */
export function showDraft(map: MapLibreMap, draft: RoadDraft | null, cursor: [number, number] | null, snap: [number, number] | null, curved: boolean) {
  const features: Feature<LineString | Point>[] = []
  if (draft) {
    const coordinates = [draft.start.coordinates, ...draft.points]
    if (cursor) coordinates.push(snap ?? cursor)
    if (coordinates.length > 1) features.push(line(curved ? smoothLine(coordinates) : coordinates, {}))
    for (const c of [draft.start.coordinates, ...draft.points]) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { role: 'vertex' } })
    }
  }
  if (snap) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: snap }, properties: { role: 'snap' } })
  map.getSource<GeoJSONSource>(DRAFT)?.setData({ type: 'FeatureCollection', features })
}

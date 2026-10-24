import type {
  ExpressionSpecification,
  LayerSpecification,
  LightSpecification,
  Map as MapLibreMap,
  SkySpecification,
  StyleSpecification,
} from 'maplibre-gl'

/*
 * Basemap for the digital twin, recoloured between a day and a night palette
 * as the simulated sun moves, drawn from OpenFreeMap vector tiles
 * (OpenMapTiles schema, built from OpenStreetMap). The tiles are free and
 * need no API key. See https://openfreemap.org and https://openmaptiles.org/schema/
 */

const SOURCE = 'openmaptiles'
export const SEARCH_SOURCE = 'search-result'

const FONT = ['Noto Sans Regular']

export interface Palette {
  background: string
  landuse: string
  industrial: string
  wood: string
  grass: string
  park: string
  parkOutline: string
  water: string
  shoreline: string
  waterway: string
  roadMinor: string
  roadMajor: string
  roadMajorCasing: string
  motorway: string
  motorwayCasing: string
  path: string
  rail: string
  label: string
  labelMuted: string
  labelHalo: string
  waterLabel: string
  parkLabel: string
  accent: string
  /** Building colour ramp by height: 0, 8, 20 and 50 m. */
  building: [string, string, string, string]
  sky: string
  horizon: string
  light: string
  lightIntensity: number
}

/** Daylight: a calm, light map. */
export const DAY: Palette = {
  background: '#eef1f4',
  landuse: '#e9ecf0',
  industrial: '#e2e3e8',
  wood: '#cde2c6',
  grass: '#d9e9cf',
  park: '#c9e3bd',
  parkOutline: '#b2d0a4',
  water: '#a7cbe7',
  shoreline: '#90b9da',
  waterway: '#98c1e3',
  roadMinor: '#ffffff',
  roadMajor: '#ffffff',
  roadMajorCasing: '#c5cbd4',
  motorway: '#f3c97a',
  motorwayCasing: '#d09d4a',
  path: '#c2c8d0',
  rail: '#98a1ab',
  label: '#353d4a',
  labelMuted: '#6a7380',
  labelHalo: '#ffffff',
  waterLabel: '#3f73a3',
  parkLabel: '#4a7a58',
  accent: '#1f6fd1',
  building: ['#d3d8e0', '#c8ced8', '#bcc4cf', '#a9b3c0'],
  sky: '#b9d5f0',
  horizon: '#e9eef5',
  light: '#ffffff',
  lightIntensity: 0.5,
}

/** Night: the original dark digital-twin look. */
export const NIGHT: Palette = {
  background: '#0c1016',
  landuse: '#111720',
  industrial: '#13161c',
  wood: '#10241c',
  grass: '#11211a',
  park: '#14291f',
  parkOutline: '#1c3328',
  water: '#0a1b2a',
  shoreline: '#163650',
  waterway: '#12334d',
  roadMinor: '#252d38',
  roadMajor: '#3a4553',
  roadMajorCasing: '#151a21',
  motorway: '#8a6a45',
  motorwayCasing: '#2a2016',
  path: '#2a3340',
  rail: '#47505d',
  label: '#a9b4c2',
  labelMuted: '#6f7b8a',
  labelHalo: '#0c1016',
  waterLabel: '#4f7fa6',
  parkLabel: '#5e8a72',
  accent: '#7cc4ff',
  building: ['#2a3546', '#334257', '#42566f', '#5b7598'],
  sky: '#0a0e14',
  horizon: '#18212d',
  light: '#dfe6f5',
  lightIntensity: 0.42,
}

function mixHex(a: string, b: string, t: number) {
  const pa = Number.parseInt(a.slice(1), 16)
  const pb = Number.parseInt(b.slice(1), 16)
  const channel = (shift: number) =>
    Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t)
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, '0')}`
}

/** Map palette for a night factor (0 = day, 1 = night). */
export const paletteFor = (night: number) => mixPalette(DAY, NIGHT, night)

/** Blend two palettes; t = 0 gives `a`, t = 1 gives `b`. */
export function mixPalette(a: Palette, b: Palette, t: number): Palette {
  const out = {} as Record<string, unknown>
  for (const key of Object.keys(a) as (keyof Palette)[]) {
    const va = a[key]
    const vb = b[key]
    if (typeof va === 'number') out[key] = va * (1 - t) + (vb as number) * t
    else if (Array.isArray(va)) out[key] = va.map((v, i) => mixHex(v, (vb as string[])[i], t))
    else out[key] = mixHex(va, vb as string, t)
  }
  return out as unknown as Palette
}

const name: ExpressionSpecification = ['coalesce', ['get', 'name:nl'], ['get', 'name']]

const isPolygon: ExpressionSpecification = [
  'match',
  ['geometry-type'],
  ['Polygon', 'MultiPolygon'],
  true,
  false,
]
const isLine: ExpressionSpecification = [
  'match',
  ['geometry-type'],
  ['LineString', 'MultiLineString'],
  true,
  false,
]

/** Road widths in pixels, grown exponentially so streets keep a believable scale when zooming. */
const width = (base: number, max: number): ExpressionSpecification => [
  'interpolate',
  ['exponential', 1.6],
  ['zoom'],
  10,
  base,
  18,
  max,
]

const roadClass = (...classes: string[]): ExpressionSpecification => [
  'match',
  ['get', 'class'],
  classes,
  true,
  false,
]

const notTunnel: ExpressionSpecification = ['!=', ['get', 'brunnel'], 'tunnel']

function buildLayers(color: Palette): LayerSpecification[] {
  return [
    { id: 'background', type: 'background', paint: { 'background-color': color.background } },

    // Land use and green space
    {
      id: 'landuse-residential',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landuse',
      filter: ['all', isPolygon, roadClass('residential', 'suburb', 'neighbourhood')],
      paint: { 'fill-color': color.landuse },
    },
    {
      id: 'landuse-industrial',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landuse',
      filter: ['all', isPolygon, roadClass('industrial', 'commercial', 'retail', 'railway')],
      paint: { 'fill-color': color.industrial },
    },
    {
      id: 'landcover-wood',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landcover',
      filter: ['all', isPolygon, roadClass('wood', 'forest')],
      paint: { 'fill-color': color.wood },
    },
    {
      id: 'landcover-grass',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landcover',
      filter: ['all', isPolygon, roadClass('grass', 'farmland', 'wetland', 'sand')],
      paint: { 'fill-color': color.grass, 'fill-opacity': 0.8 },
    },
    {
      id: 'landuse-park',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landuse',
      filter: ['all', isPolygon, roadClass('park', 'cemetery', 'pitch', 'playground', 'garden')],
      paint: { 'fill-color': color.park },
    },
    {
      id: 'park-outline',
      type: 'line',
      source: SOURCE,
      'source-layer': 'park',
      minzoom: 11,
      paint: { 'line-color': color.parkOutline, 'line-width': 0.8 },
    },

    // Water
    {
      id: 'water',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'water',
      filter: ['all', isPolygon, notTunnel],
      paint: { 'fill-color': color.water },
    },
    {
      id: 'water-shoreline',
      type: 'line',
      source: SOURCE,
      'source-layer': 'water',
      filter: ['all', isPolygon, notTunnel],
      minzoom: 11,
      paint: { 'line-color': color.shoreline, 'line-width': 1 },
    },
    {
      id: 'waterway',
      type: 'line',
      source: SOURCE,
      'source-layer': 'waterway',
      filter: ['all', isLine, notTunnel],
      paint: { 'line-color': color.waterway, 'line-width': width(0.6, 4) },
    },

    // Roads: casings first, then fills, ordered from minor to major so major roads sit on top.
    {
      id: 'road-path',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      filter: ['all', isLine, roadClass('path', 'track')],
      minzoom: 14,
      paint: {
        'line-color': color.path,
        'line-width': width(0.4, 1.6),
        'line-dasharray': [2, 1.5],
      },
    },
    {
      id: 'road-minor',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      filter: ['all', isLine, roadClass('minor', 'service')],
      minzoom: 12,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color.roadMinor, 'line-width': width(0.4, 10) },
    },
    {
      id: 'road-major-casing',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      filter: ['all', isLine, roadClass('primary', 'secondary', 'tertiary', 'trunk')],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color.roadMajorCasing, 'line-width': width(1.2, 18) },
    },
    {
      id: 'road-major',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      filter: ['all', isLine, roadClass('primary', 'secondary', 'tertiary', 'trunk')],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color.roadMajor, 'line-width': width(0.8, 15) },
    },
    {
      id: 'road-motorway-casing',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      filter: ['all', isLine, roadClass('motorway')],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color.motorwayCasing, 'line-width': width(1.6, 22) },
    },
    {
      id: 'road-motorway',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      filter: ['all', isLine, roadClass('motorway')],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color.motorway, 'line-width': width(1, 18), 'line-opacity': 0.85 },
    },

    // Rail
    {
      id: 'rail',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      filter: ['all', isLine, roadClass('rail', 'transit')],
      paint: { 'line-color': color.rail, 'line-width': width(0.6, 3) },
    },
    {
      id: 'rail-hatch',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      filter: ['all', isLine, roadClass('rail', 'transit')],
      minzoom: 13,
      paint: {
        'line-color': color.rail,
        'line-width': width(2, 8),
        'line-dasharray': [0.15, 3],
      },
    },

    /*
     * 3D buildings. `render_height` comes from OSM `height` or `building:levels`
     * tags. When a building has neither, OpenMapTiles fills in a small default
     * height, so many residential heights are approximate rather than surveyed.
     * Extrusion grows in between zoom 13 and 14.5 to avoid buildings popping in.
     */
    {
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: SOURCE,
      'source-layer': 'building',
      minzoom: 13,
      filter: ['!=', ['get', 'hide_3d'], true],
      paint: {
        'fill-extrusion-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'render_height'], 0],
          0,
          color.building[0],
          8,
          color.building[1],
          20,
          color.building[2],
          50,
          color.building[3],
        ],
        'fill-extrusion-height': [
          'interpolate',
          ['linear'],
          ['zoom'],
          13,
          0,
          14.5,
          ['coalesce', ['get', 'render_height'], 0],
        ],
        'fill-extrusion-base': [
          'interpolate',
          ['linear'],
          ['zoom'],
          13,
          0,
          14.5,
          ['coalesce', ['get', 'render_min_height'], 0],
        ],
        'fill-extrusion-opacity': 0.92,
        'fill-extrusion-vertical-gradient': true,
      },
    },

    // Labels
    // Lakes such as the Gooimeer come as points, rivers and canals as lines.
    {
      id: 'label-water',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'water_name',
      filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
      layout: { 'text-field': name, 'text-font': FONT, 'text-size': 13, 'text-letter-spacing': 0.15 },
      paint: { 'text-color': color.waterLabel, 'text-halo-color': color.labelHalo, 'text-halo-width': 1.2 },
    },
    {
      id: 'label-waterway',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'waterway',
      minzoom: 13,
      filter: isLine,
      layout: {
        'text-field': name,
        'text-font': FONT,
        'text-size': 11,
        'symbol-placement': 'line',
      },
      paint: { 'text-color': color.waterLabel, 'text-halo-color': color.labelHalo, 'text-halo-width': 1.2 },
    },
    {
      id: 'label-road',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'transportation_name',
      minzoom: 14,
      filter: isLine,
      layout: {
        'text-field': name,
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 13],
        'symbol-placement': 'line',
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': color.labelMuted, 'text-halo-color': color.labelHalo, 'text-halo-width': 1.4 },
    },
    {
      id: 'label-park',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'park',
      minzoom: 12,
      filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
      layout: { 'text-field': name, 'text-font': FONT, 'text-size': 11, 'text-max-width': 8 },
      paint: { 'text-color': color.parkLabel, 'text-halo-color': color.labelHalo, 'text-halo-width': 1.2 },
    },
    {
      id: 'label-place-minor',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      minzoom: 12,
      filter: roadClass('suburb', 'neighbourhood', 'quarter', 'hamlet', 'isolated_dwelling', 'locality'),
      layout: {
        'text-field': name,
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 13],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
        'text-max-width': 8,
      },
      paint: { 'text-color': color.labelMuted, 'text-halo-color': color.labelHalo, 'text-halo-width': 1.4 },
    },
    {
      id: 'label-place-major',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      filter: roadClass('village', 'town', 'city'),
      layout: {
        'text-field': name,
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 14, 18],
        'text-letter-spacing': 0.04,
      },
      paint: { 'text-color': color.label, 'text-halo-color': color.labelHalo, 'text-halo-width': 1.6 },
    },
    // Search result highlight, drawn last so it stays visible among buildings (data set by the search box)
    {
      id: 'search-result-halo',
      type: 'circle',
      source: SEARCH_SOURCE,
      paint: {
        'circle-radius': 18,
        'circle-color': color.accent,
        'circle-opacity': 0.25,
        'circle-pitch-alignment': 'viewport',
      },
    },
    {
      id: 'search-result-dot',
      type: 'circle',
      source: SEARCH_SOURCE,
      paint: {
        'circle-radius': 6,
        'circle-color': color.accent,
        'circle-stroke-color': color.background,
        'circle-stroke-width': 2,
        'circle-pitch-alignment': 'viewport',
      },
    },
  ]
}

export function buildStyle(palette: Palette): StyleSpecification {
  return {
    version: 8,
    name: 'Gooi Digital Twin',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      [SOURCE]: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution:
          '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · ' +
          '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · ' +
          '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>',
      },
      [SEARCH_SOURCE]: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        attribution:
          'Search: <a href="https://www.pdok.nl/" target="_blank" rel="noopener">PDOK Locatieserver (Kadaster)</a>',
      },
    },
    // A soft, low key light from the south-west gives building facades some depth.
    light: lightFor(palette),
    sky: {
      ...skyFor(palette),
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.4,
      'atmosphere-blend': 0,
    },
    layers: buildLayers(palette),
  }
}

function lightFor(palette: Palette): LightSpecification {
  return { anchor: 'viewport', color: palette.light, intensity: palette.lightIntensity, position: [1.2, 200, 35] }
}

function skyFor(palette: Palette): SkySpecification {
  return { 'sky-color': palette.sky, 'horizon-color': palette.horizon, 'fog-color': palette.background }
}

/**
 * Recolours a running map to `palette` without reloading the style: every
 * colour paint property of the base layers is updated in place.
 */
export function applyPalette(map: MapLibreMap, palette: Palette) {
  for (const layer of buildLayers(palette)) {
    if (!('paint' in layer) || !layer.paint || !map.getLayer(layer.id)) continue
    for (const [key, value] of Object.entries(layer.paint)) {
      if (key.endsWith('color')) map.setPaintProperty(layer.id, key as Parameters<MapLibreMap['setPaintProperty']>[1], value)
    }
  }
  map.setLight(lightFor(palette))
  map.setSky({ ...skyFor(palette), 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.4, 'atmosphere-blend': 0 })
}

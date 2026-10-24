#!/usr/bin/env node
/*
 * Builds public/data/gooi-scenery.json: trees and street lights for the map.
 *
 *   node scripts/fetch-scenery.mjs            # use cached Overpass responses if present
 *   node scripts/fetch-scenery.mjs --refresh  # download fresh data
 *
 * Trees:   individually mapped trees and tree rows from OSM, plus the trees
 *          the municipalities record in the BGT (Basisregistratie
 *          Grootschalige Topografie, via the PDOK OGC API, CC0), at their real
 *          positions, plus the outlines of mapped forests and woods. The app
 *          fills those outlines with trees at runtime, so positions of
 *          forest trees are illustrative.
 * Lights:  the street lamps mapped in OSM (few), plus lamps placed by rule
 *          along streets that are lit: tagged lit=yes, or (untagged) urban
 *          roads with a limit of 50 km/h or less. Positions of rule-placed
 *          lamps are illustrative.
 *
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BBOX, CACHE, carSpeed, KX, KY, LAT0, LNG0, NETWORK_QUERY, OUT, overpass, project, simplify } from './osm-common.mjs'

const BGT_TREES = 'https://api.pdok.nl/lv/bgt/ogc/v1/collections/vegetatieobject_punt/items'
/** The region is fetched in tiles of this many degrees, a few at a time. */
const BGT_TILE = 0.01
const BGT_PARALLEL = 6

/**
 * Trees from the BGT (point vegetation objects of type "boom"), as
 * [lng, lat] pairs, cached in scripts/.cache/bgt-trees.json.
 */
async function bgtTrees(refresh) {
  const file = resolve(CACHE, 'bgt-trees.json')
  if (!refresh) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      // not cached yet
    }
  }
  const [south, west, north, east] = BBOX
  const tiles = []
  for (let lng = west; lng < east - 1e-9; lng += BGT_TILE) {
    for (let lat = south; lat < north - 1e-9; lat += BGT_TILE) {
      tiles.push([lng, lat, Math.min(lng + BGT_TILE, east), Math.min(lat + BGT_TILE, north)].map((v) => v.toFixed(5)).join(','))
    }
  }
  const points = []
  let done = 0
  const fetchTile = async (bbox) => {
    let url = `${BGT_TREES}?f=json&limit=5000&bbox=${bbox}`
    while (url) {
      let json
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetch(url, { headers: { Accept: 'application/geo+json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          json = await response.json()
          break
        } catch (error) {
          if (attempt >= 3) throw error
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        }
      }
      for (const f of json.features ?? []) {
        const p = f.properties
        if (p.plus_type !== 'boom' || p.status !== 'bestaand' || p.eind_registratie || f.geometry?.type !== 'Point') continue
        const [lng, lat] = f.geometry.coordinates
        points.push([Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6])
      }
      url = json.links?.find((l) => l.rel === 'next')?.href ?? null
    }
    if (++done % 40 === 0) console.log(`  bgt: ${done}/${tiles.length} tiles, ${points.length} trees`)
  }
  console.log(`bgt: fetching trees in ${tiles.length} tiles from PDOK …`)
  const queue = [...tiles]
  await Promise.all(Array.from({ length: BGT_PARALLEL }, async () => {
    while (queue.length) await fetchTile(queue.pop())
  }))
  // Points on a shared tile edge come back twice.
  const unique = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()]
  await mkdir(CACHE, { recursive: true })
  await writeFile(file, JSON.stringify(unique))
  return unique
}

const SCENERY_QUERY = `[out:json][timeout:180][bbox:${BBOX.join(',')}];
(
  node["natural"="tree"];
  node["highway"="street_lamp"];
  way["natural"="tree_row"];
  way["landuse"="forest"];
  way["natural"="wood"];
  relation["landuse"="forest"];
  relation["natural"="wood"];
);
out geom;`

// Region in local metres, with a margin for things just outside.
const [MIN_X, MIN_Y] = project(BBOX[1], BBOX[0])
const [MAX_X, MAX_Y] = project(BBOX[3], BBOX[2])
const inRegion = ([x, y], margin = 0) => x > MIN_X - margin && x < MAX_X + margin && y > MIN_Y - margin && y < MAX_Y + margin

const LEAF = { broadleaved: 1, needleleaved: 2, mixed: 3 }
const TREE_ROW_SPACING = 9

/** Lamp spacing and distance from the centreline (m) per street type. */
const LAMPS = {
  primary: { spacing: 40, offset: 7.5, bothSides: true },
  secondary: { spacing: 40, offset: 7, bothSides: true },
  tertiary: { spacing: 36, offset: 6, bothSides: false },
  unclassified: { spacing: 36, offset: 5.5, bothSides: false },
  residential: { spacing: 32, offset: 4.5, bothSides: false },
  living_street: { spacing: 28, offset: 3.5, bothSides: false },
  pedestrian: { spacing: 24, offset: 3, bothSides: false },
  service: { spacing: 30, offset: 3.5, bothSides: false },
  cycleway: { spacing: 30, offset: 2, bothSides: false },
  footway: { spacing: 28, offset: 1.6, bothSides: false },
  path: { spacing: 30, offset: 1.6, bothSides: false },
}
const URBAN_ROADS = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian'])

function isLit(tags) {
  if (tags.tunnel && tags.tunnel !== 'no') return false
  if (tags.lit === 'no' || tags.lit === 'disused') return false
  if (tags.lit && tags.lit !== 'no') return LAMPS[tags.highway] !== undefined
  // Untagged: Dutch built-up streets are lit; 60/80 km/h roads outside towns mostly aren't.
  if (!URBAN_ROADS.has(tags.highway)) return false
  if ((tags['zone:traffic'] ?? '').includes('rural')) return false
  return tags.highway === 'pedestrian' || carSpeed(tags) <= 50
}

/** Bearing (degrees clockwise from north) of a vector in local metres. */
const bearing = (dx, dy) => Math.round(((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360)

/** Rejects points closer than `min` metres to one already kept. */
function spacingGrid(min) {
  const cells = new Map()
  const key = (cx, cy) => `${cx},${cy}`
  return (x, y) => {
    const cx = Math.floor(x / min)
    const cy = Math.floor(y / min)
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const [px, py] of cells.get(key(cx + i, cy + j)) ?? []) if (Math.hypot(px - x, py - y) < min) return false
      }
    }
    const k = key(cx, cy)
    if (!cells.has(k)) cells.set(k, [])
    cells.get(k).push([x, y])
    return true
  }
}

/** Points every `spacing` metres along a polyline, with the direction there. */
function* along(points, spacing, start = spacing / 2) {
  let next = start
  let travelled = 0
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 1e-6) continue
    while (next <= travelled + len) {
      const t = (next - travelled) / len
      yield { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, dx: (bx - ax) / len, dy: (by - ay) / len }
      next += spacing
    }
    travelled += len
  }
}

// ---------------------------------------------------------------------------
// Trees

/** Joins open ways into closed rings by matching end points. */
function rings(ways) {
  const open = ways.map((w) => [...w])
  const done = []
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3
  while (open.length) {
    let ring = open.pop()
    let grown = true
    while (!same(ring[0], ring.at(-1)) && grown) {
      grown = false
      for (let i = 0; i < open.length; i++) {
        const w = open[i]
        if (same(ring.at(-1), w[0])) ring = [...ring, ...w.slice(1)]
        else if (same(ring.at(-1), w.at(-1))) ring = [...ring, ...w.slice(0, -1).reverse()]
        else if (same(ring[0], w.at(-1))) ring = [...w, ...ring.slice(1)]
        else if (same(ring[0], w[0])) ring = [...w.slice(1).reverse(), ...ring]
        else continue
        open.splice(i, 1)
        grown = true
        break
      }
    }
    if (ring.length >= 4 && same(ring[0], ring.at(-1))) done.push(ring)
  }
  return done
}

function area(ring) {
  let a = 0
  for (let i = 1; i < ring.length; i++) a += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1]
  return Math.abs(a) / 2
}

function inside([x, y], ring) {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function decodeRing(encoded) {
  const ring = []
  let x = 0
  let y = 0
  for (let i = 0; i < encoded.length; i += 2) {
    x += encoded[i]
    y += encoded[i + 1]
    ring.push([x, y])
  }
  return ring
}

/** Integer metres, delta-encoded: [x0, y0, dx1, dy1, …]. */
function encodeRing(ring) {
  const out = []
  let px = 0
  let py = 0
  for (const [x, y] of ring) {
    const ix = Math.round(x)
    const iy = Math.round(y)
    out.push(ix - px, iy - py)
    px = ix
    py = iy
  }
  return out
}

function buildTrees(raw, bgt) {
  const trees = []
  const keep = spacingGrid(3.5)
  const addTree = (x, y, leaf, height) => {
    if (inRegion([x, y]) && keep(x, y)) trees.push([x, y, leaf, height])
  }
  const leafOf = (tags) => LEAF[tags.leaf_type] ?? 0
  const heightOf = (tags) => {
    const h = Number.parseFloat(tags.height ?? '')
    return Number.isFinite(h) && h > 1 && h < 50 ? Math.round(h) : 0
  }
  for (const e of raw.elements) {
    if (e.type === 'node' && e.tags?.natural === 'tree') addTree(...project(e.lon, e.lat), leafOf(e.tags), heightOf(e.tags))
  }
  for (const e of raw.elements) {
    if (e.type !== 'way' || e.tags?.natural !== 'tree_row') continue
    const line = e.geometry.map((g) => project(g.lon, g.lat))
    for (const p of along(line, TREE_ROW_SPACING, 2)) addTree(p.x, p.y, leafOf(e.tags), heightOf(e.tags))
  }

  // Forest and wood outlines (ways and multipolygon relations).
  const polygons = []
  const addPolygon = (outers, inners, tags) => {
    for (const outer of outers) {
      if (area(outer) < 200 || !outer.some((p) => inRegion(p, 200))) continue
      const holes = inners.filter((r) => inside(r[0], outer))
      const encode = (r) => encodeRing(simplify(r, 3))
      polygons.push({ leaf: leafOf(tags), rings: [encode(outer), ...holes.map(encode)] })
    }
  }
  for (const e of raw.elements) {
    const tags = e.tags ?? {}
    if (tags.landuse !== 'forest' && tags.natural !== 'wood') continue
    if (e.type === 'way') {
      const ring = e.geometry.map((g) => project(g.lon, g.lat))
      if (ring.length >= 4) addPolygon([ring], [], tags)
    } else if (e.type === 'relation') {
      const member = (role) => e.members.filter((m) => m.type === 'way' && m.role === role && m.geometry).map((m) => m.geometry.map((g) => project(g.lon, g.lat)))
      addPolygon(rings(member('outer')), rings(member('inner')), tags)
    }
  }

  // BGT trees, except where OSM already has a tree, and inside forests (the app fills those).
  const forests = polygons.map((p) => {
    const ring = decodeRing(p.rings[0])
    const xs = ring.map((q) => q[0])
    const ys = ring.map((q) => q[1])
    return { ring, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }
  })
  const inForest = (pt) => forests.some(({ ring, box }) => pt[0] >= box[0] && pt[0] <= box[2] && pt[1] >= box[1] && pt[1] <= box[3] && inside(pt, ring))
  const osmCount = trees.length
  for (const [lng, lat] of bgt) {
    const pt = project(lng, lat)
    if (!inForest(pt)) addTree(pt[0], pt[1], 0, 0)
  }
  return { trees, polygons, osmCount }
}

// ---------------------------------------------------------------------------
// Street lights

function buildLamps(scenery, roads) {
  const lamps = []
  const keep = spacingGrid(12)
  const lines = []
  for (const way of roads.elements) {
    if (way.type !== 'way' || !way.tags?.highway) continue
    lines.push({ tags: way.tags, points: way.geometry.map((g) => project(g.lon, g.lat)) })
  }

  // Mapped lamps first, with the arm towards the nearest street.
  let mapped = 0
  for (const e of scenery.elements) {
    if (e.type !== 'node' || e.tags?.highway !== 'street_lamp') continue
    const [x, y] = project(e.lon, e.lat)
    if (!inRegion([x, y]) || !keep(x, y)) continue
    let best = { d: 25, heading: 0 }
    for (const { points } of lines) {
      for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1]
        const [bx, by] = points[i]
        if (Math.min(ax, bx) - best.d > x || Math.max(ax, bx) + best.d < x || Math.min(ay, by) - best.d > y || Math.max(ay, by) + best.d < y) continue
        const dx = bx - ax
        const dy = by - ay
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
        const cx = ax + dx * t
        const cy = ay + dy * t
        const d = Math.hypot(cx - x, cy - y)
        if (d < best.d && d > 0.1) best = { d, heading: bearing(cx - x, cy - y) }
      }
    }
    lamps.push([x, y, best.heading, 1])
    mapped++
  }

  // Lamps along lit streets, on the right-hand side (alternating on wide roads).
  for (const { tags, points } of lines) {
    const rule = LAMPS[tags.highway]
    if (!rule || !isLit(tags)) continue
    let side = 1
    for (const p of along(points, rule.bothSides ? rule.spacing / 2 : rule.spacing)) {
      // Right of the direction of travel: (dy, -dx).
      const nx = p.dy * side
      const ny = -p.dx * side
      const x = p.x + nx * rule.offset
      const y = p.y + ny * rule.offset
      if (rule.bothSides) side = -side
      if (!inRegion([x, y]) || !keep(x, y)) continue
      lamps.push([x, y, bearing(-nx, -ny), 0])
    }
  }
  return { lamps, mapped }
}

/** Flat integer columns, the first two (x, y in metres) delta-encoded. */
function encodePoints(points) {
  const out = []
  let px = 0
  let py = 0
  for (const [x, y, ...rest] of points) {
    const ix = Math.round(x)
    const iy = Math.round(y)
    out.push(ix - px, iy - py, ...rest)
    px = ix
    py = iy
  }
  return out
}

async function main() {
  const refresh = process.argv.includes('--refresh')
  const scenery = await overpass('scenery', SCENERY_QUERY, refresh)
  const roads = await overpass('network', NETWORK_QUERY, false)
  const { trees, polygons, osmCount } = buildTrees(scenery, await bgtTrees(refresh))
  const { lamps, mapped } = buildLamps(scenery, roads)
  const file = {
    meta: {
      description: 'Trees and street lights for the Gooi Digital Twin map',
      source: 'OpenStreetMap contributors, via the Overpass API; trees also from the BGT (Basisregistratie Grootschalige Topografie), via PDOK',
      license: 'ODbL 1.0 (https://www.openstreetmap.org/copyright); BGT: CC0 1.0',
      osmTimestamp: scenery.osm3s?.timestamp_osm_base ?? null,
      generated: new Date().toISOString(),
      projection: { lng0: LNG0, lat0: LAT0, kx: KX, ky: KY, unit: 1 },
      note:
        'Mapped trees and tree rows are at their OSM or BGT positions; forests are outlines the app fills with illustrative trees. ' +
        'Mapped street lamps are marked source 1; other lamps (source 0) are placed by rule along lit streets and are illustrative.',
    },
    /** Per tree: x, y (delta), leaf type (0 unknown, 1 broadleaved, 2 needleleaved, 3 mixed), height in m (0 unknown). */
    trees: encodePoints(trees),
    /** Forest and wood outlines: first ring outer, then holes; integer metres, delta-encoded per ring. */
    forests: polygons,
    /** Per lamp: x, y (delta), bearing of the arm towards the street, source (1 mapped in OSM, 0 placed by rule). */
    lamps: encodePoints(lamps),
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(resolve(OUT, 'gooi-scenery.json'), JSON.stringify(file))
  console.log(`scenery: ${trees.length} mapped trees (${osmCount} OSM, ${trees.length - osmCount} BGT), ${polygons.length} forest polygons, ${lamps.length} lamps (${mapped} mapped)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

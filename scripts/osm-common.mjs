/*
 * Shared helpers for the data scripts: the region, the local metric
 * projection used by the app, cached Overpass downloads and geometry.
 *
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CACHE = resolve(ROOT, 'scripts/.cache')
export const OUT = resolve(ROOT, 'public/data')

// south, west, north, east: Hilversum to the Gooimeer, Naarden to Eemnes.
export const BBOX = [52.19, 5.12, 52.33, 5.32]

/** Every street and path in the region (shared by the network and scenery scripts). */
export const NETWORK_QUERY = `[out:json][timeout:180];
way["highway"]["area"!="yes"](${BBOX.join(',')});
out geom;`

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

// Local metric projection shared with the app: x east, y north, in metres.
export const LNG0 = (BBOX[1] + BBOX[3]) / 2
export const LAT0 = (BBOX[0] + BBOX[2]) / 2
export const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180)
export const KY = 110_574
export const project = (lng, lat) => [(lng - LNG0) * KX, (lat - LAT0) * KY]
// ---------------------------------------------------------------------------
// Download

/** Overpass query, cached in scripts/.cache/<name>.json unless `refresh` is set. */
export async function overpass(name, query, refresh) {
  const file = resolve(CACHE, `${name}.json`)
  if (!refresh) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      // not cached yet
    }
  }
  for (const endpoint of ENDPOINTS) {
    try {
      console.log(`${name}: querying ${endpoint} …`)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'gooi-digital-twin/0.2 (+https://github.com/Teun-sudo1/gooi-digital-twin)',
        },
        body: new URLSearchParams({ data: query }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      await mkdir(CACHE, { recursive: true })
      await writeFile(file, JSON.stringify(json))
      return json
    } catch (error) {
      console.warn(`  failed: ${error.message}`)
    }
  }
  throw new Error(`All Overpass endpoints failed for ${name}.`)
}

// ---------------------------------------------------------------------------
// Geometry and tags

/** Douglas–Peucker simplification of a polyline in metres, keeping both ends. */
export function simplify(points, tolerance) {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = points[a]
    const [bx, by] = points[b]
    const len = Math.hypot(bx - ax, by - ay)
    let worst = -1
    let index = -1
    for (let i = a + 1; i < b; i++) {
      // Distance to the chord; for a closed loop (both ends equal) the distance to that point.
      const d =
        len < 1e-6
          ? Math.hypot(points[i][0] - ax, points[i][1] - ay)
          : Math.abs((bx - ax) * (ay - points[i][1]) - (ax - points[i][0]) * (by - ay)) / len
      if (d > worst) {
        worst = d
        index = i
      }
    }
    if (worst > tolerance) {
      keep[index] = 1
      stack.push([a, index], [index, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

export function polylineLength(points) {
  let length = 0
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  }
  return length
}

const DEFAULT_SPEED = {
  motorway: 100, motorway_link: 60, trunk: 80, trunk_link: 50, primary: 50, primary_link: 50,
  secondary: 50, secondary_link: 50, tertiary: 50, tertiary_link: 50, unclassified: 50,
  residential: 30, living_street: 15,
}
export const ZONE_SPEEDS = { 'NL:urban': 50, 'NL:rural': 80, 'NL:zone30': 30, 'NL:zone60': 60, 'NL:motorway': 100 }

/** Car speed limit (km/h) from OSM tags, with Dutch defaults. */
export function carSpeed(tags) {
  const raw = tags.maxspeed
  if (raw) {
    if (ZONE_SPEEDS[raw]) return ZONE_SPEEDS[raw]
    const n = Number.parseFloat(raw)
    if (Number.isFinite(n) && n > 0) return Math.round(raw.includes('mph') ? n * 1.609 : n)
  }
  return DEFAULT_SPEED[tags.highway] ?? 50
}

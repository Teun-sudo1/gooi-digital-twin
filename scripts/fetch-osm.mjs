#!/usr/bin/env node
/*
 * Builds the data files for the Gooi region traffic simulation from OpenStreetMap:
 *
 *   public/data/gooi-network.json  multimodal street network (car, bike, foot)
 *   public/data/gooi-transit.json  bus and train lines with their stops
 *
 *   node scripts/fetch-osm.mjs            # use cached Overpass responses if present
 *   node scripts/fetch-osm.mjs --refresh  # download fresh data
 *
 * Raw Overpass responses are cached in scripts/.cache (git-ignored). The
 * outputs are committed, so the app never queries Overpass at runtime.
 *
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = resolve(ROOT, 'scripts/.cache')
const OUT = resolve(ROOT, 'public/data')

// south, west, north, east: Hilversum to the Gooimeer, Naarden to Eemnes.
const BBOX = [52.19, 5.12, 52.33, 5.32]
// Transit geometry is kept a little beyond the street network, so trains and
// buses visibly arrive from and leave towards the rest of the country.
const TRANSIT_BBOX = [52.17, 5.08, 52.35, 5.36]

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

const NETWORK_QUERY = `[out:json][timeout:180];
way["highway"]["area"!="yes"](${BBOX.join(',')});
out geom;`

const TRANSIT_QUERY = `[out:json][timeout:180];
relation["type"="route"]["route"~"^(bus|train)$"](${BBOX.join(',')});
out geom(${TRANSIT_BBOX.join(',')});`

// Local metric projection shared with the app: x east, y north, in metres.
const LNG0 = (BBOX[1] + BBOX[3]) / 2
const LAT0 = (BBOX[0] + BBOX[2]) / 2
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180)
const KY = 110_574
const project = (lng, lat) => [(lng - LNG0) * KX, (lat - LAT0) * KY]
/** Coordinates are stored as integer decimetres. */
const dm = (v) => Math.round(v * 10)

// ---------------------------------------------------------------------------
// Download

async function overpass(name, query, refresh) {
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
// Geometry helpers

/** Douglas–Peucker simplification of a polyline in metres, keeping both ends. */
function simplify(points, tolerance) {
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

function polylineLength(points) {
  let length = 0
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  }
  return length
}

/** Delta-encodes points as integer decimetres: [x0, y0, dx1, dy1, …]. */
function encode(points, startX = 0, startY = 0) {
  const out = []
  let px = startX
  let py = startY
  for (const [x, y] of points) {
    const ix = dm(x)
    const iy = dm(y)
    out.push(ix - px, iy - py)
    px = ix
    py = iy
  }
  return out
}

/** Nearest distance along a polyline to a point, plus the perpendicular offset. */
function locate(points, cumulative, [x, y]) {
  let best = { along: 0, offset: Infinity }
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
    const offset = Math.hypot(ax + dx * t - x, ay + dy * t - y)
    if (offset < best.offset) best = { along: cumulative[i - 1] + t * Math.sqrt(len2), offset }
  }
  return best
}

// ---------------------------------------------------------------------------
// Street network

const CAR = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street',
])
const BIKE_ROADS = new Set([
  'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'unclassified', 'residential', 'living_street', 'service', 'cycleway',
])
const BIKE_IF_SIGNED = new Set(['path', 'track', 'footway', 'pedestrian', 'bridleway'])
const FOOT = new Set([
  'footway', 'pedestrian', 'path', 'steps', 'living_street', 'residential', 'service', 'track',
  'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link',
])
const FOOT_IF_SIGNED = new Set(['cycleway', 'bridleway'])
/** Driveways and parking aisles add volume without adding useful routes. */
const SKIP_SERVICE = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access'])

const YES = new Set(['yes', 'designated', 'permissive', 'destination'])
const NO = new Set(['no', 'private', 'use_sidepath', 'dismount'])

const DEFAULT_SPEED = {
  motorway: 100, motorway_link: 60, trunk: 80, trunk_link: 50, primary: 50, primary_link: 50,
  secondary: 50, secondary_link: 50, tertiary: 50, tertiary_link: 50, unclassified: 50,
  residential: 30, living_street: 15,
}
const ZONE_SPEEDS = { 'NL:urban': 50, 'NL:rural': 80, 'NL:zone30': 30, 'NL:zone60': 60, 'NL:motorway': 100 }

// Flag bits per segment (also used by the app).
const CAR_FWD = 1
const CAR_BWD = 2
const BIKE_FWD = 4
const BIKE_BWD = 8
const FOOT_ANY = 16
const ROUNDABOUT = 32

function carSpeed(tags) {
  const raw = tags.maxspeed
  if (raw) {
    if (ZONE_SPEEDS[raw]) return ZONE_SPEEDS[raw]
    const n = Number.parseFloat(raw)
    if (Number.isFinite(n) && n > 0) return Math.round(raw.includes('mph') ? n * 1.609 : n)
  }
  return DEFAULT_SPEED[tags.highway] ?? 50
}

function permissions(tags) {
  const hw = tags.highway
  const closed = NO.has(tags.access)
  let flags = 0

  // Cars
  if (CAR.has(hw) && !(closed && !YES.has(tags.motor_vehicle)) && !NO.has(tags.motor_vehicle) && !NO.has(tags.motorcar)) {
    const oneway = tags.oneway
    const roundabout = tags.junction === 'roundabout' || tags.junction === 'circular'
    if (oneway === '-1' || oneway === 'reverse') flags |= CAR_BWD
    else if (oneway === 'yes' || oneway === 'true' || oneway === '1' || (oneway !== 'no' && (roundabout || hw === 'motorway'))) flags |= CAR_FWD
    else flags |= CAR_FWD | CAR_BWD
  }

  // Bicycles
  const bike = tags.bicycle
  const bikeAllowed =
    !NO.has(bike) &&
    !(closed && !YES.has(bike)) &&
    (BIKE_ROADS.has(hw) || (BIKE_IF_SIGNED.has(hw) && YES.has(bike))) &&
    !(hw === 'service' && SKIP_SERVICE.has(tags.service))
  if (bikeAllowed) {
    const oneway = tags['oneway:bicycle'] ?? (hw === 'cycleway' ? tags.oneway : tags.oneway)
    const contraflow = tags['oneway:bicycle'] === 'no' || tags['cycleway'] === 'opposite' || tags['cycleway'] === 'opposite_lane'
    const roundabout = tags.junction === 'roundabout'
    if (!contraflow && (oneway === '-1')) flags |= BIKE_BWD
    else if (!contraflow && (oneway === 'yes' || oneway === '1' || roundabout)) flags |= BIKE_FWD
    else flags |= BIKE_FWD | BIKE_BWD
  }

  // Pedestrians (direction-free). Skip roads whose sidewalks are mapped as separate footways.
  const foot = tags.foot
  const separateSidewalk = [tags.sidewalk, tags['sidewalk:both'], tags['sidewalk:left'], tags['sidewalk:right']].includes('separate')
  const footAllowed =
    !NO.has(foot) &&
    !(closed && !YES.has(foot)) &&
    (FOOT.has(hw) || (FOOT_IF_SIGNED.has(hw) && YES.has(foot))) &&
    !separateSidewalk &&
    !(hw === 'service' && SKIP_SERVICE.has(tags.service))
  if (footAllowed) flags |= FOOT_ANY

  if (tags.junction === 'roundabout' || tags.junction === 'circular') flags |= ROUNDABOUT
  return flags
}

/** Largest strongly connected component (iterative Kosaraju) over directed adjacency. */
function largestSCC(count, out, inc) {
  const visited = new Uint8Array(count)
  const order = []
  for (let start = 0; start < count; start++) {
    if (visited[start] || !out[start]) continue
    const stack = [[start, 0]]
    visited[start] = 1
    while (stack.length) {
      const top = stack[stack.length - 1]
      const next = out[top[0]] ?? []
      if (top[1] < next.length) {
        const v = next[top[1]++]
        if (!visited[v]) {
          visited[v] = 1
          stack.push([v, 0])
        }
      } else {
        order.push(top[0])
        stack.pop()
      }
    }
  }
  const assigned = new Uint8Array(count)
  let best = []
  for (let i = order.length - 1; i >= 0; i--) {
    const root = order[i]
    if (assigned[root]) continue
    const component = []
    const stack = [root]
    assigned[root] = 1
    while (stack.length) {
      const u = stack.pop()
      component.push(u)
      for (const v of inc[u] ?? []) {
        if (!assigned[v]) {
          assigned[v] = 1
          stack.push(v)
        }
      }
    }
    if (component.length > best.length) best = component
  }
  return new Set(best)
}

function buildNetwork(raw) {
  const ways = raw.elements
    .filter((e) => e.type === 'way' && e.geometry?.length >= 2)
    .map((way) => ({ way, flags: permissions(way.tags) }))
    .filter((w) => w.flags & (CAR_FWD | CAR_BWD | BIKE_FWD | BIKE_BWD | FOOT_ANY))

  const uses = new Map()
  for (const { way } of ways) for (const id of way.nodes) uses.set(id, (uses.get(id) ?? 0) + 1)

  const segments = []
  for (const { way, flags } of ways) {
    const pts = way.geometry.map((p) => project(p.lon, p.lat))
    let start = 0
    for (let i = 1; i < way.nodes.length; i++) {
      if (i < way.nodes.length - 1 && uses.get(way.nodes[i]) < 2) continue
      const points = pts.slice(start, i + 1)
      const length = polylineLength(points)
      if (length > 0.5) {
        segments.push({
          way: way.id,
          tags: way.tags,
          flags,
          fromId: way.nodes[start],
          toId: way.nodes[i],
          points: simplify(points, 0.7),
          length,
        })
      }
      start = i
    }
  }

  // Keep each mode's permissions only inside that mode's main connected network.
  const nodeIndex = new Map()
  const idx = (id) => {
    if (!nodeIndex.has(id)) nodeIndex.set(id, nodeIndex.size)
    return nodeIndex.get(id)
  }
  for (const s of segments) {
    s.from = idx(s.fromId)
    s.to = idx(s.toId)
  }
  const n = nodeIndex.size
  const position = new Array(n)
  for (const s of segments) {
    position[s.from] = s.points[0]
    position[s.to] = s.points[s.points.length - 1]
  }
  const [minX, minY] = project(BBOX[1], BBOX[0])
  const [maxX, maxY] = project(BBOX[3], BBOX[2])
  const nearEdge = ([x, y]) => Math.min(x - minX, maxX - x, y - minY, maxY - y) < 200

  const restrict = (fwd, bwd) => {
    // Index n is a virtual "outside world" node joined to every loose end at the
    // edge of the area, so roads that enter or leave the region (one-way motorway
    // carriageways, for example) stay in the network instead of being cut off.
    const out = new Array(n + 1)
    const inc = new Array(n + 1)
    const degree = new Uint32Array(n)
    const link = (a, b) => {
      ;(out[a] ??= []).push(b)
      ;(inc[b] ??= []).push(a)
    }
    for (const s of segments) {
      if (!(s.flags & (fwd | bwd))) continue
      degree[s.from]++
      degree[s.to]++
      if (s.flags & fwd) link(s.from, s.to)
      if (s.flags & bwd) link(s.to, s.from)
    }
    for (let i = 0; i < n; i++) {
      if (degree[i] === 1 && nearEdge(position[i])) {
        link(i, n)
        link(n, i)
      }
    }
    const keep = largestSCC(n + 1, out, inc)
    let removed = 0
    for (const s of segments) {
      if (s.flags & (fwd | bwd) && !(keep.has(s.from) && keep.has(s.to))) {
        s.flags &= ~(fwd | bwd)
        removed++
      }
    }
    return { kept: keep.size, removed }
  }
  const car = restrict(CAR_FWD, CAR_BWD)
  const bike = restrict(BIKE_FWD, BIKE_BWD)
  const foot = restrict(FOOT_ANY, FOOT_ANY)
  console.log(`car network ${car.kept} nodes (${car.removed} segments cut off)`)
  console.log(`bike network ${bike.kept} nodes (${bike.removed} cut off)`)
  console.log(`foot network ${foot.kept} nodes (${foot.removed} cut off)`)

  const used = segments.filter((s) => s.flags & (CAR_FWD | CAR_BWD | BIKE_FWD | BIKE_BWD | FOOT_ANY))

  // Compact node and string tables.
  const finalIndex = new Map()
  const nodes = []
  const nodeOf = (old, point) => {
    if (!finalIndex.has(old)) {
      finalIndex.set(old, finalIndex.size)
      nodes.push(dm(point[0]), dm(point[1]))
    }
    return finalIndex.get(old)
  }
  const classes = []
  const names = []
  const tableIndex = (table, value) => {
    let i = table.indexOf(value)
    if (i < 0) i = table.push(value) - 1
    return i
  }

  const columns = { from: [], to: [], cls: [], name: [], speed: [], flags: [], way: [], geom: [] }
  for (const s of used) {
    const from = nodeOf(s.from, s.points[0])
    const to = nodeOf(s.to, s.points[s.points.length - 1])
    const hasCar = s.flags & (CAR_FWD | CAR_BWD)
    columns.from.push(from)
    columns.to.push(to)
    columns.cls.push(tableIndex(classes, s.tags.highway))
    columns.name.push(s.tags.name ? tableIndex(names, s.tags.name) : -1)
    columns.speed.push(hasCar ? carSpeed(s.tags) : 0)
    columns.flags.push(s.flags & (CAR_FWD | CAR_BWD | BIKE_FWD | BIKE_BWD | FOOT_ANY | ROUNDABOUT))
    columns.way.push(s.way)
    // Interior points only; the ends are the nodes. Deltas start from the from-node.
    columns.geom.push(encode(s.points.slice(1, -1), nodes[from * 2], nodes[from * 2 + 1]))
  }

  return {
    meta: {
      description: 'Multimodal street network of the Gooi region (NL) for the Gooi Digital Twin simulation',
      source: 'OpenStreetMap contributors, via the Overpass API',
      license: 'ODbL 1.0 (https://www.openstreetmap.org/copyright)',
      osmTimestamp: raw.osm3s?.timestamp_osm_base ?? null,
      generated: new Date().toISOString(),
      bbox: [BBOX[1], BBOX[0], BBOX[3], BBOX[2]],
      projection: { lng0: LNG0, lat0: LAT0, kx: KX, ky: KY, unit: 0.1 },
      flags: { CAR_FWD, CAR_BWD, BIKE_FWD, BIKE_BWD, FOOT_ANY, ROUNDABOUT },
    },
    classes,
    names,
    nodes,
    segments: columns,
  }
}

// ---------------------------------------------------------------------------
// Public transport

/** Long-distance coaches and night trains add little to a regional model. */
const EXCLUDED_OPERATORS = /flixbus|european sleeper/i

/** Joins a relation's ordered way members into continuous polylines (in metres). */
function stitch(members) {
  const runs = []
  for (const m of members) {
    if (m.type !== 'way' || !(m.role === '' || m.role === 'forward' || m.role === 'backward') || !m.geometry) continue
    // Points outside the clip box are null: split there.
    let run = []
    for (const p of m.geometry) {
      if (p) run.push(project(p.lon, p.lat))
      else if (run.length) {
        runs.push({ points: run, broken: true })
        run = []
      }
    }
    if (run.length >= 2) runs.push({ points: run, broken: false })
  }

  const pieces = []
  let line = null
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 2
  for (const { points } of runs) {
    if (!line) {
      line = [...points]
      continue
    }
    const end = line[line.length - 1]
    const first = points[0]
    const last = points[points.length - 1]
    if (close(end, first)) line.push(...points.slice(1))
    else if (close(end, last)) line.push(...[...points].reverse().slice(1))
    else if (line.length === points.length || pieces.length === 0) {
      // The first way may be stored against the direction of travel.
      if (close(line[0], first)) line = [...line.reverse(), ...points.slice(1)]
      else if (close(line[0], last)) line = [...line.reverse(), ...[...points].reverse().slice(1)]
      else {
        pieces.push(line)
        line = [...points]
      }
    } else {
      pieces.push(line)
      line = [...points]
    }
  }
  if (line) pieces.push(line)
  return pieces
}

function buildTransit(raw) {
  const lines = []
  const seen = new Set()
  for (const rel of raw.elements) {
    const t = rel.tags
    if (EXCLUDED_OPERATORS.test(`${t.operator ?? ''} ${t.name ?? ''} ${t.network ?? ''}`)) continue
    const interval = parseInterval(t.interval)
    if (interval !== null && interval > 180) continue // weekly or occasional services

    const pieces = stitch(rel.members)
    if (!pieces.length) continue
    const piece = pieces.reduce((a, b) => (polylineLength(b) > polylineLength(a) ? b : a))
    const points = simplify(piece, 1.5)
    const length = polylineLength(points)
    if (length < 800) continue
    // Some routes are mapped twice (duplicate relations); keep one.
    const key = `${t.route}|${t.name}|${Math.round(length / 50)}`
    if (seen.has(key)) continue
    seen.add(key)

    const cumulative = [0]
    for (let i = 1; i < points.length; i++) {
      cumulative.push(cumulative[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]))
    }

    // Stops: stop positions and platforms, projected onto the line, merged when close.
    // (Member tags such as stop names are not included in this Overpass output.)
    const stops = []
    for (const m of rel.members) {
      if (!/^(stop|platform)/.test(m.role)) continue
      const first = m.type === 'node' ? (m.lat ? m : null) : m.geometry?.find(Boolean)
      if (!first) continue
      const hit = locate(points, cumulative, project(first.lon, first.lat))
      if (hit.offset > (t.route === 'train' ? 60 : 35)) continue
      stops.push(hit.along)
    }
    stops.sort((a, b) => a - b)
    const merged = []
    for (const along of stops) {
      if (!merged.length || along - merged[merged.length - 1] > (t.route === 'train' ? 250 : 60)) merged.push(along)
    }

    lines.push({
      id: rel.id,
      mode: t.route,
      ref: t.ref ?? '',
      name: t.name ?? '',
      from: t.from ?? null,
      to: t.to ?? null,
      operator: t.operator ?? null,
      colour: t.colour ?? null,
      interval,
      length: Math.round(length),
      geom: encode(points),
      stops: merged.map(Math.round),
    })
  }
  console.log(`${lines.length} transit lines (${lines.filter((l) => l.mode === 'train').length} train)`)
  return {
    meta: {
      description: 'Bus and train lines through the Gooi region, for the Gooi Digital Twin simulation',
      source: 'OpenStreetMap contributors (public transport route relations), via the Overpass API',
      license: 'ODbL 1.0 (https://www.openstreetmap.org/copyright)',
      osmTimestamp: raw.osm3s?.timestamp_osm_base ?? null,
      generated: new Date().toISOString(),
      projection: { lng0: LNG0, lat0: LAT0, kx: KX, ky: KY, unit: 0.1 },
      note: 'Routes and stops are from OSM. Frequencies use the OSM interval tag where present, otherwise app assumptions.',
    },
    lines,
  }
}

/** OSM interval: "30", "00:30", "02:00" → minutes. */
function parseInterval(value) {
  if (!value) return null
  const match = /^(\d+)(?::(\d+))?$/.exec(value.trim())
  if (!match) return null
  return match[2] === undefined ? Number(match[1]) : Number(match[1]) * 60 + Number(match[2])
}

async function main() {
  const refresh = process.argv.includes('--refresh')
  const network = buildNetwork(await overpass('network', NETWORK_QUERY, refresh))
  const transit = buildTransit(await overpass('transit', TRANSIT_QUERY, refresh))
  await mkdir(OUT, { recursive: true })
  await writeFile(resolve(OUT, 'gooi-network.json'), JSON.stringify(network))
  await writeFile(resolve(OUT, 'gooi-transit.json'), JSON.stringify(transit))
  console.log(`network: ${network.nodes.length / 2} nodes, ${network.segments.from.length} segments`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

#!/usr/bin/env node
/*
 * Builds the routable road graph used by the traffic simulation.
 *
 *   node scripts/fetch-roads.mjs                  # download from Overpass
 *   node scripts/fetch-roads.mjs --input raw.json # reuse a saved Overpass response
 *
 * Downloads the drivable OpenStreetMap roads of Huizen once, splits them at
 * real junctions, and writes public/data/huizen-roads.json. The output is
 * committed, so the app never queries Overpass at runtime.
 *
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = resolve(ROOT, 'public/data/huizen-roads.json')

// south, west, north, east: the built-up area of Huizen.
const BBOX = [52.283, 5.2, 52.318, 5.278]

const HIGHWAYS = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street',
]

const QUERY = `[out:json][timeout:90];
way["highway"~"^(${HIGHWAYS.join('|')})$"]["access"!~"^(no|private)$"]["motor_vehicle"!~"^(no|private)$"]["area"!="yes"](${BBOX.join(',')});
out geom;`

// Public Overpass instances, tried in order. Be gentle: this runs rarely.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

/** Fallback speeds (km/h) when a road has no usable maxspeed tag, following Dutch defaults. */
const DEFAULT_SPEED = {
  motorway: 100, motorway_link: 50, trunk: 80, trunk_link: 50,
  primary: 50, primary_link: 50, secondary: 50, secondary_link: 50,
  tertiary: 50, tertiary_link: 50, unclassified: 50, residential: 30, living_street: 15,
}

const ZONE_SPEEDS = { 'NL:urban': 50, 'NL:rural': 80, 'NL:zone30': 30, 'NL:zone60': 60, 'NL:motorway': 100 }

async function download() {
  for (const endpoint of ENDPOINTS) {
    try {
      console.log(`Querying ${endpoint} …`)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'gooi-digital-twin/0.1 (+https://github.com/Teun-sudo1/gooi-digital-twin)',
        },
        body: new URLSearchParams({ data: QUERY }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      console.warn(`  failed: ${error.message}`)
    }
  }
  throw new Error('All Overpass endpoints failed. Try again later or pass --input.')
}

function haversine([lng1, lat1], [lng2, lat2]) {
  const R = 6371008.8
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLng = (lng2 - lng1) * toRad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function parseSpeed(tags) {
  const raw = tags.maxspeed
  if (raw) {
    if (ZONE_SPEEDS[raw]) return { speed: ZONE_SPEEDS[raw], source: 'osm' }
    const n = Number.parseFloat(raw)
    if (Number.isFinite(n) && n > 0) return { speed: raw.includes('mph') ? Math.round(n * 1.609) : n, source: 'osm' }
  }
  return { speed: DEFAULT_SPEED[tags.highway] ?? 50, source: 'default' }
}

/** +1: drivable along the way's node order only, -1: against it only, 0: both directions. */
function direction(tags) {
  const oneway = tags.oneway
  if (oneway === '-1' || oneway === 'reverse') return -1
  if (oneway === 'yes' || oneway === 'true' || oneway === '1') return 1
  if (oneway === 'no') return 0
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1
  if (tags.highway === 'motorway') return 1
  return 0
}

const round = (v) => Math.round(v * 1e6) / 1e6

/**
 * Kosaraju's algorithm (iterative) over the directed road graph. Returns the
 * set of node ids in the largest strongly connected component: the part of
 * the network where every node can reach every other node.
 */
function largestSCC(nodeIds, out, inc) {
  const visited = new Set()
  const order = []
  for (const start of nodeIds) {
    if (visited.has(start)) continue
    const stack = [[start, 0]]
    visited.add(start)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const next = out.get(top[0]) ?? []
      if (top[1] < next.length) {
        const v = next[top[1]++]
        if (!visited.has(v)) {
          visited.add(v)
          stack.push([v, 0])
        }
      } else {
        order.push(top[0])
        stack.pop()
      }
    }
  }
  const assigned = new Set()
  let best = []
  for (let i = order.length - 1; i >= 0; i--) {
    const root = order[i]
    if (assigned.has(root)) continue
    const component = []
    const stack = [root]
    assigned.add(root)
    while (stack.length) {
      const u = stack.pop()
      component.push(u)
      for (const v of inc.get(u) ?? []) {
        if (!assigned.has(v)) {
          assigned.add(v)
          stack.push(v)
        }
      }
    }
    if (component.length > best.length) best = component
  }
  return new Set(best)
}

async function main() {
  const inputIndex = process.argv.indexOf('--input')
  const raw = inputIndex > 0
    ? JSON.parse(await readFile(process.argv[inputIndex + 1], 'utf8'))
    : await download()
  const ways = raw.elements.filter((e) => e.type === 'way' && e.geometry?.length >= 2)
  console.log(`${ways.length} ways`)

  // A node is a graph vertex if it ends a way or is shared by several ways.
  const uses = new Map()
  for (const way of ways) {
    for (const id of way.nodes) uses.set(id, (uses.get(id) ?? 0) + 1)
  }

  const segments = []
  for (const way of ways) {
    const { speed, source } = parseSpeed(way.tags)
    const dir = direction(way.tags)
    let start = 0
    for (let i = 1; i < way.nodes.length; i++) {
      const isVertex = i === way.nodes.length - 1 || uses.get(way.nodes[i]) > 1
      if (!isVertex) continue
      let nodes = way.nodes.slice(start, i + 1)
      let coords = way.geometry.slice(start, i + 1).map((p) => [round(p.lon), round(p.lat)])
      if (dir === -1) {
        nodes = nodes.reverse()
        coords = coords.reverse()
      }
      let length = 0
      for (let k = 1; k < coords.length; k++) length += haversine(coords[k - 1], coords[k])
      if (length > 0.5) {
        segments.push({
          way: way.id,
          name: way.tags.name ?? null,
          class: way.tags.highway,
          speed,
          speedSource: source,
          oneway: dir !== 0,
          roundabout: way.tags.junction === 'roundabout' || way.tags.junction === 'circular',
          fromId: nodes[0],
          toId: nodes[nodes.length - 1],
          length: Math.round(length * 10) / 10,
          coords,
        })
      }
      start = i
    }
  }

  const out = new Map()
  const inc = new Map()
  const link = (a, b) => {
    if (!out.has(a)) out.set(a, [])
    if (!inc.has(b)) inc.set(b, [])
    out.get(a).push(b)
    inc.get(b).push(a)
  }
  const nodeIds = new Set()
  for (const s of segments) {
    nodeIds.add(s.fromId)
    nodeIds.add(s.toId)
    link(s.fromId, s.toId)
    if (!s.oneway) link(s.toId, s.fromId)
  }
  const keep = largestSCC([...nodeIds], out, inc)
  const kept = segments.filter((s) => keep.has(s.fromId) && keep.has(s.toId))
  console.log(`${segments.length} segments, ${kept.length} in the largest strongly connected network`)

  // Compact node indices.
  const index = new Map()
  const nodes = []
  const nodeIndex = (id, coord) => {
    if (!index.has(id)) {
      index.set(id, nodes.length)
      nodes.push(coord)
    }
    return index.get(id)
  }

  const output = {
    meta: {
      description: 'Drivable road network of Huizen (NL) for the Gooi Digital Twin traffic simulation',
      source: 'OpenStreetMap contributors, via the Overpass API',
      license: 'ODbL 1.0 (https://www.openstreetmap.org/copyright)',
      osmTimestamp: raw.osm3s?.timestamp_osm_base ?? null,
      bbox: [BBOX[1], BBOX[0], BBOX[3], BBOX[2]],
      generated: new Date().toISOString(),
    },
    nodes,
    segments: kept.map((s, i) => ({
      id: `s${i}`,
      way: s.way,
      name: s.name,
      class: s.class,
      speed: s.speed,
      speedSource: s.speedSource,
      oneway: s.oneway,
      roundabout: s.roundabout,
      from: nodeIndex(s.fromId, s.coords[0]),
      to: nodeIndex(s.toId, s.coords[s.coords.length - 1]),
      length: s.length,
      coords: s.coords,
    })),
  }

  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, JSON.stringify(output))
  console.log(`Wrote ${nodes.length} nodes and ${kept.length} segments to ${OUTPUT}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

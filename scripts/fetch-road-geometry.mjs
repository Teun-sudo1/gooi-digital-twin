#!/usr/bin/env node
/*
 * Builds public/data/gooi-road-geometry.json: where the asphalt really is
 * along each street of the network, measured from the BGT (Basisregistratie
 * Grootschalige Topografie, the measured outlines of every carriageway; via
 * the PDOK OGC API, CC0).
 *
 * Every 10 m along a street (away from its junctions) a cross-section is
 * taken through the carriageway outlines. On a two-way street the asphalt
 * around the OSM line is split down the middle; where the OSM line runs
 * down a median (a dual carriageway mapped as one street), the carriageways
 * on either side are used. The medians over all cross-sections give, per
 * direction, the inner and outer edge of the carriageway in metres right of
 * the direction of travel. The app places lanes between them and estimates
 * the lane count from the width where OSM has none (lanes.ts).
 *
 *   node scripts/fetch-road-geometry.mjs            # use the cached BGT download if present
 *   node scripts/fetch-road-geometry.mjs --refresh  # download fresh outlines
 *
 * Run after fetch-osm.mjs: rows are by segment of gooi-network.json.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BBOX, CACHE, OUT, project } from './osm-common.mjs'

const WEGDEEL = 'https://api.pdok.nl/lv/bgt/ogc/v1/collections/wegdeel/items'
/** Surfaces cars drive on. */
const CARRIAGEWAY = ['rijbaan autosnelweg', 'rijbaan autoweg', 'rijbaan regionale weg', 'rijbaan lokale weg', 'transitie', 'woonerf']
const TILE = 0.01
const PARALLEL = 6

/** Cross-sections every this many metres, keeping this far from junctions (they're messy there). */
const SPACING = 10
const SETBACK = 12
/** How far (m) to either side of the OSM line to look for asphalt. */
const REACH = 30
/** A median wider than this (m) means the asphalt on the far side belongs to another road. */
const MAX_MEDIAN = 15
const MIN_WIDTH = 2.4
const MAX_WIDTH = 17

/** Carriageway outlines in local metres (outer ring first), cached in scripts/.cache. */
async function carriageways(refresh) {
  const file = resolve(CACHE, 'bgt-carriageways.json')
  if (!refresh) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      // not cached yet
    }
  }
  // Progress is saved as it goes, so an interrupted download resumes.
  const partialFile = resolve(CACHE, 'bgt-carriageways.partial.json')
  let partial = { done: [], pieces: {} }
  try {
    partial = JSON.parse(await readFile(partialFile, 'utf8'))
  } catch {
    // starting fresh
  }
  const finished = new Set(partial.done)
  const byId = new Map(Object.entries(partial.pieces))
  const [south, west, north, east] = BBOX
  const jobs = []
  for (let lng = west; lng < east - 1e-9; lng += TILE) {
    for (let lat = south; lat < north - 1e-9; lat += TILE) {
      for (const functie of CARRIAGEWAY) jobs.push({ box: [lng, lat, Math.min(lng + TILE, east), Math.min(lat + TILE, north)], functie })
    }
  }
  const keyOf = ({ box, functie }) => `${box.map((v) => v.toFixed(5)).join(',')}|${functie}`
  let done = 0
  let skipped = 0
  const save = () => writeFile(partialFile, JSON.stringify({ done: [...finished], pieces: Object.fromEntries(byId) }))

  const fetchPage = async (url) => {
    for (let attempt = 0; ; attempt++) {
      try {
        // A hung request would stall the whole download: give up after a minute and retry.
        const response = await fetch(url, { headers: { Accept: 'application/geo+json' }, signal: AbortSignal.timeout(60_000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      } catch (error) {
        if (attempt >= 5) throw error
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
      }
    }
  }
  const fetchJob = async (job) => {
    const key = keyOf(job)
    if (finished.has(key)) return
    const found = new Map()
    try {
      let url = `${WEGDEEL}?f=json&limit=1000&bbox=${job.box.map((v) => v.toFixed(5)).join(',')}&functie=${encodeURIComponent(job.functie)}`
      while (url) {
        const json = await fetchPage(url)
        for (const f of json.features ?? []) {
          const p = f.properties
          // Above ground and current (the same piece can come back from neighbouring tiles).
          if (p.eind_registratie || Number(p.relatieve_hoogteligging ?? 0) < 0) continue
          const polygons = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : []
          polygons.forEach((rings, i) => {
            found.set(`${f.id}:${i}`, rings.map((ring) => ring.flatMap(([lng, lat]) => project(lng, lat).map((v) => Math.round(v * 10) / 10))))
          })
        }
        url = json.links?.find((l) => l.rel === 'next')?.href ?? null
      }
    } catch (error) {
      // The service sometimes fails on a busy area: try its quarters, down to a small size.
      const [x0, y0, x1, y1] = job.box
      if (x1 - x0 > 0.003) {
        const mx = (x0 + x1) / 2
        const my = (y0 + y1) / 2
        for (const box of [[x0, y0, mx, my], [mx, y0, x1, my], [x0, my, mx, y1], [mx, my, x1, y1]]) await fetchJob({ box, functie: job.functie })
        finished.add(key)
        return
      }
      skipped++
      console.warn(`  skipped ${key}: ${error.message}`)
      return
    }
    for (const [id, rings] of found) byId.set(id, rings)
    finished.add(key)
    if (++done % 100 === 0) {
      console.log(`  bgt: ${finished.size}/${jobs.length} requests, ${byId.size} carriageway pieces`)
      await save()
    }
  }
  console.log(`bgt: fetching carriageways (${jobs.length} requests, ${finished.size} done before) …`)
  const queue = [...jobs]
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (queue.length) await fetchJob(queue.pop())
  }))
  if (skipped) {
    await save()
    throw new Error(`${skipped} areas could not be downloaded; run again to retry them`)
  }
  const polygons = [...byId.values()]
  await mkdir(CACHE, { recursive: true })
  await writeFile(file, JSON.stringify(polygons))
  await rm(partialFile, { force: true })
  return polygons
}

/** Grid of polygon indices by 25 m cell, over each polygon's bounding box. */
function indexPolygons(polygons) {
  const CELL = 25
  const grid = new Map()
  polygons.forEach((rings, i) => {
    const outer = rings[0]
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let k = 0; k < outer.length; k += 2) {
      minX = Math.min(minX, outer[k])
      maxX = Math.max(maxX, outer[k])
      minY = Math.min(minY, outer[k + 1])
      maxY = Math.max(maxY, outer[k + 1])
    }
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
        const key = cx * 100_000 + cy
        const cell = grid.get(key)
        if (cell) cell.push(i)
        else grid.set(key, [i])
      }
    }
  })
  return (x0, y0, x1, y1) => {
    const out = new Set()
    for (let cx = Math.floor(Math.min(x0, x1) / CELL); cx <= Math.floor(Math.max(x0, x1) / CELL); cx++) {
      for (let cy = Math.floor(Math.min(y0, y1) / CELL); cy <= Math.floor(Math.max(y0, y1) / CELL); cy++) {
        for (const i of grid.get(cx * 100_000 + cy) ?? []) out.add(i)
      }
    }
    return out
  }
}

/**
 * Stretches of asphalt along the line p + t·n, t in [-REACH, REACH]: merged
 * intervals [a, b] of t inside any carriageway polygon (even-odd per polygon).
 */
function crossSection(polygons, near, px, py, nx, ny) {
  const x0 = px - nx * REACH
  const y0 = py - ny * REACH
  const x1 = px + nx * REACH
  const y1 = py + ny * REACH
  const intervals = []
  for (const i of near(x0, y0, x1, y1)) {
    const ts = []
    for (const ring of polygons[i]) {
      for (let k = 0; k + 3 < ring.length; k += 2) {
        const ax = ring[k]
        const ay = ring[k + 1]
        const bx = ring[k + 2]
        const by = ring[k + 3]
        // Intersection of the ray with edge a–b.
        const ex = bx - ax
        const ey = by - ay
        const denom = nx * ey - ny * ex
        if (Math.abs(denom) < 1e-9) continue
        const t = ((ax - px) * ey - (ay - py) * ex) / denom
        const u = ((ax - px) * ny - (ay - py) * nx) / denom
        if (u >= 0 && u < 1 && t >= -REACH && t <= REACH) ts.push(t)
      }
    }
    ts.sort((a, b) => a - b)
    for (let k = 0; k + 1 < ts.length; k += 2) intervals.push([ts[k], ts[k + 1]])
  }
  intervals.sort((p, q) => p[0] - q[0])
  // Pieces of one carriageway touch; merge them.
  const merged = []
  for (const [a, b] of intervals) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1] + 0.4) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return merged
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function main() {
  const network = JSON.parse(await readFile(resolve(OUT, 'gooi-network.json'), 'utf8'))
  const polygons = await carriageways(process.argv.includes('--refresh'))
  const near = indexPolygons(polygons)
  const { unit } = network.meta.projection
  const { CAR_FWD, CAR_BWD } = network.meta.flags
  const seg = network.segments
  const rows = []
  let measured = 0
  let dual = 0
  let carSegments = 0
  for (let s = 0; s < seg.from.length; s++) {
    const flags = seg.flags[s]
    const fwd = (flags & CAR_FWD) !== 0
    const bwd = (flags & CAR_BWD) !== 0
    if (!fwd && !bwd) continue
    carSegments++
    // The segment's line in metres: from-node, interior points, to-node.
    let ix = network.nodes[2 * seg.from[s]]
    let iy = network.nodes[2 * seg.from[s] + 1]
    const points = [[ix * unit, iy * unit]]
    const g = seg.geom[s]
    for (let k = 0; k < g.length; k += 2) {
      ix += g[k]
      iy += g[k + 1]
      points.push([ix * unit, iy * unit])
    }
    points.push([network.nodes[2 * seg.to[s]] * unit, network.nodes[2 * seg.to[s] + 1] * unit])
    const lengths = [0]
    for (let k = 1; k < points.length; k++) lengths.push(lengths[k - 1] + Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]))
    const total = lengths[lengths.length - 1]
    const stations = []
    if (total >= 2 * SETBACK + SPACING) for (let d = SETBACK; d <= total - SETBACK; d += SPACING) stations.push(d)
    else if (total >= 10) stations.push(total / 2)

    // Per direction, the inner and outer edge (metres right of that direction).
    const samples = { f: [], b: [] }
    let isDual = 0
    for (const d of stations) {
      let k = 1
      while (k < points.length - 1 && lengths[k] < d) k++
      const [ax, ay] = points[k - 1]
      const [bx, by] = points[k]
      const len = Math.hypot(bx - ax, by - ay) || 1
      const t = (d - lengths[k - 1]) / len
      const px = ax + (bx - ax) * t
      const py = ay + (by - ay) * t
      const dx = (bx - ax) / len
      const dy = (by - ay) / len
      // Right of the drawing direction, as the app's lateral offsets.
      const cuts = crossSection(polygons, near, px, py, dy, -dx)
      const inside = cuts.find(([a, b]) => a <= 0.5 && b >= -0.5)
      if (fwd && bwd) {
        if (inside && inside[1] - inside[0] <= 2 * MAX_WIDTH) {
          // One carriageway for both directions: split it down the middle.
          const mid = (inside[0] + inside[1]) / 2
          samples.f.push([mid, inside[1]])
          samples.b.push([-mid, -inside[0]])
        } else if (!inside) {
          const right = cuts.find(([a]) => a > 0 && a < MAX_MEDIAN)
          const left = [...cuts].reverse().find(([, b]) => b < 0 && b > -MAX_MEDIAN)
          if (right && left) {
            samples.f.push([right[0], right[1]])
            samples.b.push([-left[1], -left[0]])
            isDual++
          }
        }
      } else {
        const hit = inside ?? cuts.find(([a, b]) => Math.min(Math.abs(a), Math.abs(b)) < 4)
        if (!hit) continue
        if (fwd) samples.f.push([hit[0], hit[1]])
        else samples.b.push([-hit[1], -hit[0]])
      }
    }
    const summarise = (list) => {
      if (list.length < Math.max(1, stations.length * 0.5)) return null
      const inner = median(list.map((x) => x[0]))
      const outer = median(list.map((x) => x[1]))
      const width = outer - inner
      if (width < MIN_WIDTH || width > MAX_WIDTH || Math.abs(inner) > MAX_MEDIAN) return null
      return [Math.round(inner * 10) / 10, Math.round(outer * 10) / 10]
    }
    const f = fwd ? summarise(samples.f) : null
    const b = bwd ? summarise(samples.b) : null
    if (!f && !b) continue
    measured++
    if (isDual > stations.length / 2) dual++
    rows.push([s, ...(f ?? [null, null]), ...(b ?? [null, null])])
  }
  await writeFile(
    resolve(OUT, 'gooi-road-geometry.json'),
    JSON.stringify({
      meta: {
        description: 'Carriageway edges per street direction, measured from the BGT; metres right of the direction of travel',
        source: 'BGT (Basisregistratie Grootschalige Topografie), Kadaster, via the PDOK OGC API',
        license: 'CC0 1.0',
        /** The network these rows belong to (gooi-network.json meta.generated). */
        network: network.meta.generated,
        generated: new Date().toISOString(),
      },
      /** Per row: segment, forward inner, forward outer, backward inner, backward outer (null when not measured). */
      rows,
    }),
  )
  console.log(`road geometry: ${measured} of ${carSegments} car streets measured (${dual} dual carriageways), from ${polygons.length} carriageway pieces`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

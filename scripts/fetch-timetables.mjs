#!/usr/bin/env node
/*
 * Adds real timetables to public/data/gooi-transit.json from the Dutch
 * national GTFS feed (OVapi / Stichting OpenGeo, built from NDOV Loket open
 * data; timetables CC0-1.0).
 *
 *   node scripts/fetch-timetables.mjs             # use the cached feed if present
 *   node scripts/fetch-timetables.mjs --refresh   # download the latest feed (~240 MB)
 *   node scripts/fetch-timetables.mjs --date 20261028
 *
 * For one representative weekday, every bus and train trip serving the Gooi
 * is matched to an OpenStreetMap route variant (same line number or train
 * series, stops along the route in the right order). Each trip is stored as
 * anchor points [time, metres along the route, …] at its stops in the area,
 * so the app can move vehicles between their real scheduled stop times.
 * Requires the `unzip` command (standard on macOS and Linux).
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FEED = resolve(ROOT, 'scripts/.cache/gtfs-nl.zip')
const TRANSIT = resolve(ROOT, 'public/data/gooi-transit.json')
const FEED_URL = 'https://gtfs.ovapi.nl/nl/gtfs-nl.zip'
const USER_AGENT = 'gooi-digital-twin/0.2 (+https://github.com/Teun-sudo1/gooi-digital-twin)'

// Stops used as timing anchors (the transit geometry box) and a wider box used
// to tell the direction of travel from stops before and after the area.
const NEAR = { s: 52.17, w: 5.08, n: 52.35, e: 5.36 }
const WIDE = { s: 51.7, w: 4.6, n: 52.8, e: 5.9 }
const inBox = (box, lat, lon) => lat >= box.s && lat <= box.n && lon >= box.w && lon <= box.e

// ---------------------------------------------------------------------------
// Feed access

async function download() {
  console.log(`Downloading ${FEED_URL} …`)
  const response = await fetch(FEED_URL, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(FEED))
}

/** Parses one CSV line (GTFS quoting rules). */
function parseCsv(line) {
  const out = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(field)
      field = ''
    } else field += c
  }
  out.push(field)
  return out
}

/** Streams the rows of one file in the feed as objects keyed by column. */
async function* rows(file) {
  const unzip = spawn('unzip', ['-p', FEED, file])
  const lines = createInterface({ input: unzip.stdout, crlfDelay: Infinity })
  let header = null
  for await (const line of lines) {
    if (!line) continue
    const cells = parseCsv(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line)
    if (!header) {
      header = cells
      continue
    }
    const row = {}
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i]
    yield row
  }
}

const seconds = (hms) => {
  const [h, m, s] = hms.split(':').map(Number)
  return h * 3600 + m * 60 + s
}

/** First Wednesday at least three days into the feed: a normal weekday. */
function representativeDate(feedStart) {
  const d = new Date(Date.UTC(+feedStart.slice(0, 4), +feedStart.slice(4, 6) - 1, +feedStart.slice(6, 8) + 3))
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10).replaceAll('-', '')
}

// ---------------------------------------------------------------------------
// Geometry (same local projection as the transit file)

function decodeLine(line, projection) {
  const n = line.geom.length / 2
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const cum = new Float64Array(n)
  let x = 0
  let y = 0
  for (let i = 0; i < n; i++) {
    x += line.geom[2 * i]
    y += line.geom[2 * i + 1]
    xs[i] = x * projection.unit
    ys[i] = y * projection.unit
    if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
  }
  return { xs, ys, cum }
}

/** Nearest point on the route to (px, py), optionally only between two distances along it. */
function locate(shape, px, py, minAlong = -Infinity, maxAlong = Infinity) {
  const { xs, ys, cum } = shape
  let best = { along: 0, offset: Infinity }
  for (let i = 1; i < xs.length; i++) {
    if (cum[i] < minAlong || cum[i - 1] > maxAlong) continue
    const dx = xs[i] - xs[i - 1]
    const dy = ys[i] - ys[i - 1]
    const len2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((px - xs[i - 1]) * dx + (py - ys[i - 1]) * dy) / len2))
    const offset = Math.hypot(xs[i - 1] + dx * t - px, ys[i - 1] + dy * t - py)
    if (offset < best.offset) best = { along: cum[i - 1] + t * Math.sqrt(len2), offset }
  }
  return best
}

/**
 * Timing anchors for a trip on one route variant, or null when the trip does
 * not run along it. Anchors are the trip's stops near the route, plus
 * estimated times where the route enters and leaves the area for trips that
 * pass through without stopping (interpolated from the stops either side).
 */
function anchorsFor(trip, shape, tolerance, project) {
  const length = shape.cum[shape.cum.length - 1]
  const start = [shape.xs[0], shape.ys[0]]
  const end = [shape.xs.at(-1), shape.ys.at(-1)]
  // On a loop (start and end at the same station) or a route that uses a road
  // twice, a stop's nearest point is ambiguous. There, stops are located in
  // order, each a little further along than the previous one.
  const loop = Math.hypot(start[0] - end[0], start[1] - end[1]) < 150
  let progress = 0
  const located = trip.stops.map((s) => {
    const [x, y] = project(s.stop.lon, s.stop.lat)
    const hit = loop ? locate(shape, x, y, progress - 30, progress + 3000) : locate(shape, x, y)
    if (loop && hit.offset < tolerance) progress = hit.along
    return { ...s, x, y, ...hit }
  })
  // Stops (including those beyond the area) must progress along the route.
  if (!loop && located.at(-1).along <= located[0].along) return null
  // Running a loop the wrong way round leaves most stops far from the route.
  if (loop && located.filter((s) => s.offset < tolerance).length < located.filter((s) => s.stop.near).length * 0.7) return null
  const near = located.filter((s) => s.offset < tolerance && s.along > 1 && s.along < length - 1)
  for (let k = 1; k < near.length; k++) if (near[k].along < near[k - 1].along - 5) return null
  // Stops near the area that the route misses suggest a different variant.
  const missed = located.filter((s) => s.stop.near && s.offset >= tolerance).length

  const points = []
  const boundary = (target, before, after) => {
    if (!before || !after) return
    const dBefore = Math.hypot(before.x - target[0], before.y - target[1])
    const dAfter = Math.hypot(after.x - target[0], after.y - target[1])
    const t = before.depart + (after.arrive - before.depart) * (dBefore / (dBefore + dAfter || 1))
    return Math.round(t)
  }
  // Entering the area: between the last stop before the route starts and the next stop.
  const firstNear = near[0]
  const enterBefore = [...located].reverse().find((s) => s.along <= 1 && (!firstNear || s.seq < firstNear.seq))
  const enterAfter = firstNear ?? located.find((s) => s.along >= length - 1)
  const tEnter = boundary(start, enterBefore, enterAfter)
  if (tEnter !== undefined) points.push({ time: tEnter, along: 0, x: start[0], y: start[1], stop: false })
  for (const s of near) {
    points.push({ time: s.arrive, along: s.along, x: s.x, y: s.y, stop: true })
    if (s.depart > s.arrive) points.push({ time: s.depart, along: s.along, x: s.x, y: s.y, stop: true })
  }
  const lastNear = near.at(-1)
  const leaveAfter = located.find((s) => s.along >= length - 1 && (!lastNear || s.seq > lastNear.seq))
  const leaveBefore = lastNear ?? enterBefore
  const tLeave = boundary(end, leaveBefore, leaveAfter)
  if (tLeave !== undefined) points.push({ time: tLeave, along: length, x: end[0], y: end[1], stop: false })

  if (points.length < 2) return null
  for (let k = 1; k < points.length; k++) if (points[k].time < points[k - 1].time) return null
  return {
    stops: near.length - missed * 0.5 + (tEnter !== undefined && tLeave !== undefined ? 0.5 : 0),
    points: points.filter((p) => p.stop),
    flat: points.flatMap((p) => [p.time, Math.round(p.along)]),
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const exists = await stat(FEED).then(() => true, () => false)
  if (args.includes('--refresh') || !exists) await download()

  const transit = JSON.parse(await readFile(TRANSIT, 'utf8'))
  const projection = transit.meta.projection
  const project = (lon, lat) => [(lon - projection.lng0) * projection.kx, (lat - projection.lat0) * projection.ky]

  let feedStart = null
  for await (const row of rows('feed_info.txt')) feedStart = row.feed_start_date
  const dateArg = args.indexOf('--date')
  const date = dateArg >= 0 ? args[dateArg + 1] : representativeDate(feedStart)
  console.log(`Service date ${date}`)

  // Lines we model, by bus number or train series.
  const busRefs = new Set(transit.lines.filter((l) => l.mode === 'bus').map((l) => l.ref))
  const trainRefs = new Set(transit.lines.filter((l) => l.mode === 'train').map((l) => l.ref))

  const services = new Set()
  for await (const row of rows('calendar_dates.txt')) {
    if (row.date === date && row.exception_type === '1') services.add(row.service_id)
  }

  const routes = new Map()
  for await (const row of rows('routes.txt')) {
    const type = Number(row.route_type)
    if ((type === 3 && busRefs.has(row.route_short_name)) || type === 2) {
      routes.set(row.route_id, { type, ref: row.route_short_name, agency: row.agency_id, longName: row.route_long_name })
    }
  }

  const trips = new Map()
  for await (const row of rows('trips.txt')) {
    const route = routes.get(row.route_id)
    if (!route || !services.has(row.service_id)) continue
    let ref = route.ref
    if (route.type === 2) {
      // NS train numbers belong to a series of 100: train 5847 runs in series 5800.
      // The Amsterdam–Berlin service is mapped in OSM as "IC 77" but numbered as ICE trains here.
      const number = Number.parseInt(row.trip_short_name, 10)
      if (/berlin/i.test(route.longName) && trainRefs.has('IC 77')) ref = 'IC 77'
      else if (Number.isFinite(number)) ref = String(Math.floor(number / 100) * 100)
      else continue
      if (!trainRefs.has(ref)) continue
    }
    trips.set(row.trip_id, { mode: route.type === 2 ? 'train' : 'bus', ref, stops: [] })
  }
  console.log(`${trips.size} candidate trips on ${date}`)

  const stops = new Map()
  for await (const row of rows('stops.txt')) {
    const lat = Number(row.stop_lat)
    const lon = Number(row.stop_lon)
    if (inBox(WIDE, lat, lon)) stops.set(row.stop_id, { lat, lon, near: inBox(NEAR, lat, lon), name: row.stop_name })
  }

  let scanned = 0
  for await (const row of rows('stop_times.txt')) {
    if (++scanned % 5_000_000 === 0) console.log(`  ${scanned / 1e6}M stop times scanned`)
    const trip = trips.get(row.trip_id)
    if (!trip) continue
    const stop = stops.get(row.stop_id)
    if (!stop) continue
    trip.stops.push({
      seq: Number(row.stop_sequence),
      arrive: seconds(row.arrival_time || row.departure_time),
      depart: seconds(row.departure_time || row.arrival_time),
      stop,
    })
  }

  // Match trips to OSM route variants.
  const shapes = transit.lines.map((line) => decodeLine(line, projection))
  const byRef = new Map()
  transit.lines.forEach((line, i) => {
    const key = `${line.mode}:${line.ref}`
    if (!byRef.has(key)) byRef.set(key, [])
    byRef.get(key).push(i)
  })
  const matched = transit.lines.map(() => [])
  /** GTFS stops served by the trips matched to each variant, for naming its OSM stops. */
  const served = transit.lines.map(() => new Set())
  let used = 0
  for (const trip of trips.values()) {
    if (trip.stops.length < 2) continue
    trip.stops.sort((a, b) => a.seq - b.seq)
    const tolerance = trip.mode === 'train' ? 150 : 60
    const candidates = []
    for (const i of byRef.get(`${trip.mode}:${trip.ref}`) ?? []) {
      const anchors = anchorsFor(trip, shapes[i], tolerance, project)
      if (anchors) candidates.push({ line: i, anchors })
    }
    if (!candidates.length) continue
    candidates.sort((a, b) => b.anchors.stops - a.anchors.stops)
    // A trip may cover several mapped variants (e.g. Huizen–Bussum–Hilversum mapped
    // as two routes). Also use variants whose stops lie away from those already used.
    const taken = []
    for (const candidate of candidates) {
      const own = candidate.anchors.points.filter((p) => !taken.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 300))
      if (taken.length && own.length < 3) continue
      matched[candidate.line].push(candidate.anchors.flat)
      for (const s of trip.stops) served[candidate.line].add(s.stop)
      taken.push(...candidate.anchors.points)
    }
    used++
  }

  // Name each OSM stop after the nearest GTFS stop its trips serve.
  let named = 0
  transit.lines.forEach((line, i) => {
    const shape = shapes[i]
    const reach = line.mode === 'train' ? 250 : 80
    line.stopNames = line.stops.map((d) => {
      let k = 1
      while (k < shape.cum.length - 1 && shape.cum[k] < d) k++
      const t = (d - shape.cum[k - 1]) / (shape.cum[k] - shape.cum[k - 1] || 1)
      const x = shape.xs[k - 1] + (shape.xs[k] - shape.xs[k - 1]) * t
      const y = shape.ys[k - 1] + (shape.ys[k] - shape.ys[k - 1]) * t
      let best = null
      let bestD = reach
      for (const stop of served[i]) {
        const [sx, sy] = project(stop.lon, stop.lat)
        const dist = Math.hypot(sx - x, sy - y)
        if (dist < bestD) {
          bestD = dist
          best = stop.name
        }
      }
      if (best) named++
      return best
    })
  })
  console.log(`Named ${named} of ${transit.lines.reduce((n, l) => n + l.stops.length, 0)} stops.`)

  let withTimetable = 0
  transit.lines.forEach((line, i) => {
    const list = matched[i].sort((a, b) => a[0] - b[0])
    if (list.length) {
      line.trips = list
      withTimetable++
    } else delete line.trips
  })
  transit.meta.timetable = {
    source: 'OVapi GTFS (Stichting OpenGeo), from NDOV Loket open data',
    license: 'CC0-1.0',
    serviceDate: date,
    feedVersion: feedStart,
  }
  await writeFile(TRANSIT, JSON.stringify(transit))
  console.log(`Matched ${used} trips to ${withTimetable} of ${transit.lines.length} route variants.`)
  for (const [i, line] of transit.lines.entries()) {
    console.log(`  ${line.mode} ${line.ref.padEnd(6)} ${String(matched[i].length).padStart(3)} trips  ${line.name.slice(0, 60)}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

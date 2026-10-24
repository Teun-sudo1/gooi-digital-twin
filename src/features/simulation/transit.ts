import { AGENT_STRIDE, Kind, type FollowInfo, type Projection, type TransitFile, type TransitLineInfo, type TransitLineRecord } from '../../types/simulation'
import { toLngLat } from './network'

/*
 * Buses and trains on their real OpenStreetMap routes and stops, running to
 * the real weekday timetable from the national GTFS feed when it has been
 * added (scripts/fetch-timetables.mjs): each trip passes its stops at the
 * scheduled times, easing between stops and pausing at each one. Lines
 * without trips in the timetable do not run that day (night buses, seasonal
 * lines). Without timetable data, departures fall back to the OSM `interval`
 * tag or an assumed frequency, with a simple run profile.
 *
 * Trains (and buses without a timetable) are positioned as a pure function of
 * the clock, so jumping in time is instant and consistent. Buses with a
 * timetable are driven through road traffic by the bus fleet (buses.ts),
 * which uses the trips, stops and geometry kept here. There is no live data.
 */

const DAY = 86_400
const EVENING = 20 * 3600
/** Frame ids: buses and trains are numbered above road traffic (see ROAD_ID_LIMIT). */
export const BUS_ID_BASE = 8_000_000
export const TRAIN_ID_BASE = 12_000_000

/** One stretch between stops (or the edges of the modelled area). */
interface Leg {
  start: number
  length: number
  /** Trip time at which the leg starts. */
  t0: number
  v0: number
  vp: number
  a: number
  b: number
  ta: number
  tc: number
  tb: number
}

/** A scheduled trip: times (s since midnight, may pass 24:00) at distances along the line. */
export interface Trip {
  times: Float64Array
  dist: Float64Array
}

export interface Line {
  info: TransitLineInfo
  /** Stops as metres along the line, with their names. */
  stopDist: number[]
  stopNames: (string | null)[]
  /** Real trips when a timetable is loaded (empty = no service); null = use headways. */
  trips: Trip[] | null
  xs: Float64Array
  ys: Float64Array
  cum: Float64Array
  length: number
  legs: Leg[]
  duration: number
  headway: number
  offset: number
  serviceStart: number
  serviceEnd: number
  carriages: number
  carriageLength: number
  /** 0 = NS (yellow), 1 = international. */
  variant: number
}

/** Assumed minutes between departures for bus lines (weekday daytime). */
function assumedBusHeadway(ref: string) {
  if (ref === '320' || ref === '321') return 15 // R-net corridors run frequently
  if (ref.startsWith('N')) return 60
  return 30
}

/** Plans one leg from speed v0 to v1 over `length` metres with top speed vmax. */
function planLeg(start: number, length: number, t0: number, v0: number, v1: number, vmax: number, accel: number, decel: number): Leg {
  let a = accel
  let b = decel
  let vp = vmax
  let da = (vp * vp - v0 * v0) / (2 * a)
  let db = (vp * vp - v1 * v1) / (2 * b)
  if (da + db > length) {
    vp = Math.sqrt((2 * a * b * length + b * v0 * v0 + a * v1 * v1) / (a + b))
    if (vp < v0) {
      // Too short to accelerate: brake steadily from v0 to v1.
      vp = v0
      b = Math.max(0.1, (v0 * v0 - v1 * v1) / (2 * length))
    } else if (vp < v1) {
      vp = v1
      a = Math.max(0.1, (v1 * v1 - v0 * v0) / (2 * length))
    }
    da = (vp * vp - v0 * v0) / (2 * a)
    db = (vp * vp - v1 * v1) / (2 * b)
  }
  const ta = (vp - v0) / a
  const tb = (vp - v1) / b
  const tc = Math.max(0, length - da - db) / vp
  return { start, length, t0, v0, vp, a, b, ta, tc, tb }
}

function legDistance(leg: Leg, t: number) {
  const { v0, vp, a, b, ta, tc } = leg
  if (t <= ta) return v0 * t + 0.5 * a * t * t
  const da = v0 * ta + 0.5 * a * ta * ta
  if (t <= ta + tc) return da + vp * (t - ta)
  const tau = Math.min(t - ta - tc, leg.tb)
  return Math.min(leg.length, da + vp * tc + vp * tau - 0.5 * b * tau * tau)
}

function decode(geom: number[], unit: number) {
  const n = geom.length / 2
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const cum = new Float64Array(n)
  let x = 0
  let y = 0
  for (let i = 0; i < n; i++) {
    x += geom[2 * i]
    y += geom[2 * i + 1]
    xs[i] = x * unit
    ys[i] = y * unit
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
  }
  return { xs, ys, cum }
}

/**
 * GTFS times are whole minutes, so consecutive stops can share a time. Spread
 * such runs over the surrounding minute by distance, so vehicles keep moving.
 */
function normaliseTrip(flat: number[]): Trip {
  const n = flat.length / 2
  const times = new Float64Array(n)
  const dist = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    times[i] = flat[2 * i]
    dist[i] = flat[2 * i + 1]
  }
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && times[j + 1] === times[i] && dist[j + 1] !== dist[j]) j++
    if (j > i) {
      const from = Math.max(i > 0 ? times[i - 1] : times[i] - 30, times[i] - 30)
      const to = Math.min(j + 1 < n ? times[j + 1] : times[i] + 30, times[i] + 30)
      const span = dist[j] - dist[i] || 1
      for (let k = i; k <= j; k++) times[k] = from + ((to - from) * (dist[k] - dist[i])) / span
    }
    i = j + 1
  }
  return { times, dist }
}

function buildLine(record: TransitLineRecord, index: number, variants: number, projection: Projection, timetable: boolean): Line {
  const { xs, ys, cum } = decode(record.geom, projection.unit)
  const length = cum[cum.length - 1]
  const train = record.mode === 'train'
  const international = train && /^(IC \d|9\d{3})/.test(record.ref)
  const intercity = train && (international || Number(record.ref) < 3000)

  // Departures without a timetable: OSM interval if mapped, else an assumption,
  // split across route variants.
  const fromOsm = record.interval !== null
  const base = record.interval ?? (train ? 30 : assumedBusHeadway(record.ref))
  const headwayMinutes = train ? base : base * Math.max(1, variants / 2)

  // Run profile.
  const vmaxBus = 13.9
  const dwell = train ? 40 : 20
  const internal = record.stops.filter((d) => d > 80 && d < length - 80)
  const startsAtStop = record.stops.some((d) => d <= 80)
  const endsAtStop = record.stops.some((d) => d >= length - 80)
  const points = [0, ...internal, length]
  const legs: Leg[] = []
  let t = 0
  for (let i = 0; i + 1 < points.length; i++) {
    const legLength = points[i + 1] - points[i]
    const vmax = train ? (intercity ? 36 : 33) : legLength > 2000 ? 22 : vmaxBus
    const v0 = i === 0 && !startsAtStop ? vmax : 0
    const v1 = i + 2 === points.length && !endsAtStop ? vmax : 0
    const leg = planLeg(points[i], legLength, t, v0, v1, vmax, train ? 0.8 : 1.0, train ? 0.8 : 1.2)
    legs.push(leg)
    t += leg.ta + leg.tc + leg.tb
    if (i + 2 < points.length) t += dwell
  }

  const night = !train && record.ref.startsWith('N')
  const serviceStart = night ? 1800 : train ? (international ? 7 * 3600 : 5.5 * 3600) : 6 * 3600
  const serviceEnd = night ? 5.5 * 3600 : train ? (international ? 19 * 3600 : 24.5 * 3600) : 24 * 3600
  const headway = headwayMinutes * 60

  const coordinates: [number, number][] = []
  for (let i = 0; i < xs.length; i++) coordinates.push(toLngLat(projection, xs[i], ys[i]))
  const stops = record.stops.map((d): [number, number] => {
    let k = 1
    while (k < cum.length - 1 && cum[k] < d) k++
    const t = (d - cum[k - 1]) / (cum[k] - cum[k - 1] || 1)
    return toLngLat(projection, xs[k - 1] + (xs[k] - xs[k - 1]) * t, ys[k - 1] + (ys[k] - ys[k - 1]) * t)
  })

  return {
    info: {
      index,
      id: record.id,
      mode: record.mode,
      ref: record.ref,
      name: record.name,
      colour: record.colour ?? (train ? '#ffc917' : '#2f9e6e'),
      from: record.from,
      to: record.to,
      schedule: timetable ? 'timetable' : fromOsm ? 'osm-interval' : 'assumed',
      tripsPerDay: timetable ? (record.trips?.length ?? 0) : Math.floor((serviceEnd - serviceStart) / (headwayMinutes * 60)),
      coordinates,
      stops,
    },
    stopDist: record.stops,
    stopNames: record.stopNames ?? record.stops.map(() => null),
    trips: timetable ? (record.trips ?? []).map(normaliseTrip) : null,
    xs,
    ys,
    cum,
    length,
    legs,
    duration: t,
    headway,
    // Spread departures of different lines over the hour, deterministically.
    offset: (record.id * 7919) % headway,
    serviceStart,
    serviceEnd,
    carriages: train ? (intercity ? 6 : 4) : 1,
    carriageLength: train ? 26.5 : 12,
    variant: international ? 1 : 0,
  }
}

export class TransitModel {
  readonly lines: Line[]
  private buses = 0
  private trains = 0

  constructor(file: TransitFile) {
    const variants = new Map<string, number>()
    for (const l of file.lines) variants.set(`${l.mode}:${l.ref}`, (variants.get(`${l.mode}:${l.ref}`) ?? 0) + 1)
    const timetable = Boolean(file.meta.timetable)
    this.timetableDate = file.meta.timetable?.serviceDate ?? null
    this.lines = file.lines.map((record, i) =>
      buildLine(record, i, variants.get(`${record.mode}:${record.ref}`) ?? 1, file.meta.projection, timetable),
    )
  }

  /** Service date of the GTFS timetable in use (YYYYMMDD), or null when frequencies are assumed. */
  readonly timetableDate: string | null

  /** Distance along the line at time t on a scheduled trip, or -1 when not running. */
  scheduledDistance(line: Line, trip: Trip, t: number) {
    const { times, dist } = trip
    const n = times.length
    if (t < times[0] || t > times[n - 1]) return -1
    let k = 0
    while (k + 2 < n && times[k + 1] <= t) k++
    const d0 = dist[k]
    const d1 = dist[k + 1]
    const span = times[k + 1] - times[k]
    if (d1 === d0 || span <= 0) return d0
    // Where the line meets the edge of the area a vehicle is moving at speed;
    // at stops it pauses briefly, then accelerates away and brakes into the next stop.
    const length = Math.round(line.length)
    const startsAtStop = d0 !== 0 && d0 !== length
    const endsAtStop = d1 !== 0 && d1 !== length
    const dwell = startsAtStop ? Math.min(line.info.mode === 'train' ? 30 : 15, span * 0.3) : 0
    const u = Math.max(0, Math.min(1, (t - times[k] - dwell) / (span - dwell)))
    const eased = startsAtStop && endsAtStop ? u * u * (3 - 2 * u) : startsAtStop ? u * u : endsAtStop ? 1 - (1 - u) * (1 - u) : u
    return d0 + (d1 - d0) * eased
  }

  get infos(): TransitLineInfo[] {
    return this.lines.map((l) => l.info)
  }

  /** Distance along the line `elapsed` seconds after departure. */
  private distanceAt(line: Line, elapsed: number) {
    const legs = line.legs
    let lo = 0
    let hi = legs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (legs[mid].t0 <= elapsed) lo = mid
      else hi = mid - 1
    }
    const leg = legs[lo]
    return leg.start + legDistance(leg, elapsed - leg.t0)
  }

  /** Position, bearing and direction of the line at distance `d`. */
  pointAt(line: Line, d: number, out: { x: number; y: number; bearing: number }) {
    const { xs, ys, cum } = line
    let lo = 0
    let hi = cum.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= d) lo = mid
      else hi = mid
    }
    const t = (d - cum[lo]) / (cum[hi] - cum[lo] || 1)
    const dx = xs[hi] - xs[lo]
    const dy = ys[hi] - ys[lo]
    out.x = xs[lo] + dx * t
    out.y = ys[lo] + dy * t
    out.bearing = 90 - (Math.atan2(dy, dx) * 180) / Math.PI
    return { dx, dy }
  }

  /**
   * Writes train carriages (and buses without a timetable) in service at
   * `clock`; returns the count. Buses with a timetable are written by the fleet.
   */
  writeFrame(clock: number, out: Float32Array): number {
    let n = 0
    const max = Math.floor(out.length / AGENT_STRIDE)
    const p = { x: 0, y: 0, bearing: 0 }
    this.buses = 0
    this.trains = 0

    const emit = (line: Line, head: number, id: number) => {
      if (line.info.mode === 'train') this.trains++
      else this.buses++
      for (let c = 0; c < line.carriages && n < max; c++) {
        const d = head - (c + 0.5) * line.carriageLength
        if (d < 0 || d > line.length) continue
        const { dx, dy } = this.pointAt(line, d, p)
        let x = p.x
        let y = p.y
        if (line.info.mode === 'bus') {
          // Buses keep right on the road.
          const len = Math.hypot(dx, dy) || 1
          x += (dy / len) * 1.7
          y -= (dx / len) * 1.7
        }
        const o = n * AGENT_STRIDE
        out[o] = x
        out[o + 1] = y
        out[o + 2] = p.bearing
        out[o + 3] = line.info.mode === 'train' ? Kind.TrainCar : Kind.Bus
        out[o + 4] = line.info.index
        out[o + 5] = line.variant
        out[o + 6] = id
        n++
      }
    }

    for (const line of this.lines) {
      // Consider today and trips that started yesterday evening (times past 24:00).
      for (const now of [clock, clock + DAY]) {
        if (line.trips) {
          if (line.info.mode === 'bus') continue
          line.trips.forEach((trip, t) => {
            const d = this.scheduledDistance(line, trip, now)
            // Scheduled positions mark the middle of the vehicle, so trains stop centred on the platform.
            if (d >= 0) emit(line, d + (line.carriages * line.carriageLength) / 2, TRAIN_ID_BASE + line.info.index * 1000 + t)
          })
          continue
        }
        const { headway, duration, serviceStart, serviceEnd, offset } = line
        const first = Math.max(0, Math.ceil((now - duration - serviceStart - offset) / headway))
        const last = Math.floor((now - serviceStart - offset) / headway)
        for (let k = first; k <= last; k++) {
          const departure = serviceStart + offset + k * headway
          if (departure > serviceEnd) break
          // Buses run half as often in the evening.
          if (line.info.mode === 'bus' && departure > EVENING && k % 2 === 1) continue
          const base = line.info.mode === 'train' ? TRAIN_ID_BASE : BUS_ID_BASE
          emit(line, this.distanceAt(line, now - departure), base + line.info.index * 1000 + (k % 1000))
        }
      }
    }
    return n
  }

  get counts() {
    return { buses: this.buses, trains: this.trains }
  }

  /** The next stop after distance `d`, with its scheduled time on a trip (when there is one). */
  nextStop(line: Line, d: number, trip: Trip | null): { index: number; name: string | null; time: number | null } | null {
    const index = line.stopDist.findIndex((s) => s > d + 5)
    if (index < 0) return null
    const at = line.stopDist[index]
    let time: number | null = null
    if (trip) {
      let best = 150
      for (let k = 0; k < trip.dist.length; k++) {
        const off = Math.abs(trip.dist[k] - at)
        if (off < best) {
          best = off
          time = trip.times[k]
        }
      }
    }
    return { index, name: line.stopNames[index], time: time === null ? null : time % DAY }
  }

  /** Details of a train for the follow card, or null when it isn't running. */
  inspectTrain(id: number, clock: number): FollowInfo | null {
    const index = Math.floor((id - TRAIN_ID_BASE) / 1000)
    const line = this.lines[index]
    const trip = line?.trips?.[(id - TRAIN_ID_BASE) % 1000]
    if (!line || !trip) return null
    for (const now of [clock, clock + DAY]) {
      const d = this.scheduledDistance(line, trip, now)
      if (d < 0) continue
      const ahead = this.scheduledDistance(line, trip, now + 1)
      const next = this.nextStop(line, d, trip)
      return {
        type: 'train',
        id,
        line: index,
        speedKmh: ahead >= 0 ? Math.abs(ahead - d) * 3.6 : 0,
        delayMinutes: 0,
        nextStop: next?.name ?? null,
        nextStopTime: next?.time ?? null,
        detour: false,
        onBoard: null,
        capacity: null,
        route: null,
      }
    }
    return null
  }
}

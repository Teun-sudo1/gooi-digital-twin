import { create } from 'zustand'
import { amsterdamClockNow } from '../features/map/lighting'
import type { SimulationClient } from '../features/simulation/client'
import type { Comparison, FollowInfo, SimulationStats, StopBoard, TransitLineInfo } from '../types/simulation'

/** The day chart keeps one averaged point per quarter of an hour. */
export const DAY_SLOTS = 96
export const SLOT_SECONDS = 86_400 / DAY_SLOTS

export interface HistoryPoint {
  /** Start of the quarter hour, in seconds since midnight. */
  clock: number
  cars: number
  bikes: number
  averageCarSpeedKmh: number
  delayedCars: number
}

interface SimulationState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** Set once the worker has loaded the networks; UI controls call into it. */
  controller: SimulationClient | null
  /** The simulation starts at the current time of day in the Netherlands. */
  startClock: number
  playing: boolean
  /** Simulated seconds per real second. */
  speed: number
  /** Cars on the road at peak demand (bikes scale with it). */
  density: number
  /** Throttled snapshot (about 4× per second), so React never renders per frame. */
  stats: SimulationStats | null
  /** Simulated values per quarter hour of the day (null where the simulation hasn't been yet). */
  day: (HistoryPoint | null)[]
  lines: TransitLineInfo[]
  /** Service date (YYYYMMDD) of the real timetable in use, or null when frequencies are assumed. */
  timetableDate: string | null
  /** Time chosen on the slider while the simulation catches up, so the UI responds at once. */
  draftClock: number | null
  /** The vehicle the camera follows, and its latest details. */
  followId: number | null
  followInfo: FollowInfo | null
  /** Set when the followed vehicle reached its destination or left the area. */
  followGone: boolean
  /** Turn the map with the followed vehicle. */
  chase: boolean
  /** The edited network against the original, while road changes are active. */
  comparison: Comparison | null
  /** Colour streets by how much busier or quieter they became. */
  showChanges: boolean
  /** The stop whose departure board is open, and the board itself. */
  stop: { line: number; stop: number } | null
  board: StopBoard | null
}

export function emptyDay(): (HistoryPoint | null)[] {
  return new Array(DAY_SLOTS).fill(null)
}

export const SPEED_OPTIONS = [1, 5, 20, 60]

export const useSimulationStore = create<SimulationState>(() => ({
  status: 'idle',
  error: null,
  controller: null,
  startClock: amsterdamClockNow(),
  playing: false,
  speed: 5,
  density: 3000,
  stats: null,
  day: emptyDay(),
  lines: [],
  timetableDate: null,
  draftClock: null,
  followId: null,
  followInfo: null,
  followGone: false,
  chase: false,
  comparison: null,
  showChanges: true,
  stop: null,
  board: null,
}))

/** The time of day to show: a just-chosen time first, then the simulation's own clock. */
export const selectClock = (s: SimulationState) => s.draftClock ?? s.stats?.clock ?? s.startClock

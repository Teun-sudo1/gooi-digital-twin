import { create } from 'zustand'
import { amsterdamClockNow } from '../features/map/lighting'
import type { SimulationClient } from '../features/simulation/client'
import type { SimulationStats, TransitLineInfo } from '../types/simulation'

export interface HistoryPoint {
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
  history: HistoryPoint[]
  lines: TransitLineInfo[]
  /** Service date (YYYYMMDD) of the real timetable in use, or null when frequencies are assumed. */
  timetableDate: string | null
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
  history: [],
  lines: [],
  timetableDate: null,
}))

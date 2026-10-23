import { create } from 'zustand'
import type { SimulationController } from '../features/simulation/controller'
import type { SimulationStats } from '../types/simulation'

export interface HistoryPoint {
  clock: number
  activeVehicles: number
  averageSpeedKmh: number
  delayedVehicles: number
}

interface SimulationState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** Set once the road network has loaded; UI controls call into it. */
  controller: SimulationController | null
  playing: boolean
  /** Simulated seconds per real second. */
  speed: number
  /** Cars on the road at peak demand. */
  density: number
  /** Throttled snapshot (about 4× per second), so React never renders per frame. */
  stats: SimulationStats | null
  history: HistoryPoint[]
}

export const SPEED_OPTIONS = [1, 5, 20, 60]

export const useSimulationStore = create<SimulationState>(() => ({
  status: 'idle',
  error: null,
  controller: null,
  playing: false,
  speed: 5,
  density: 900,
  stats: null,
  history: [],
}))

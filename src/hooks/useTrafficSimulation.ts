import { useEffect } from 'react'
import { SimulationClient } from '../features/simulation/client'
import { useSimulationStore } from '../store/useSimulationStore'
import { useMapInstance } from './useMapInstance'

/** Starts the simulation worker once the map is ready, and stops it on unmount. */
export function useTrafficSimulation() {
  const map = useMapInstance()

  useEffect(() => {
    if (!map) return
    useSimulationStore.setState({ status: 'loading', error: null })
    const client = new SimulationClient(map)
    useSimulationStore.setState({ controller: client })
    return () => {
      client.dispose()
      useSimulationStore.setState({ status: 'idle', controller: null, playing: false, stats: null, history: [] })
    }
  }, [map])
}

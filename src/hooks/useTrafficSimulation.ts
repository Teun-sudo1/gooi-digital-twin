import { useEffect } from 'react'
import { SimulationController } from '../features/simulation/controller'
import { buildRoadGraph, loadRoadNetwork } from '../features/simulation/graph'
import { useSimulationStore } from '../store/useSimulationStore'
import { useMapInstance } from './useMapInstance'

/** Loads the Huizen road network once the map is ready, then starts the simulation. */
export function useTrafficSimulation() {
  const map = useMapInstance()

  useEffect(() => {
    if (!map) return
    let cancelled = false
    let controller: SimulationController | null = null
    useSimulationStore.setState({ status: 'loading', error: null })

    loadRoadNetwork()
      .then((file) => {
        if (cancelled) return
        controller = new SimulationController(map, buildRoadGraph(file))
        useSimulationStore.setState({ status: 'ready', controller })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        console.error('[simulation]', error)
        useSimulationStore.setState({
          status: 'error',
          error: 'The road network could not be loaded, so the traffic simulation is unavailable.',
        })
      })

    return () => {
      cancelled = true
      controller?.dispose()
      useSimulationStore.setState({ status: 'idle', controller: null, playing: false, stats: null, history: [] })
    }
  }, [map])
}

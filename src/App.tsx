import { CameraControls } from './components/CameraControls'
import { LayerPanel } from './components/LayerPanel'
import { FollowCard } from './components/FollowCard'
import { LightingController } from './components/LightingController'
import { RouteDiagram } from './components/RouteDiagram'
import { ScenarioPanel } from './components/ScenarioPanel'
import { ShortcutsPanel } from './components/ShortcutsPanel'
import { SimulationBar } from './components/SimulationBar'
import { SimulationDashboard } from './components/SimulationDashboard'
import { StatusOverlay } from './components/StatusOverlay'
import { TopBar } from './components/TopBar'
import { MapView } from './features/map/MapView'
import { useComparisonLayer } from './features/scenarios/useComparisonLayer'
import { useScenarioEditing } from './features/scenarios/useScenarioEditing'
import { useScenery } from './features/scenery/useScenery'
import { useFollowVehicle } from './features/simulation/useFollowVehicle'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useTrafficSimulation } from './hooks/useTrafficSimulation'

export default function App() {
  useTrafficSimulation()
  useKeyboardShortcuts()
  useScenarioEditing()
  useScenery()
  useFollowVehicle()
  useComparisonLayer()

  return (
    <div className="app">
      <MapView />
      <div className="left-column">
        <TopBar />
        <SimulationDashboard />
      </div>
      <div className="right-column">
        <RouteDiagram />
        <LayerPanel />
        <ScenarioPanel />
      </div>
      <CameraControls />
      <ShortcutsPanel />
      <FollowCard />
      <SimulationBar />
      <StatusOverlay />
      <LightingController />
    </div>
  )
}

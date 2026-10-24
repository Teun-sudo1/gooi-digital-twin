import { CameraControls } from './components/CameraControls'
import { LayerPanel } from './components/LayerPanel'
import { LightingController } from './components/LightingController'
import { ScenarioPanel } from './components/ScenarioPanel'
import { ShortcutsPanel } from './components/ShortcutsPanel'
import { SimulationBar } from './components/SimulationBar'
import { SimulationDashboard } from './components/SimulationDashboard'
import { StatusOverlay } from './components/StatusOverlay'
import { TopBar } from './components/TopBar'
import { MapView } from './features/map/MapView'
import { useScenarioEditing } from './features/scenarios/useScenarioEditing'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useTrafficSimulation } from './hooks/useTrafficSimulation'

export default function App() {
  useTrafficSimulation()
  useKeyboardShortcuts()
  useScenarioEditing()

  return (
    <div className="app">
      <MapView />
      <div className="left-column">
        <TopBar />
        <SimulationDashboard />
      </div>
      <div className="right-column">
        <LayerPanel />
        <ScenarioPanel />
      </div>
      <CameraControls />
      <ShortcutsPanel />
      <SimulationBar />
      <StatusOverlay />
      <LightingController />
    </div>
  )
}

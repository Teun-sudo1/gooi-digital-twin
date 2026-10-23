import { CameraControls } from './components/CameraControls'
import { LayerPanel } from './components/LayerPanel'
import { ShortcutsPanel } from './components/ShortcutsPanel'
import { SimulationBar } from './components/SimulationBar'
import { SimulationDashboard } from './components/SimulationDashboard'
import { StatusOverlay } from './components/StatusOverlay'
import { TopBar } from './components/TopBar'
import { MapView } from './features/map/MapView'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useTrafficSimulation } from './hooks/useTrafficSimulation'

export default function App() {
  useTrafficSimulation()
  useKeyboardShortcuts()

  return (
    <div className="app">
      <MapView />
      <div className="left-column">
        <TopBar />
        <SimulationDashboard />
      </div>
      <LayerPanel />
      <CameraControls />
      <ShortcutsPanel />
      <SimulationBar />
      <StatusOverlay />
    </div>
  )
}

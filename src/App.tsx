import { CameraControls } from './components/CameraControls'
import { LayerPanel } from './components/LayerPanel'
import { FollowCard } from './components/FollowCard'
import { LightingController } from './components/LightingController'
import { MobileDock } from './components/MobileDock'
import { RouteDiagram } from './components/RouteDiagram'
import { ScenarioPanel } from './components/ScenarioPanel'
import { StopBoardPanel } from './components/StopBoardPanel'
import { ShortcutsPanel } from './components/ShortcutsPanel'
import { SimulationBar } from './components/SimulationBar'
import { SimulationDashboard } from './components/SimulationDashboard'
import { StatusOverlay } from './components/StatusOverlay'
import { TopBar } from './components/TopBar'
import { WeatherOverlay } from './components/WeatherOverlay'
import { useEnvironment } from './features/environment/useEnvironment'
import { MapView } from './features/map/MapView'
import { useComparisonLayer } from './features/scenarios/useComparisonLayer'
import { useScenarioEditing } from './features/scenarios/useScenarioEditing'
import { useScenery } from './features/scenery/useScenery'
import { useFollowVehicle } from './features/simulation/useFollowVehicle'
import { useIsMobile } from './hooks/useIsMobile'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useTrafficSimulation } from './hooks/useTrafficSimulation'

export default function App() {
  useTrafficSimulation()
  useKeyboardShortcuts()
  useScenarioEditing()
  useScenery()
  useEnvironment()
  useFollowVehicle()
  useComparisonLayer()

  const mobile = useIsMobile()

  return (
    <div className={`app ${mobile ? 'mobile' : ''}`}>
      <MapView />
      <WeatherOverlay />
      <div className="left-column">
        <TopBar />
        {!mobile && <SimulationDashboard />}
      </div>
      {!mobile && (
        <div className="right-column">
          <StopBoardPanel />
          <RouteDiagram />
          <LayerPanel />
          <ScenarioPanel />
        </div>
      )}
      <CameraControls />
      <ShortcutsPanel />
      <FollowCard />
      {mobile ? <MobileDock /> : <SimulationBar />}
      <StatusOverlay />
      <LightingController />
    </div>
  )
}

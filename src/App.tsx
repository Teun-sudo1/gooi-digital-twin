import { CameraControls } from './components/CameraControls'
import { DataNotice } from './components/DataNotice'
import { LayerPanel } from './components/LayerPanel'
import { StatusOverlay } from './components/StatusOverlay'
import { TopBar } from './components/TopBar'
import { MapView } from './features/map/MapView'

export default function App() {
  return (
    <div className="app">
      <MapView />
      <TopBar />
      <LayerPanel />
      <CameraControls />
      <DataNotice />
      <StatusOverlay />
    </div>
  )
}

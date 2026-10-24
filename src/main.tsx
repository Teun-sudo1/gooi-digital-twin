import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { applyTheme, nightFactorFor } from './features/map/lighting'
import { useSimulationStore } from './store/useSimulationStore'
import './styles.css'

applyTheme(nightFactorFor('auto', useSimulationStore.getState().startClock))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

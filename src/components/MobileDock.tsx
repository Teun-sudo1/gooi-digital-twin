import { useState } from 'react'
import { useSimulationStore } from '../store/useSimulationStore'
import { LayerPanel } from './LayerPanel'
import { RouteDiagram } from './RouteDiagram'
import { ScenarioPanel } from './ScenarioPanel'
import { SimulationBar } from './SimulationBar'
import { SimulationDashboard } from './SimulationDashboard'
import { StopBoardPanel } from './StopBoardPanel'

type Tab = 'stats' | 'roads' | 'layers' | 'stop' | 'route'

/**
 * Phone layout: simulation controls with a tab bar underneath; the chosen
 * tab opens as a sheet above them, and tapping it again closes it.
 */
export function MobileDock() {
  const [tab, setTab] = useState<Tab | null>(null)
  const stop = useSimulationStore((s) => s.stop)
  const route = useSimulationStore((s) => (s.followInfo?.type === 'bus' ? s.followInfo.route !== null : false))

  // A stop picked on the map opens its tab (adjusting state while rendering, as React recommends).
  const [seenStop, setSeenStop] = useState(stop)
  if (stop !== seenStop) {
    setSeenStop(stop)
    if (stop) setTab('stop')
  }
  // A tab whose content has gone (stop closed, bus no longer followed) shows nothing.
  const shown = (tab === 'stop' && !stop) || (tab === 'route' && !route) ? null : tab

  const tabs: { id: Tab; label: string }[] = [
    { id: 'stats', label: 'Stats' },
    { id: 'roads', label: 'Roads' },
    { id: 'layers', label: 'Layers' },
    ...(stop ? [{ id: 'stop' as const, label: 'Stop' }] : []),
    ...(route ? [{ id: 'route' as const, label: 'Route' }] : []),
  ]

  return (
    <div className="mobile-dock">
      {shown && (
        <div className="mobile-sheet panel">
          {shown === 'stats' && <SimulationDashboard embedded />}
          {shown === 'roads' && <ScenarioPanel embedded />}
          {shown === 'layers' && <LayerPanel embedded />}
          {shown === 'stop' && <StopBoardPanel embedded />}
          {shown === 'route' && <RouteDiagram embedded />}
        </div>
      )}
      <SimulationBar />
      <nav className="mobile-tabs panel" aria-label="Panels">
        {tabs.map((t) => (
          <button key={t.id} className={shown === t.id ? 'active' : undefined} aria-pressed={shown === t.id} onClick={() => setTab(shown === t.id ? null : t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}

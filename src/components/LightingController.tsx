import { useEffect } from 'react'
import { applyTheme, nightFactorFor } from '../features/map/lighting'
import { applyPalette, paletteFor } from '../features/map/style'
import { useMapInstance } from '../hooks/useMapInstance'
import { useAppStore } from '../store/useAppStore'
import { selectClock, useSimulationStore } from '../store/useSimulationStore'

/**
 * Follows the simulated sun: recolours the map, switches the interface
 * between light and dark, and turns on headlights after dusk. Renders
 * nothing; kept separate so clock updates don't re-render the app.
 */
export function LightingController() {
  const map = useMapInstance()
  const mode = useAppStore((s) => s.lightingMode)
  const controller = useSimulationStore((s) => s.controller)
  // Quantised so the map is only recoloured when the light visibly changes.
  const night = useSimulationStore((s) => Math.round(nightFactorFor(mode, selectClock(s)) * 40) / 40)

  useEffect(() => applyTheme(night), [night])
  useEffect(() => {
    if (map) applyPalette(map, paletteFor(night))
  }, [map, night])
  useEffect(() => {
    controller?.setNight(night)
  }, [controller, night])

  return null
}

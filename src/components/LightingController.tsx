import { useEffect, useMemo } from 'react'
import { seasonalPalette, seasonDate } from '../features/environment/environment'
import { applyTheme, nightFactorFor } from '../features/map/lighting'
import { AERIAL, applyPalette, paletteFor } from '../features/map/style'
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
  const season = useAppStore((s) => s.season)
  const seasonSetting = useAppStore((s) => s.seasonSetting)
  const weather = useAppStore((s) => s.weather)
  const controller = useSimulationStore((s) => s.controller)
  const clock = useSimulationStore(selectClock)
  // The season moves the sun; quantised so the map only recolours when the light visibly changes.
  const date = useMemo(() => (seasonSetting === 'auto' ? undefined : seasonDate(seasonSetting)), [seasonSetting])
  const night = Math.round(nightFactorFor(mode, clock, date) * 40) / 40

  useEffect(() => applyTheme(night), [night])
  useEffect(() => {
    if (!map) return
    applyPalette(map, seasonalPalette(paletteFor(night), season, weather, night))
    // Aerial photos dim with the light.
    if (map.getLayer(AERIAL)) {
      map.setPaintProperty(AERIAL, 'raster-brightness-max', 1 - 0.72 * night)
      map.setPaintProperty(AERIAL, 'raster-saturation', -0.4 * night)
    }
  }, [map, night, season, weather])
  useEffect(() => {
    controller?.setNight(night)
  }, [controller, night])

  return null
}

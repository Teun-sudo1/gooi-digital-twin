import { useEffect } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { useSimulationStore } from '../../store/useSimulationStore'
import { setSunDate } from '../map/lighting'
import { fetchLiveWeather, seasonDate, seasonOf, WEATHER_EFFECTS } from './environment'

/** Live weather is refreshed this often (ms). */
const LIVE_REFRESH = 15 * 60 * 1000

/**
 * Keeps the weather and season in effect: fetches live weather when chosen,
 * sets the date for the sun, and passes the weather's travel effects to the
 * simulation.
 */
export function useEnvironment() {
  const weatherSetting = useAppStore((s) => s.weatherSetting)
  const seasonSetting = useAppStore((s) => s.seasonSetting)
  const liveWeather = useAppStore((s) => s.liveWeather)
  const weather = useAppStore((s) => s.weather)
  const controller = useSimulationStore((s) => (s.status === 'ready' ? s.controller : null))

  // Live weather from Open-Meteo, refreshed while it's in use.
  useEffect(() => {
    if (weatherSetting !== 'live') return
    let cancelled = false
    const load = () =>
      fetchLiveWeather()
        .then((live) => !cancelled && useAppStore.setState({ liveWeather: live }))
        .catch((error) => console.warn('[weather]', error))
    void load()
    const timer = window.setInterval(load, LIVE_REFRESH)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [weatherSetting])

  useEffect(() => {
    const effective = weatherSetting === 'live' ? (liveWeather?.weather ?? 'dry') : weatherSetting
    useAppStore.setState({ weather: effective })
  }, [weatherSetting, liveWeather])

  useEffect(() => {
    setSunDate(seasonSetting === 'auto' ? null : seasonDate(seasonSetting))
    useAppStore.setState({ season: seasonSetting === 'auto' ? seasonOf(new Date()) : seasonSetting })
  }, [seasonSetting])

  useEffect(() => {
    controller?.setWeather(WEATHER_EFFECTS[weather])
  }, [controller, weather])
}

import type { WeatherEffects } from '../../types/simulation'
import type { Palette } from '../map/style'

/*
 * Weather and seasons. Weather changes how people travel (assumed effects,
 * loosely after Dutch studies: rain moves some cyclists into cars and slows
 * everyone down) and is drawn over the map. "Live" uses the current weather
 * in the Gooi from Open-Meteo. The season sets the date used for the sun
 * (so daylight hours follow it) and colours the trees and parks.
 */

export type Weather = 'dry' | 'rain' | 'heavy-rain' | 'snow' | 'fog'
export type WeatherSetting = 'live' | Weather
export type Season = 'spring' | 'summer' | 'autumn' | 'winter'
export type SeasonSetting = 'auto' | Season

export const WEATHER_LABELS: Record<WeatherSetting, string> = {
  live: 'Live',
  dry: 'Dry',
  rain: 'Rain',
  'heavy-rain': 'Heavy rain',
  snow: 'Snow',
  fog: 'Fog',
}

export const SEASON_LABELS: Record<SeasonSetting, string> = {
  auto: 'Today',
  spring: 'Spring',
  summer: 'Summer',
  autumn: 'Autumn',
  winter: 'Winter',
}

/** Assumed effects on travel, relative to dry weather. */
export const WEATHER_EFFECTS: Record<Weather, WeatherEffects> = {
  dry: { carDemand: 1, bikeDemand: 1, carSpeed: 1, bikeSpeed: 1, busDemand: 1 },
  rain: { carDemand: 1.08, bikeDemand: 0.65, carSpeed: 0.92, bikeSpeed: 0.93, busDemand: 1.2 },
  'heavy-rain': { carDemand: 1.12, bikeDemand: 0.4, carSpeed: 0.82, bikeSpeed: 0.85, busDemand: 1.35 },
  snow: { carDemand: 0.95, bikeDemand: 0.3, carSpeed: 0.65, bikeSpeed: 0.7, busDemand: 1.3 },
  fog: { carDemand: 1, bikeDemand: 0.95, carSpeed: 0.8, bikeSpeed: 0.95, busDemand: 1.05 },
}

/** WMO weather code (Open-Meteo) to a weather type. */
export function weatherFromCode(code: number): Weather {
  if (code === 45 || code === 48) return 'fog'
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow'
  if (code === 65 || code === 67 || code === 82 || code >= 95) return 'heavy-rain'
  if (code >= 51) return 'rain'
  return 'dry'
}

export interface LiveWeather {
  weather: Weather
  temperature: number
  /** When Open-Meteo measured it (ISO, local time). */
  time: string
}

/** Current weather over the Gooi from Open-Meteo (no key needed; only fixed coordinates are sent). */
export async function fetchLiveWeather(): Promise<LiveWeather> {
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=52.26&longitude=5.21&current=weather_code,temperature_2m&timezone=Europe%2FAmsterdam'
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Open-Meteo: HTTP ${response.status}`)
  const data = (await response.json()) as { current: { weather_code: number; temperature_2m: number; time: string } }
  return { weather: weatherFromCode(data.current.weather_code), temperature: data.current.temperature_2m, time: data.current.time }
}

export function seasonOf(date: Date): Season {
  const m = date.getMonth()
  if (m >= 2 && m <= 4) return 'spring'
  if (m >= 5 && m <= 7) return 'summer'
  if (m >= 8 && m <= 10) return 'autumn'
  return 'winter'
}

/** The date the sun is computed for: today, or the middle of the chosen season. */
export function seasonDate(setting: SeasonSetting, today = new Date()): Date {
  if (setting === 'auto') return today
  const month = { spring: 3, summer: 6, autumn: 9, winter: 0 }[setting]
  return new Date(Date.UTC(today.getUTCFullYear(), month, 15, 12))
}

/** Mixes two hex colours. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16)
  const pb = Number.parseInt(b.slice(1), 16)
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t)
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`
}

/** Greens follow the season; snow whitens open ground. */
export function seasonalPalette(palette: Palette, season: Season, weather: Weather, night: number): Palette {
  const p = { ...palette }
  const tint = (key: 'wood' | 'grass' | 'park', colour: string, t: number) => {
    p[key] = mixHex(p[key], colour, t * (1 - 0.6 * night))
  }
  if (season === 'spring') {
    tint('grass', '#9fd36b', 0.15)
    tint('park', '#9fd36b', 0.15)
  } else if (season === 'autumn') {
    tint('wood', '#b8873a', 0.35)
    tint('grass', '#b5a65a', 0.2)
    tint('park', '#b5a65a', 0.15)
  } else if (season === 'winter') {
    tint('wood', '#8f877b', 0.45)
    tint('grass', '#aaa894', 0.4)
    tint('park', '#aaa894', 0.35)
  }
  if (weather === 'snow') {
    const snow = mixHex('#f4f6f9', '#6f7a88', night)
    for (const key of ['background', 'landuse', 'wood', 'grass', 'park'] as const) p[key] = mixHex(p[key], snow, 0.6)
  }
  if (weather === 'rain' || weather === 'heavy-rain' || weather === 'fog') {
    // Overcast: a flatter, greyer light.
    const grey = mixHex('#c3c8cf', '#2a3038', night)
    const t = weather === 'heavy-rain' ? 0.18 : 0.1
    for (const key of ['background', 'landuse', 'grass', 'park', 'wood'] as const) p[key] = mixHex(p[key], grey, t)
  }
  return p
}

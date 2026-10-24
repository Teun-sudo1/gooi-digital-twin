import { REGION_CENTER } from '../../data/places'

/*
 * Day and night follow the simulated clock: the sun's elevation over the Gooi
 * is computed for today's date (Europe/Amsterdam time), and the map fades
 * from the day palette to the night palette through twilight.
 */

const RAD = Math.PI / 180

/** Minutes east of UTC for Amsterdam on the given date (60 in winter, 120 in summer). */
export function amsterdamOffsetMinutes(date: Date): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(part ?? '')
  if (!match) return 60
  const hours = Number(match[1])
  return hours * 60 + Math.sign(hours) * Number(match[2] ?? 0)
}

/** Current local time in Amsterdam as seconds since midnight. */
export function amsterdamClockNow(now = new Date()): number {
  const utcSeconds = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()
  return (utcSeconds + amsterdamOffsetMinutes(now) * 60 + 86_400) % 86_400
}

/**
 * Solar elevation in degrees at a local (Amsterdam) clock time on `date`,
 * using the NOAA approximation (accurate to a fraction of a degree).
 */
export function sunElevation(clock: number, date = new Date(), [lng, lat] = REGION_CENTER): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1)
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000) + 1
  const utcMinutes = clock / 60 - amsterdamOffsetMinutes(date)
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcMinutes / 60 - 12) / 24)
  const eqTime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma))
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma)
  const trueSolarMinutes = utcMinutes + eqTime + 4 * lng
  const hourAngle = (trueSolarMinutes / 4 - 180) * RAD
  const cosZenith = Math.sin(lat * RAD) * Math.sin(decl) + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(hourAngle)
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) / RAD
}

/** 0 in daylight, 1 at night, easing through twilight (sun between +3° and −7°). */
export function nightFactor(elevation: number): number {
  const t = Math.max(0, Math.min(1, (3 - elevation) / 10))
  return t * t * (3 - 2 * t)
}

/** Light or dark interface, matching the map. */
export function applyTheme(night: number) {
  document.documentElement.dataset.theme = night > 0.5 ? 'dark' : 'light'
}

export type LightingMode = 'auto' | 'day' | 'night'

export function nightFactorFor(mode: LightingMode, clock: number): number {
  if (mode === 'day') return 0
  if (mode === 'night') return 1
  return nightFactor(sunElevation(clock))
}

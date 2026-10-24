/** "07:05" from seconds since midnight. */
export function formatClock(seconds: number): string {
  const total = Math.floor(seconds / 60) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** The part of the day the simulated demand profile is in. */
export function dayPeriod(seconds: number): string {
  const h = seconds / 3600
  if (h < 6) return 'Night'
  if (h < 9.5) return 'Morning rush'
  if (h < 15.5) return 'Daytime'
  if (h < 18.5) return 'Evening rush'
  if (h < 22) return 'Evening'
  return 'Night'
}

const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** 1,284 / 12.9K: whole numbers below 10,000, compact above. */
export function formatCount(value: number): string {
  return value < 10_000 ? whole.format(value) : compact.format(value)
}

export function formatDecimal(value: number): string {
  return oneDecimal.format(value)
}

/** "Huizen, Karel Doormanlaan" → "Karel Doorman…": a stop name without its town, shortened to fit. */
export function shortName(name: string | null, max = 14): string {
  if (!name) return 'Stop'
  const part = name.split(', ').pop()!
  return part.length > max ? `${part.slice(0, max - 1)}…` : part
}

/** Line badge colours: the line colour with dark or light text, whichever reads better. */
export function badgeStyle(colour: string): { background: string; color: string } {
  const n = Number.parseInt(colour.slice(1), 16)
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return { background: colour, color: luminance > 0.6 ? '#111418' : '#ffffff' }
}

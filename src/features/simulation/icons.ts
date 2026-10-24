import type { Map as MapLibreMap } from 'maplibre-gl'
import { AgentFlag, Kind, type TransitLineInfo } from '../../types/simulation'

/*
 * Top-down vehicle icons, drawn once on a canvas and registered with
 * MapLibre. Icons point up (direction of travel) and are drawn at 2 CSS px
 * per metre at icon-size 1, so relative sizes are real: a truck is twice a
 * hatchback, a bus is 12 m, a train carriage 26.5 m. Bikes and pedestrians
 * are drawn larger than life so they stay visible.
 */

const RATIO = 2
/** Canvas pixels per metre. */
const PX = 2 * RATIO

export const CAR_COLOURS = ['#eef0f2', '#1d2025', '#6b7280', '#b9c0c8', '#2f5d9e', '#b0302c', '#2f5d45', '#c9b48f']
/** Thin dark edge so people stand out on light and dark maps alike. */
const OUTLINE = 'rgba(15, 20, 28, 0.65)'

export const CLOTHING_COLOURS = ['#e8590c', '#1c7ed6', '#2b8a3e', '#c2255c', '#f2c94c', '#495057']

const CAR_SIZE: Record<number, [number, number]> = {
  [Kind.Hatchback]: [1.75, 3.9],
  [Kind.Sedan]: [1.8, 4.7],
  [Kind.Suv]: [1.95, 4.8],
  [Kind.Van]: [2.0, 5.4],
  [Kind.Truck]: [2.5, 10],
}

function canvas(widthM: number, lengthM: number) {
  const c = document.createElement('canvas')
  c.width = Math.ceil(widthM * PX) + 4
  c.height = Math.ceil(lengthM * PX) + 4
  const ctx = c.getContext('2d')!
  ctx.translate(2, 2)
  return ctx
}

function shade(hex: string, amount: number) {
  const n = Number.parseInt(hex.slice(1), 16)
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * (1 + amount))))
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`
}

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.roundRect(x * PX, y * PX, w * PX, h * PX, r * PX)
  ctx.fill()
}

function drawCar(kind: Kind, colour: string, braking: boolean) {
  const [w, l] = CAR_SIZE[kind]
  const ctx = canvas(w, l)
  rect(ctx, 0.08, 0.1, w, l, 0.45, 'rgba(0,0,0,0.35)') // shadow
  const glass = 'rgba(20, 28, 38, 0.85)'
  if (kind === Kind.Truck) {
    rect(ctx, 0, 2.5, w, l - 2.5, 0.15, shade('#e9ecef', -0.05)) // box
    rect(ctx, 0.1, 0, w - 0.2, 2.3, 0.4, colour) // cab
    rect(ctx, 0.3, 0.35, w - 0.6, 0.55, 0.15, glass)
  } else {
    rect(ctx, 0, 0, w, l, kind === Kind.Van ? 0.35 : 0.6, colour)
    const roof = shade(colour, colour === CAR_COLOURS[1] ? 0.5 : -0.08)
    if (kind === Kind.Van) {
      rect(ctx, 0.2, 0.55, w - 0.4, 0.6, 0.15, glass)
      rect(ctx, 0.15, 1.3, w - 0.3, l - 1.6, 0.2, roof)
    } else {
      const front = kind === Kind.Hatchback ? 0.85 : 1.05
      rect(ctx, 0.22, front, w - 0.44, 0.75, 0.2, glass) // windscreen
      rect(ctx, 0.25, front + 0.8, w - 0.5, l - front - (kind === Kind.Hatchback ? 1.55 : 2.1), 0.25, roof)
      rect(ctx, 0.3, l - (kind === Kind.Hatchback ? 0.7 : 1.15), w - 0.6, 0.45, 0.15, glass) // rear window
    }
  }
  // Headlamps and brake lights.
  rect(ctx, 0.15, 0.02, 0.4, 0.14, 0.05, '#fff6d0')
  rect(ctx, w - 0.55, 0.02, 0.4, 0.14, 0.05, '#fff6d0')
  const brake = braking ? '#ff2a1a' : '#6b1410'
  rect(ctx, 0.12, l - 0.16, 0.45, 0.14, 0.05, brake)
  rect(ctx, w - 0.57, l - 0.16, 0.45, 0.14, 0.05, brake)
  if (braking) {
    ctx.shadowColor = 'rgba(255, 40, 20, 0.9)'
    ctx.shadowBlur = 6
    rect(ctx, 0.12, l - 0.16, 0.45, 0.14, 0.05, brake)
    rect(ctx, w - 0.57, l - 0.16, 0.45, 0.14, 0.05, brake)
  }
  return ctx
}

/** A cyclist, drawn ~1.7× life size. */
function drawBike(colour: string) {
  const s = 1.7
  const ctx = canvas(0.7 * s, 1.9 * s)
  rect(ctx, 0.3 * s, 0, 0.1 * s, 1.9 * s, 0.05, '#2b2f36') // frame and wheels
  rect(ctx, 0.08 * s, 0.35 * s, 0.54 * s, 0.08 * s, 0.03, '#2b2f36') // handlebar
  ctx.fillStyle = colour
  ctx.strokeStyle = OUTLINE
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.ellipse(0.35 * s * PX, 0.85 * s * PX, 0.3 * s * PX, 0.22 * s * PX, 0, 0, Math.PI * 2) // shoulders
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#e6c3a0'
  ctx.beginPath()
  ctx.arc(0.35 * s * PX, 0.72 * s * PX, 0.12 * s * PX, 0, Math.PI * 2) // head
  ctx.fill()
  return ctx
}

/** A pedestrian, drawn ~2.5× life size. */
function drawPedestrian(colour: string) {
  const s = 2.5
  const ctx = canvas(0.6 * s, 0.6 * s)
  ctx.fillStyle = colour
  ctx.strokeStyle = OUTLINE
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.ellipse(0.3 * s * PX, 0.3 * s * PX, 0.28 * s * PX, 0.18 * s * PX, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#d9b48f'
  ctx.beginPath()
  ctx.arc(0.3 * s * PX, 0.28 * s * PX, 0.11 * s * PX, 0, Math.PI * 2)
  ctx.fill()
  return ctx
}

function drawBus(lineColour: string) {
  const w = 2.55
  const l = 12
  const ctx = canvas(w, l)
  rect(ctx, 0.1, 0.12, w, l, 0.3, 'rgba(0,0,0,0.35)')
  rect(ctx, 0, 0, w, l, 0.4, '#f1f3f5')
  rect(ctx, 0.25, 0.35, w - 0.5, 0.75, 0.15, 'rgba(20, 28, 38, 0.85)')
  rect(ctx, 0.35, 1.5, w - 0.7, l - 2.2, 0.2, lineColour) // roof band in the line colour
  rect(ctx, 0.55, 3, w - 1.1, 1.2, 0.1, 'rgba(255,255,255,0.35)') // roof units
  return ctx
}

function drawTrainCar(variant: number) {
  const w = 2.9
  const l = 26.5
  const ctx = canvas(w, l)
  rect(ctx, 0, 0, w, l, 0.5, variant === 1 ? '#f1f3f5' : '#ffc917')
  rect(ctx, 0.35, 0.4, w - 0.7, l - 0.8, 0.3, variant === 1 ? '#c92a2a' : '#003082')
  rect(ctx, 0.7, 1, w - 1.4, l - 2, 0.2, variant === 1 ? '#dee2e6' : '#ffd84d')
  return ctx
}

/** Soft cone of light ahead of a vehicle, used at night. Anchored at its bottom (the car's front). */
function drawBeam() {
  const w = 8
  const l = 22
  const ctx = canvas(w, l)
  const gradient = ctx.createLinearGradient(0, l * PX, 0, 0)
  gradient.addColorStop(0, 'rgba(255, 236, 180, 0.55)')
  gradient.addColorStop(1, 'rgba(255, 236, 180, 0)')
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.moveTo((w / 2 - 0.9) * PX, l * PX)
  ctx.lineTo((w / 2 + 0.9) * PX, l * PX)
  ctx.lineTo(w * PX, 0)
  ctx.lineTo(0, 0)
  ctx.closePath()
  ctx.fill()
  return ctx
}

const register = (map: MapLibreMap, name: string, ctx: CanvasRenderingContext2D) => {
  if (map.hasImage(name)) return
  const { width, height } = ctx.canvas
  map.addImage(name, ctx.getImageData(0, 0, width, height), { pixelRatio: RATIO })
}

/** Icon name for an agent in a frame. Names are cached so no strings are built per frame. */
const names = new Map<number, string>()
export function agentIcon(kind: number, colour: number, flags: number): string {
  const braking = kind <= Kind.Truck && (flags & AgentFlag.Braking) !== 0 ? 1 : 0
  const key = kind * 1000 + colour * 10 + braking
  let name = names.get(key)
  if (!name) {
    name = kind <= Kind.Truck ? `car-${kind}-${colour}-${braking}` : kind === Kind.Bike ? `bike-${colour}` : `ped-${colour}`
    names.set(key, name)
  }
  return name
}

export function registerIcons(map: MapLibreMap, lines: TransitLineInfo[]) {
  for (const kind of [Kind.Hatchback, Kind.Sedan, Kind.Suv, Kind.Van, Kind.Truck]) {
    CAR_COLOURS.forEach((colour, c) => {
      register(map, `car-${kind}-${c}-0`, drawCar(kind, colour, false))
      register(map, `car-${kind}-${c}-1`, drawCar(kind, colour, true))
    })
  }
  CLOTHING_COLOURS.forEach((colour, c) => {
    register(map, `bike-${c}`, drawBike(colour))
    register(map, `ped-${c}`, drawPedestrian(colour))
  })
  for (const line of lines) if (line.mode === 'bus') register(map, `bus-${line.colour}`, drawBus(line.colour))
  register(map, 'train-0', drawTrainCar(0))
  register(map, 'train-1', drawTrainCar(1))
  register(map, 'beam', drawBeam())
}

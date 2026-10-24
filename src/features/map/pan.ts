import type { Map as MapLibreMap } from 'maplibre-gl'

/** Screen pixels per second while a move key is held (Shift moves faster). */
const PAN_SPEED = 650
const FAST = 2.5
/** Seconds to reach full speed, so short taps make small, precise moves. */
const RAMP = 0.25

export interface CameraPanner {
  /** Start moving in a screen direction (x right, y down); `source` identifies the key. */
  start(source: string, dx: number, dy: number): void
  stop(source: string): void
  stopAll(): void
  /** Move faster while Shift is held. */
  setFast(fast: boolean): void
}

/**
 * Continuous camera movement driven by requestAnimationFrame, in screen space,
 * so "forward" is always the direction the view faces, whatever the bearing.
 */
function createPanner(map: MapLibreMap): CameraPanner {
  const held = new Map<string, [number, number]>()
  let frame = 0
  let last = 0
  let started = 0
  let fast = false

  const tick = (now: number) => {
    if (held.size === 0) {
      frame = 0
      return
    }
    const dt = Math.min((now - last) / 1000, 0.05)
    last = now
    let x = 0
    let y = 0
    for (const [dx, dy] of held.values()) {
      x += dx
      y += dy
    }
    const length = Math.hypot(x, y)
    if (length > 0) {
      const ramp = Math.min(1, (now - started) / 1000 / RAMP)
      const step = PAN_SPEED * (fast ? FAST : 1) * ramp * dt
      map.panBy([(x / length) * step, (y / length) * step], { duration: 0 })
    }
    frame = requestAnimationFrame(tick)
  }

  return {
    start(source, dx, dy) {
      if (held.has(source)) return
      held.set(source, [dx, dy])
      if (!frame) {
        map.stop()
        last = started = performance.now()
        frame = requestAnimationFrame(tick)
      }
    },
    stop(source) {
      held.delete(source)
    },
    stopAll() {
      held.clear()
    },
    setFast(value) {
      fast = value
    },
  }
}

const panners = new WeakMap<MapLibreMap, CameraPanner>()

export function getPanner(map: MapLibreMap): CameraPanner {
  let panner = panners.get(map)
  if (!panner) {
    panner = createPanner(map)
    panners.set(map, panner)
  }
  return panner
}

import type { Map as MapLibreMap } from 'maplibre-gl'

/** Degrees per second while a rotate key or button is held. */
const ROTATE_SPEED = 80
/** Degrees for a single tap on a rotate button. */
export const ROTATE_STEP = 30

export interface CameraRotator {
  /** Start rotating; `source` identifies the key or button so several can be held at once. */
  start(source: string, direction: -1 | 1): void
  stop(source: string): void
  stopAll(): void
}

/**
 * Continuous camera rotation driven by requestAnimationFrame. Rotation is
 * applied with setBearing each frame, so it is smooth regardless of the
 * operating system's key-repeat rate.
 */
function createRotator(map: MapLibreMap): CameraRotator {
  const held = new Map<string, number>()
  let frame = 0
  let last = 0

  const tick = (now: number) => {
    if (held.size === 0) {
      frame = 0
      return
    }
    const dt = Math.min((now - last) / 1000, 0.05)
    last = now
    let direction = 0
    for (const d of held.values()) direction += d
    if (direction !== 0) map.setBearing(map.getBearing() + Math.sign(direction) * ROTATE_SPEED * dt)
    frame = requestAnimationFrame(tick)
  }

  return {
    start(source, direction) {
      if (held.has(source)) return
      held.set(source, direction)
      if (!frame) {
        map.stop()
        last = performance.now()
        frame = requestAnimationFrame(tick)
      }
    },
    stop(source) {
      held.delete(source)
    },
    stopAll() {
      held.clear()
    },
  }
}

const rotators = new WeakMap<MapLibreMap, CameraRotator>()

export function getRotator(map: MapLibreMap): CameraRotator {
  let rotator = rotators.get(map)
  if (!rotator) {
    rotator = createRotator(map)
    rotators.set(map, rotator)
  }
  return rotator
}

export function rotateBy(map: MapLibreMap, degrees: number) {
  map.easeTo({ bearing: map.getBearing() + degrees, duration: 450 })
}

export function resetNorth(map: MapLibreMap) {
  map.easeTo({ bearing: 0, duration: 700 })
}

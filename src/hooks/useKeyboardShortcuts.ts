import { useEffect } from 'react'
import { REGION_VIEW } from '../data/places'
import { flyToView, togglePitch } from '../features/map/camera'
import { getPanner } from '../features/map/pan'
import { getRotator, resetNorth } from '../features/map/rotation'
import { useAppStore } from '../store/useAppStore'
import { SPEED_OPTIONS, useSimulationStore } from '../store/useSimulationStore'
import { useMapInstance } from './useMapInstance'

export interface Shortcut {
  keys: string[]
  description: string
}

/** Shown in the shortcuts panel; keep in sync with the handler below. */
export const SHORTCUTS: Shortcut[] = [
  { keys: ['W', 'A', 'S', 'D'], description: 'Move the map (hold; Shift for faster)' },
  { keys: ['Q', 'E'], description: 'Rotate left / right (hold)' },
  { keys: ['N'], description: 'Face north' },
  { keys: ['T'], description: 'Toggle 2D / 3D' },
  { keys: ['H'], description: 'Reset view to the region' },
  { keys: ['Space'], description: 'Play / pause simulation' },
  { keys: ['1', '2', '3', '4'], description: 'Simulation speed 1× / 5× / 20× / 60×' },
  { keys: ['-', '+'], description: 'Simulation slower / faster' },
  { keys: ['/'], description: 'Focus search' },
  { keys: ['?'], description: 'Show shortcuts' },
  { keys: ['Shift', '←→↑↓'], description: 'Rotate and tilt (map focused)' },
  { keys: ['Esc'], description: 'Stop following / editing roads / cancel a new road' },
  { keys: ['Enter'], description: 'Finish the road being drawn' },
  { keys: ['⌫'], description: 'Undo the last bend of a new road' },
  { keys: ['M'], description: 'Cinematic mode: mute / unmute the music' },
  { keys: ['N'], description: 'Cinematic mode: next track' },
]

const ROTATE_KEYS: Record<string, -1 | 1> = { q: -1, e: 1 }
/** Screen directions: W forward (up the screen), S back, A left, D right. */
const PAN_KEYS: Record<string, [number, number]> = { w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] }

/**
 * Sets the simulation speed for 1–4 (one of the speed buttons) or - and +
 * (the next slower or faster one). Returns whether the key was one of them.
 * Cinematic mode uses it too.
 */
export function speedKey(key: string) {
  const { controller, speed } = useSimulationStore.getState()
  if (!controller) return false
  let next: number | undefined
  if (/^[1-4]$/.test(key)) next = SPEED_OPTIONS[Number(key) - 1]
  else if (key === '-' || key === '_') next = [...SPEED_OPTIONS].reverse().find((s) => s < speed) ?? SPEED_OPTIONS[0]
  else if (key === '+' || key === '=') next = SPEED_OPTIONS.find((s) => s > speed) ?? SPEED_OPTIONS[SPEED_OPTIONS.length - 1]
  else return false
  controller.setSpeed(next)
  return true
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

/** Global keyboard shortcuts. Ignored while typing in a form field. */
export function useKeyboardShortcuts() {
  const map = useMapInstance()

  useEffect(() => {
    if (!map) return
    const rotator = getRotator(map)
    const panner = getPanner(map)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      const key = event.key.toLowerCase()
      panner.setFast(event.shiftKey)

      if (key in PAN_KEYS) {
        event.preventDefault()
        // Moving the map yourself takes the camera back from a followed vehicle.
        if (!event.repeat) useSimulationStore.getState().controller?.setFollow(null)
        panner.start(`key-${key}`, ...PAN_KEYS[key])
        return
      }

      if (key in ROTATE_KEYS) {
        event.preventDefault()
        rotator.start(`key-${key}`, ROTATE_KEYS[key])
        return
      }
      if (event.repeat) return
      if (speedKey(key)) {
        event.preventDefault()
        return
      }

      switch (key) {
        case 'n':
          resetNorth(map)
          break
        case 't':
          togglePitch(map)
          break
        case 'h':
          flyToView(map, REGION_VIEW)
          break
        case ' ': {
          // Buttons handle Space themselves; avoid toggling twice.
          if ((event.target as HTMLElement | null)?.tagName === 'BUTTON') return
          const controller = useSimulationStore.getState().controller
          if (!controller) return
          event.preventDefault()
          controller.setPlaying(!useSimulationStore.getState().playing)
          break
        }
        case '/':
          event.preventDefault()
          document.querySelector<HTMLInputElement>('.search input')?.focus()
          break
        case '?':
          useAppStore.getState().setShortcutsOpen(!useAppStore.getState().shortcutsOpen)
          break
        case 'escape':
          useAppStore.getState().setShortcutsOpen(false)
          useSimulationStore.getState().controller?.setFollow(null)
          useSimulationStore.getState().controller?.openStop(null)
          break
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      panner.setFast(event.shiftKey)
      if (key in ROTATE_KEYS) rotator.stop(`key-${key}`)
      if (key in PAN_KEYS) panner.stop(`key-${key}`)
    }
    const stopAll = () => {
      rotator.stopAll()
      panner.stopAll()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', stopAll)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', stopAll)
      stopAll()
    }
  }, [map])
}

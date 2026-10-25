import { useEffect, useState } from 'react'
import { useMapInstance } from '../../hooks/useMapInstance'
import { useAppStore } from '../../store/useAppStore'
import { flyTour, type Shot } from './cinematic'

/**
 * Runs the cinematic flight while cinematic mode is playing, and returns the
 * current shot for the captions. Any key, or moving the map yourself, ends it.
 */
export function useCinematic(): Shot | null {
  const map = useMapInstance()
  const playing = useAppStore((s) => s.cinematic === 'playing')
  const [shot, setShot] = useState<Shot | null>(null)

  useEffect(() => {
    if (!map || !playing) return
    const controller = new AbortController()
    const stop = () => useAppStore.setState({ cinematic: null })
    // Only the visitor's own moves carry the browser event; the flight's don't.
    const onMove = (event: { originalEvent?: Event }) => {
      if (event.originalEvent) stop()
    }
    const onKey = (event: KeyboardEvent) => {
      // Before the map's own shortcuts, so a key ends the flight instead of moving the map.
      event.stopPropagation()
      event.preventDefault()
      stop()
    }
    map.on('movestart', onMove)
    window.addEventListener('keydown', onKey, { capture: true })
    void flyTour(map, controller.signal, setShot)
    return () => {
      controller.abort()
      map.off('movestart', onMove)
      window.removeEventListener('keydown', onKey, { capture: true })
      setShot(null)
    }
  }, [map, playing])

  return shot
}

import { useAppStore } from '../store/useAppStore'

/** The MapLibre instance once its style has loaded, otherwise null. */
export function useMapInstance() {
  return useAppStore((s) => (s.mapStatus === 'ready' ? s.map : null))
}

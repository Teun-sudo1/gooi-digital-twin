import { useAppStore } from '../store/useAppStore'
import { useSimulationStore } from '../store/useSimulationStore'

/** The button in the top bar that opens cinematic mode. */
export function CinematicButton() {
  const ready = useSimulationStore((s) => s.status === 'ready')
  return (
    <button className="cinematic-button" disabled={!ready} onClick={() => useAppStore.setState({ cinematic: 'setup' })} title="Watch the region: follow a car or a bus, or fly over">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="3.5" width="9" height="9" rx="1.5" />
        <path d="m10.5 7 4-2.5v7l-4-2.5" />
      </svg>
      Cinematic
    </button>
  )
}

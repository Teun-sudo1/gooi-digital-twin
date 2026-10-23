import { useAppStore } from '../store/useAppStore'

export function StatusOverlay() {
  const status = useAppStore((s) => s.mapStatus)
  const error = useAppStore((s) => s.mapError)

  if (status === 'ready') return null

  return (
    <div className="status-overlay" role={status === 'error' ? 'alert' : 'status'}>
      {status === 'loading' ? (
        <>
          <div className="spinner" aria-hidden="true" />
          <p>Loading map of the Gooi region…</p>
        </>
      ) : (
        <>
          <p className="status-title">Map unavailable</p>
          <p>{error}</p>
          <button className="chip" onClick={() => window.location.reload()}>
            Retry
          </button>
        </>
      )}
    </div>
  )
}

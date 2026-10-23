/** States plainly where the data comes from and what is approximate. */
export function DataNotice() {
  return (
    <div className="data-notice panel">
      <strong>Real geography</strong> from OpenStreetMap. Building heights are approximate where OSM
      has no height data. No simulated traffic yet.
    </div>
  )
}

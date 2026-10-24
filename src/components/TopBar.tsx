import { PLACES } from '../data/places'
import { flyToView } from '../features/map/camera'
import { useMapInstance } from '../hooks/useMapInstance'
import { SearchBox } from './SearchBox'

export function TopBar() {
  const map = useMapInstance()

  return (
    <header className="topbar">
      <div className="panel brand">
        <div className="brand-mark" aria-hidden="true" />
        <div>
          <h1>Gooi Digital Twin</h1>
          <p>Gooi region · Noord-Holland</p>
        </div>
      </div>
      <SearchBox />
      <nav className="places" aria-label="Places">
        {PLACES.map((place) => (
          <button
            key={place.id}
            className="chip"
            disabled={!map}
            onClick={() => map && flyToView(map, place.view)}
          >
            {place.name}
          </button>
        ))}
      </nav>
    </header>
  )
}

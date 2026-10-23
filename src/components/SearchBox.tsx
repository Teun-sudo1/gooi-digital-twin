import type { GeoJSONSource } from 'maplibre-gl'
import { useEffect, useId, useRef, useState } from 'react'
import { SEARCH_SOURCE } from '../features/map/style'
import { useMapInstance } from '../hooks/useMapInstance'
import type { SearchResult } from '../types/geo'
import { searchLocations, TYPE_LABELS, zoomForType } from '../utils/pdok'

const DEBOUNCE_MS = 250

type Status = 'idle' | 'loading' | 'error'

export function SearchBox() {
  const map = useMapInstance()
  const listId = useId()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmed = query.trim()
  const searchable = trimmed.length >= 2

  useEffect(() => {
    if (!searchable) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setStatus('loading')
      searchLocations(trimmed, controller.signal)
        .then((hits) => {
          setResults(hits)
          setActive(0)
          setStatus('idle')
        })
        .catch((error: unknown) => {
          if ((error as Error).name !== 'AbortError') setStatus('error')
        })
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [trimmed, searchable])

  function select(result: SearchResult) {
    setQuery(result.label)
    setOpen(false)
    inputRef.current?.blur()
    if (!map) return
    map.getSource<GeoJSONSource>(SEARCH_SOURCE)?.setData({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: result.lngLat },
      properties: { label: result.label },
    })
    map.flyTo({
      center: result.lngLat,
      zoom: zoomForType(result.type),
      pitch: Math.max(map.getPitch(), 50),
      duration: 2200,
      essential: true,
    })
  }

  function clear() {
    setQuery('')
    setResults([])
    map?.getSource<GeoJSONSource>(SEARCH_SOURCE)?.setData({ type: 'FeatureCollection', features: [] })
    inputRef.current?.focus()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter' && results[active]) {
      select(results[active])
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  const showList = open && searchable

  return (
    <div className="search">
      <svg className="search-icon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.5 10.5 3 3" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        placeholder="Search address or place"
        aria-label="Search address or place"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        value={query}
        disabled={!map}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {query && (
        <button className="search-clear" onClick={clear} aria-label="Clear search">
          ×
        </button>
      )}
      {showList && (
        <ul className="search-results panel" id={listId} role="listbox">
          {status === 'loading' && results.length === 0 && <li className="search-note">Searching…</li>}
          {status === 'error' && <li className="search-note">Search is unavailable right now.</li>}
          {status === 'idle' && results.length === 0 && <li className="search-note">No results</li>}
          {results.map((result, i) => (
            <li
              key={result.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(result)}
              onMouseEnter={() => setActive(i)}
            >
              <span>{result.label}</span>
              <small>{TYPE_LABELS[result.type] ?? result.type}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

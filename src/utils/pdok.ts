import { REGION_CENTER } from '../data/places'
import type { LngLat, SearchResult } from '../types/geo'

/*
 * PDOK Locatieserver: the free Dutch government geocoder (Kadaster), built on
 * BAG addresses and BRT place names. No key is needed and CORS is open, so it
 * also works from a static site. Docs: https://api.pdok.nl/bzk/locatieserver/search/v3_1/ui/
 */
const ENDPOINT = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free'

interface PdokDoc {
  id: string
  weergavenaam: string
  type: string
  centroide_ll?: string
}

/** Parses the WKT point PDOK returns, e.g. "POINT(5.2399 52.3047)". */
export function parseWktPoint(wkt: string): LngLat | null {
  const match = /POINT\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/.exec(wkt)
  if (!match) return null
  return [Number(match[1]), Number(match[2])]
}

export async function searchLocations(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    rows: '8',
    fl: 'id,weergavenaam,type,centroide_ll',
    fq: 'type:(woonplaats OR weg OR adres OR postcode OR gemeente)',
    // lat/lon boosts results in the Gooi, so "Kerkstraat" finds a local one first.
    lat: String(REGION_CENTER[1]),
    lon: String(REGION_CENTER[0]),
  })
  const response = await fetch(`${ENDPOINT}?${params}`, { signal })
  if (!response.ok) throw new Error(`PDOK search failed (${response.status})`)
  const body = (await response.json()) as { response?: { docs?: PdokDoc[] } }

  return (body.response?.docs ?? []).flatMap((doc) => {
    const lngLat = doc.centroide_ll ? parseWktPoint(doc.centroide_ll) : null
    return lngLat ? [{ id: doc.id, label: doc.weergavenaam, type: doc.type, lngLat }] : []
  })
}

/** Sensible zoom level for each PDOK result type. */
export function zoomForType(type: string): number {
  switch (type) {
    case 'adres':
      return 18
    case 'postcode':
    case 'weg':
      return 16.5
    case 'woonplaats':
      return 14
    default:
      return 12.5
  }
}

export const TYPE_LABELS: Record<string, string> = {
  adres: 'Address',
  weg: 'Street',
  postcode: 'Postcode',
  woonplaats: 'Town',
  gemeente: 'Municipality',
}

#!/usr/bin/env node
/*
 * Builds public/data/gooi-demand.json: population and business establishments
 * per neighbourhood (buurt) from CBS "Kerncijfers wijken en buurten 2024",
 * served by PDOK. The simulation uses them to weight where trips start (where
 * people live) and where they go (where businesses are).
 *
 *   node scripts/fetch-demand.mjs            # use the cached download if present
 *   node scripts/fetch-demand.mjs --refresh  # download fresh data
 *
 * Data © CBS / Kadaster, CC BY 4.0.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BBOX, CACHE, KX, KY, LAT0, LNG0, OUT, project, simplify } from './osm-common.mjs'

const YEAR = 2024
const ENDPOINT = `https://api.pdok.nl/cbs/wijken-en-buurten-${YEAR}/ogc/v1/collections/buurten/items`

async function download(refresh) {
  const file = resolve(CACHE, `cbs-buurten-${YEAR}.json`)
  if (!refresh) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      // not cached yet
    }
  }
  const features = []
  let url = `${ENDPOINT}?f=json&limit=1000&bbox=${[BBOX[1], BBOX[0], BBOX[3], BBOX[2]].join(',')}`
  while (url) {
    console.log(`buurten: ${url.slice(0, 90)}…`)
    const response = await fetch(url, { headers: { 'User-Agent': 'gooi-digital-twin (+https://github.com/Teun-sudo1/gooi-digital-twin)' } })
    if (!response.ok) throw new Error(`PDOK: HTTP ${response.status}`)
    const page = await response.json()
    features.push(...page.features)
    url = page.links.find((l) => l.rel === 'next')?.href ?? null
  }
  await mkdir(CACHE, { recursive: true })
  await writeFile(file, JSON.stringify(features))
  return features
}

/** Integer metres, delta-encoded. */
function encodeRing(ring) {
  const out = []
  let px = 0
  let py = 0
  for (const [x, y] of ring) {
    const ix = Math.round(x)
    const iy = Math.round(y)
    out.push(ix - px, iy - py)
    px = ix
    py = iy
  }
  return out
}

function area(ring) {
  let a = 0
  for (let i = 1; i < ring.length; i++) a += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1]
  return Math.abs(a) / 2
}

async function main() {
  const features = await download(process.argv.includes('--refresh'))
  const areas = []
  for (const f of features) {
    const p = f.properties
    if (p.water === 'JA') continue
    const population = Math.max(0, p.aantal_inwoners ?? 0)
    const businesses = Math.max(0, p.aantal_bedrijfsvestigingen ?? 0)
    if (!population && !businesses) continue
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    // Outer rings only (holes in neighbourhoods are rare and small).
    const rings = polygons
      .map((poly) => simplify(poly[0].map(([lng, lat]) => project(lng, lat)), 5))
      .filter((r) => r.length >= 4 && area(r) > 2000)
    if (!rings.length) continue
    areas.push({ code: p.buurtcode, name: p.buurtnaam, municipality: p.gemeentenaam, population, businesses, rings: rings.map(encodeRing) })
  }
  const file = {
    meta: {
      description: 'Population and business establishments per neighbourhood, for the Gooi Digital Twin trip demand',
      source: `CBS Kerncijfers wijken en buurten ${YEAR}, via PDOK (api.pdok.nl)`,
      license: 'CC BY 4.0',
      year: YEAR,
      generated: new Date().toISOString(),
      projection: { lng0: LNG0, lat0: LAT0, kx: KX, ky: KY, unit: 1 },
    },
    areas,
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(resolve(OUT, 'gooi-demand.json'), JSON.stringify(file))
  const total = (k) => areas.reduce((s, a) => s + a[k], 0)
  console.log(`demand: ${areas.length} neighbourhoods, ${total('population')} inhabitants, ${total('businesses')} business establishments`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

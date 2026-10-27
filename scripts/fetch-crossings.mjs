#!/usr/bin/env node
/*
 * Builds public/data/gooi-crossings.json: the zebra crossings mapped in
 * OpenStreetMap (highway=crossing tagged as a zebra), as points in the app's
 * local metres. The app snaps them to the street they cross and paints the
 * stripes across its carriageway.
 *
 *   node scripts/fetch-crossings.mjs            # use the cached Overpass response if present
 *   node scripts/fetch-crossings.mjs --refresh  # download fresh data
 *
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BBOX, OUT, overpass, project } from './osm-common.mjs'

// Zebras are tagged in several ways: crossing=zebra (old), crossing_ref=zebra, or crossing:markings=zebra*.
const CROSSINGS_QUERY = `[out:json][timeout:120];
(
  node["highway"="crossing"]["crossing"="zebra"](${BBOX.join(',')});
  node["highway"="crossing"]["crossing_ref"="zebra"](${BBOX.join(',')});
  node["highway"="crossing"]["crossing:markings"~"^zebra"](${BBOX.join(',')});
);
out;`

async function main() {
  const raw = await overpass('crossings', CROSSINGS_QUERY, process.argv.includes('--refresh'))
  const points = []
  for (const e of raw.elements) {
    if (e.type !== 'node') continue
    const [x, y] = project(e.lon, e.lat)
    points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10])
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(
    resolve(OUT, 'gooi-crossings.json'),
    JSON.stringify({ attribution: '© OpenStreetMap contributors, ODbL 1.0', points }),
  )
  console.log(`crossings: ${points.length} mapped zebra crossings`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

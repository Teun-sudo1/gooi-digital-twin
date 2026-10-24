#!/usr/bin/env node
/*
 * Builds public/data/gooi-signals.json: the traffic signals mapped in
 * OpenStreetMap (highway=traffic_signals), as points in the app's local
 * metres. The app snaps them to junctions of the street network and groups
 * the corners of one crossing into one controller at runtime, so this file
 * doesn't depend on the network's node numbering. Signal timings are not in
 * OSM; the app's are assumed.
 *
 *   node scripts/fetch-signals.mjs            # use the cached Overpass response if present
 *   node scripts/fetch-signals.mjs --refresh  # download fresh data
 *
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BBOX, OUT, overpass, project } from './osm-common.mjs'

const SIGNALS_QUERY = `[out:json][timeout:120];
node["highway"="traffic_signals"](${BBOX.join(',')});
out;`

async function main() {
  const raw = await overpass('signals', SIGNALS_QUERY, process.argv.includes('--refresh'))
  const points = []
  for (const e of raw.elements) {
    if (e.type !== 'node') continue
    const [x, y] = project(e.lon, e.lat)
    points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10])
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(
    resolve(OUT, 'gooi-signals.json'),
    JSON.stringify({ attribution: '© OpenStreetMap contributors, ODbL 1.0', points }),
  )
  console.log(`signals: ${points.length} mapped traffic signals`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

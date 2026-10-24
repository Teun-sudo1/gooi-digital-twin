#!/usr/bin/env node
/*
 * Builds public/data/gooi-lanes.json: lanes per direction for the streets
 * where OpenStreetMap records them (lanes, lanes:forward, lanes:backward),
 * keyed by OSM way id. Streets without lane tags are left out; the app
 * assumes their lane count from the street type (see lanes.ts).
 *
 *   node scripts/fetch-lanes.mjs            # use the cached Overpass response if present
 *   node scripts/fetch-lanes.mjs --refresh  # download fresh data
 *
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { NETWORK_QUERY, OUT, overpass } from './osm-common.mjs'

const MAX_LANES = 4
const count = (value) => {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_LANES, n) : 0
}

async function main() {
  const raw = await overpass('network', NETWORK_QUERY, process.argv.includes('--refresh'))
  const ways = {}
  for (const e of raw.elements) {
    const tags = e.tags ?? {}
    if (e.type !== 'way' || !tags.lanes) continue
    const total = count(tags.lanes)
    if (!total) continue
    const oneway = tags.oneway
    const roundabout = tags.junction === 'roundabout' || tags.junction === 'circular'
    let forward
    let backward
    if (oneway === '-1' || oneway === 'reverse') {
      forward = 0
      backward = count(tags['lanes:backward']) || total
    } else if (oneway === 'yes' || oneway === 'true' || oneway === '1' || (oneway !== 'no' && (roundabout || tags.highway === 'motorway'))) {
      forward = count(tags['lanes:forward']) || total
      backward = 0
    } else {
      // Two-way: the tagged split, or half each (a middle lane on an odd count is a turn lane).
      forward = count(tags['lanes:forward']) || Math.max(1, Math.floor(total / 2))
      backward = count(tags['lanes:backward']) || Math.max(1, Math.floor(total / 2))
    }
    ways[e.id] = [forward, backward]
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(resolve(OUT, 'gooi-lanes.json'), JSON.stringify({ attribution: '© OpenStreetMap contributors, ODbL 1.0', ways }))
  const multi = Object.values(ways).filter(([f, b]) => f > 1 || b > 1).length
  console.log(`lanes: ${Object.keys(ways).length} ways with lane tags, ${multi} with more than one lane in a direction`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

#!/usr/bin/env node
/*
 * Checks that the project hangs together: the data files are complete and
 * agree with each other, every data file and script is used and documented,
 * the README's links and features match the app, the tour points at parts
 * of the screen that exist, and no secrets or oversized files are tracked.
 *
 *   node scripts/check-coherence.mjs
 *
 * Exits with 1 when a check fails. Part of `npm run check`.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from './osm-common.mjs'

const failures = []
const warnings = []
let passed = 0
const check = (ok, message) => (ok ? passed++ : failures.push(message))
const warn = (ok, message) => ok || warnings.push(message)

const text = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const json = (path) => JSON.parse(text(path))
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
const sources = tracked.filter((f) => f.startsWith('src/') && /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
const sourceText = sources.map(text).join('\n')
const readme = text('README.md')
const pkg = json('package.json')

// ---------------------------------------------------------------------------
// Data files: present, complete and consistent

const network = json('public/data/gooi-network.json')
const nodes = network.nodes.length / 2
const segments = network.segments.from.length
check(nodes > 10_000 && segments > 10_000, `network: only ${nodes} nodes and ${segments} segments`)
check(['from', 'to', 'cls', 'name', 'speed', 'flags', 'way', 'geom'].every((k) => network.segments[k]?.length === segments), 'network: segment columns differ in length')
check(network.segments.to.every((n) => n >= 0 && n < nodes) && network.segments.from.every((n) => n >= 0 && n < nodes), 'network: a segment refers to a node that does not exist')
check(Boolean(network.meta?.license && network.meta?.source), 'network: licence or source missing from meta')

const transit = json('public/data/gooi-transit.json')
const buses = transit.lines.filter((l) => l.mode === 'bus')
const trains = transit.lines.filter((l) => l.mode === 'train')
check(buses.length > 20 && trains.length > 0, `transit: ${buses.length} bus and ${trains.length} train lines`)
// Running fetch-osm.mjs alone rewrites this file without trips (run fetch-timetables.mjs after it).
const withTrips = transit.lines.filter((l) => l.trips?.length).length
check(withTrips > transit.lines.length * 0.5, `transit: only ${withTrips} of ${transit.lines.length} lines have timetabled trips (run scripts/fetch-timetables.mjs)`)
check(transit.lines.every((l) => l.stops?.length === l.stopNames?.length), 'transit: stops and stop names differ in length')

const scenery = json('public/data/gooi-scenery.json')
check(scenery.trees.length / 4 > 50_000, `scenery: only ${scenery.trees.length / 4} trees`)
check(scenery.lamps.length / 4 > 10_000 && scenery.forests.length > 1000, 'scenery: lamps or forests missing')
check(/CC0/.test(scenery.meta?.license ?? '') && /ODbL/.test(scenery.meta?.license ?? ''), 'scenery: licences of OSM and BGT trees not both recorded')

const demand = json('public/data/gooi-demand.json')
check(demand.areas?.length > 50, `demand: only ${demand.areas?.length} neighbourhoods`)

const signals = json('public/data/gooi-signals.json')
check(signals.points.length > 100 && Boolean(signals.attribution), `signals: ${signals.points.length} points, attribution ${signals.attribution ? 'present' : 'missing'}`)
const [west, south, east, north] = network.meta.bbox
const { lng0, lat0, kx, ky } = network.meta.projection
const inBox = ([x, y]) => {
  const lng = lng0 + x / kx
  const lat = lat0 + y / ky
  return lng > west - 0.05 && lng < east + 0.05 && lat > south - 0.05 && lat < north + 0.05
}
check(signals.points.every(inBox), 'signals: a traffic signal lies outside the region')

const lanes = json('public/data/gooi-lanes.json')
const laneWays = Object.keys(lanes.ways)
const networkWays = new Set(network.segments.way.map(String))
const matched = laneWays.filter((id) => networkWays.has(id)).length
check(laneWays.length > 1000 && Boolean(lanes.attribution), `lanes: ${laneWays.length} ways`)
check(matched / laneWays.length > 0.95, `lanes: only ${matched} of ${laneWays.length} lane ways are in the network (re-run scripts/fetch-lanes.mjs after fetch-osm.mjs)`)
check(Object.values(lanes.ways).every(([f, b]) => f >= 0 && f <= 4 && b >= 0 && b <= 4 && f + b > 0), 'lanes: a lane count is out of range')

const roadGeometry = json('public/data/gooi-road-geometry.json')
// Rows are by segment index, so they must come from this very network (re-run fetch-road-geometry.mjs after fetch-osm.mjs).
check(roadGeometry.meta?.network === network.meta.generated, 'road geometry: measured on another version of the network (run scripts/fetch-road-geometry.mjs)')
check(roadGeometry.rows.length > segments * 0.2 && /CC0/.test(roadGeometry.meta?.license ?? ''), `road geometry: ${roadGeometry.rows.length} rows, licence ${roadGeometry.meta?.license}`)
check(roadGeometry.rows.every(([s, ...edges]) => Number.isInteger(s) && s < segments && edges.every((v) => v === null || Math.abs(v) < 40)), 'road geometry: a row is out of range')

// ---------------------------------------------------------------------------
// Every data file is used by the app and documented; every script is run and documented

const dataFiles = readdirSync(resolve(ROOT, 'public/data')).filter((f) => f.endsWith('.json'))
for (const file of dataFiles) {
  check(sourceText.includes(`data/${file}`), `${file} is not loaded anywhere in src/`)
  check(readme.includes(file), `${file} is not mentioned in the README`)
}
const fetchScripts = readdirSync(resolve(ROOT, 'scripts')).filter((f) => /^fetch-.*\.mjs$/.test(f))
for (const script of fetchScripts) {
  check(pkg.scripts.data.includes(`scripts/${script}`), `${script} is not part of \`npm run data\``)
  check(readme.includes(script), `${script} is not mentioned in the README`)
}
for (const [name, command] of Object.entries(pkg.scripts)) {
  for (const path of command.match(/(scripts|e2e|checks)\/[\w./-]+\.(mjs|ts)/g) ?? []) {
    check(tracked.includes(path) || statSync(resolve(ROOT, path), { throwIfNoEntry: false }), `npm script "${name}" runs ${path}, which does not exist`)
  }
}

// ---------------------------------------------------------------------------
// The README matches the repository and the app

for (const [, path] of readme.matchAll(/\]\(((?:docs|scripts|src|public)\/[^)#\s]+)\)/g)) {
  check(statSync(resolve(ROOT, path), { throwIfNoEntry: false }) !== undefined, `README links to ${path}, which does not exist`)
}
for (const [, path] of readme.matchAll(/`((?:scripts|e2e|checks)\/[\w./-]+\.(?:mjs|ts))`/g)) {
  check(statSync(resolve(ROOT, path), { throwIfNoEntry: false }) !== undefined, `README mentions ${path}, which does not exist`)
}
const docs = readdirSync(resolve(ROOT, 'docs'))
for (const image of docs) warn(readme.includes(`docs/${image}`), `docs/${image} is not used in the README`)

// Switches that change the simulation, and the editing tools, are explained in the README.
for (const label of ['Traffic lights', 'Multiple lanes', 'Trees', 'Street lighting', 'Congestion']) {
  check(readme.toLowerCase().includes(label.toLowerCase()), `the layer switch "${label}" is not explained in the README`)
}
const layers = text('src/features/map/layers.ts')
for (const label of ['Traffic lights', 'Multiple lanes']) check(layers.includes(`label: '${label}'`), `layer switch "${label}" is documented but missing from layers.ts`)
const tools = [...text('src/features/scenarios/tools.ts').matchAll(/label: '([^']+)'/g)].map((m) => m[1])
for (const tool of tools) check(readme.toLowerCase().includes(tool.toLowerCase()), `the road tool "${tool}" is not explained in the README`)
// Every keyboard shortcut of the app is in the README's table.
const KEY_NAMES = { '⌫': 'Backspace', '←→↑↓': 'arrow' }
for (const [, keys] of text('src/hooks/useKeyboardShortcuts.ts').matchAll(/keys: \[([^\]]+)\]/g)) {
  for (const [, key] of keys.matchAll(/'([^']+)'/g)) {
    const name = KEY_NAMES[key] ?? key
    check(name === 'arrow' ? /arrow keys|`←`/i.test(readme) : readme.includes(`\`${name}\``), `the shortcut key ${key} is not in the README`)
  }
}
check(/tour/i.test(readme), 'the README does not mention the guided tour')

// ---------------------------------------------------------------------------
// The tour points at things that exist

const tour = text('src/components/Tour.tsx')
const classNames = new Set([...sourceText.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)].flatMap((m) => (m[1] ?? m[2]).split(/\s+/)))
for (const [, selector] of tour.matchAll(/'(\.[a-z-]+)[^']*'/g)) {
  check(classNames.has(selector.slice(1)), `the tour points at ${selector}, which no component renders`)
}

// ---------------------------------------------------------------------------
// Nothing secret or oversized is tracked

const SECRET = /(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bap]-[A-Za-z0-9-]{10,}|(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"\s]{12,}['"])/i
for (const file of tracked) {
  check(!/(^|\/)\.env($|\.)/.test(file) || file.endsWith('.env.example'), `${file} looks like an environment file and must not be committed`)
  const size = statSync(resolve(ROOT, file), { throwIfNoEntry: false })?.size ?? 0
  check(size < 15_000_000, `${file} is ${(size / 1e6).toFixed(1)} MB; keep tracked files small`)
  if (/\.(png|jpe?g|zip|ico)$/.test(file) || file === 'package-lock.json' || size > 3_000_000) continue
  const match = text(file).match(SECRET)
  check(!match, `${file} may contain a secret: ${match?.[0].slice(0, 24)}…`)
}

// ---------------------------------------------------------------------------

for (const message of warnings) console.warn(`  warning: ${message}`)
for (const message of failures) console.error(`  FAIL: ${message}`)
console.log(`coherence: ${passed} checks passed, ${failures.length} failed, ${warnings.length} warnings`)
process.exit(failures.length ? 1 : 0)

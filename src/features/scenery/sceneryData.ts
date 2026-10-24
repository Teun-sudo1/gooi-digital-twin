import type { Projection } from '../../types/simulation'

/*
 * Trees and street lights (public/data/gooi-scenery.json, built by
 * scripts/fetch-scenery.mjs). Mapped trees and tree rows are at their OSM
 * positions. Forests come as outlines that are filled here with trees on a
 * jittered grid, generated per map cell on demand, so the hundreds of
 * thousands of forest trees in the Gooi are never all in memory. Street
 * lamps are mapped in OSM or placed by rule along lit streets.
 */

export interface SceneryFile {
  meta: { projection: Projection; note: string; osmTimestamp: string | null }
  trees: number[]
  forests: { leaf: number; rings: number[][] }[]
  lamps: number[]
}

export const Leaf = { Unknown: 0, Broad: 1, Needle: 2, Mixed: 3 } as const

/** A tree or lamp in local metres. */
export interface SceneryItem {
  x: number
  y: number
  /** Trees: needle-leaved (conifer) or not. */
  conifer: boolean
  /** Trees: height in metres. Lamps: arm bearing in degrees. */
  size: number
  /** 0..1, stable per item, for colour and rotation variety. */
  seed: number
}

/** Cell size of the spatial index (m). */
export const CELL = 250
const FOREST_SPACING = 7.5
const JITTER = 3

/** Stable pseudo-random number in [0, 1) for integer inputs. */
export function hash(a: number, b: number, c = 0) {
  let h = Math.imul(a | 0, 374_761_393) ^ Math.imul(b | 0, 668_265_263) ^ Math.imul(c | 0, 2_147_483_647)
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177)
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296
}

function decodeRing(encoded: number[]): Float64Array {
  const out = new Float64Array(encoded.length)
  let x = 0
  let y = 0
  for (let i = 0; i < encoded.length; i += 2) {
    x += encoded[i]
    y += encoded[i + 1]
    out[i] = x
    out[i + 1] = y
  }
  return out
}

function inside(ring: Float64Array, x: number, y: number) {
  let hit = false
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i]
    const yi = ring[2 * i + 1]
    const xj = ring[2 * j]
    const yj = ring[2 * j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

interface Forest {
  leaf: number
  rings: Float64Array[]
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const key = (cx: number, cy: number) => cx * 100_000 + cy

function treeHeight(conifer: boolean, seed: number) {
  return conifer ? 13 + seed * 9 : 9 + seed * 9
}

export class Scenery {
  readonly projection: Projection
  readonly note: string
  private mappedTrees = new Map<number, SceneryItem[]>()
  private lamps = new Map<number, SceneryItem[]>()
  private forests = new Map<number, Forest[]>()
  private generated = new Map<number, SceneryItem[]>()
  readonly lampCount: number
  /** All lamps in lng/lat, for the light pools drawn by MapLibre. */
  readonly lampPositions: [number, number][] = []

  constructor(file: SceneryFile) {
    this.projection = file.meta.projection
    this.note = file.meta.note
    const add = (index: Map<number, SceneryItem[]>, item: SceneryItem) => {
      const k = key(Math.floor(item.x / CELL), Math.floor(item.y / CELL))
      const list = index.get(k)
      if (list) list.push(item)
      else index.set(k, [item])
    }

    let x = 0
    let y = 0
    for (let i = 0; i < file.trees.length; i += 4) {
      x += file.trees[i]
      y += file.trees[i + 1]
      const leaf = file.trees[i + 2]
      const seed = hash(x, y)
      const conifer = leaf === Leaf.Needle || ((leaf === Leaf.Unknown || leaf === Leaf.Mixed) && seed < 0.25)
      add(this.mappedTrees, { x, y, conifer, size: file.trees[i + 3] || treeHeight(conifer, hash(y, x, 7)), seed })
    }

    x = 0
    y = 0
    const p = this.projection
    for (let i = 0; i < file.lamps.length; i += 4) {
      x += file.lamps[i]
      y += file.lamps[i + 1]
      add(this.lamps, { x, y, conifer: false, size: file.lamps[i + 2], seed: hash(x, y) })
      this.lampPositions.push([p.lng0 + x / p.kx, p.lat0 + y / p.ky])
    }
    this.lampCount = file.lamps.length / 4

    for (const f of file.forests) {
      const rings = f.rings.map(decodeRing)
      const outer = rings[0]
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i < outer.length; i += 2) {
        minX = Math.min(minX, outer[i])
        maxX = Math.max(maxX, outer[i])
        minY = Math.min(minY, outer[i + 1])
        maxY = Math.max(maxY, outer[i + 1])
      }
      const forest = { leaf: f.leaf, rings, minX, minY, maxX, maxY }
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
        for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
          const k = key(cx, cy)
          const list = this.forests.get(k)
          if (list) list.push(forest)
          else this.forests.set(k, [forest])
        }
      }
    }
  }

  lampsIn(cx: number, cy: number): SceneryItem[] {
    return this.lamps.get(key(cx, cy)) ?? []
  }

  /** Whether a cell's trees still have to be generated (forest cells only). */
  isReady(cx: number, cy: number) {
    return !this.forests.has(key(cx, cy)) || this.generated.has(key(cx, cy))
  }

  /** Mapped trees plus forest trees in a cell (forest trees are generated once and cached). */
  treesIn(cx: number, cy: number): SceneryItem[] {
    const k = key(cx, cy)
    const mapped = this.mappedTrees.get(k) ?? []
    const forests = this.forests.get(k)
    if (!forests) return mapped
    let trees = this.generated.get(k)
    if (!trees) {
      trees = [...mapped, ...this.scatter(cx, cy, forests)]
      this.generated.set(k, trees)
      // Bounded cache: forget the oldest cells.
      if (this.generated.size > 4000) this.generated.delete(this.generated.keys().next().value!)
    }
    return trees
  }

  private scatter(cx: number, cy: number, forests: Forest[]): SceneryItem[] {
    const out: SceneryItem[] = []
    // Grid points owned by this cell, so neighbouring cells never repeat a tree.
    const gx0 = Math.ceil((cx * CELL) / FOREST_SPACING)
    const gx1 = Math.ceil(((cx + 1) * CELL) / FOREST_SPACING)
    const gy0 = Math.ceil((cy * CELL) / FOREST_SPACING)
    const gy1 = Math.ceil(((cy + 1) * CELL) / FOREST_SPACING)
    for (let gx = gx0; gx < gx1; gx++) {
      for (let gy = gy0; gy < gy1; gy++) {
        const x = gx * FOREST_SPACING + (hash(gx, gy, 1) - 0.5) * 2 * JITTER
        const y = gy * FOREST_SPACING + (hash(gx, gy, 2) - 0.5) * 2 * JITTER
        // Natural gaps.
        if (hash(gx, gy, 3) < 0.12) continue
        const forest = forests.find(
          (f) => x >= f.minX && x <= f.maxX && y >= f.minY && y <= f.maxY && inside(f.rings[0], x, y) && !f.rings.slice(1).some((r) => inside(r, x, y)),
        )
        if (!forest) continue
        const seed = hash(gx, gy, 4)
        const conifer = forest.leaf === Leaf.Needle || (forest.leaf !== Leaf.Broad && hash(gx, gy, 5) < 0.5)
        out.push({ x, y, conifer, size: treeHeight(conifer, hash(gx, gy, 6)), seed })
      }
    }
    return out
  }
}

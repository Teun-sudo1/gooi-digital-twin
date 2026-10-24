import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CELL, Scenery, type SceneryFile } from './sceneryData'

const file = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../public/data/gooi-scenery.json', import.meta.url)), 'utf8'),
) as SceneryFile

describe('scenery', () => {
  const scenery = new Scenery(file)
  const p = file.meta.projection
  const cellAt = (lng: number, lat: number) => [Math.floor(((lng - p.lng0) * p.kx) / CELL), Math.floor(((lat - p.lat0) * p.ky) / CELL)]

  it('has street lights, mostly placed by rule', () => {
    expect(scenery.lampCount).toBeGreaterThan(20_000)
    const sources = file.lamps.filter((_, i) => i % 4 === 3)
    expect(sources.filter((s) => s === 1).length).toBeGreaterThan(50)
    // Huizen centre is lit; the Bussummerheide heath is not.
    const [hx, hy] = cellAt(5.2415, 52.2985)
    expect(scenery.lampsIn(hx, hy).length).toBeGreaterThan(5)
    const [bx, by] = cellAt(5.19, 52.248)
    expect(scenery.lampsIn(bx, by).length).toBe(0)
  })

  it('fills forests with trees, the same way every time, without repeats across cells', () => {
    // Woods west of the Bussummerheide.
    const [cx, cy] = cellAt(5.172, 52.2515)
    const trees = scenery.treesIn(cx, cy)
    expect(trees.length).toBeGreaterThan(100)
    expect(new Scenery(file).treesIn(cx, cy)).toEqual(trees)
    const next = scenery.treesIn(cx + 1, cy)
    const seen = new Set(trees.map((t) => `${t.x.toFixed(2)},${t.y.toFixed(2)}`))
    expect(next.some((t) => seen.has(`${t.x.toFixed(2)},${t.y.toFixed(2)}`))).toBe(false)
    for (const t of trees) {
      expect(t.size).toBeGreaterThan(5)
      expect(t.size).toBeLessThan(50)
    }
    expect(trees.some((t) => t.conifer)).toBe(true)
    expect(trees.some((t) => !t.conifer)).toBe(true)
  })

  it('leaves open heath empty', () => {
    const [cx, cy] = cellAt(5.19, 52.248)
    expect(scenery.treesIn(cx, cy).length).toBeLessThan(40)
  })
})

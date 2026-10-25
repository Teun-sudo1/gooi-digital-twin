import { describe, expect, it } from 'vitest'
import { lineLength, smoothLine } from './curves'

describe('curved roads', () => {
  const corner: [number, number][] = [
    [5.25, 52.28],
    [5.252, 52.28],
    [5.252, 52.2812],
  ]

  it('pass through every clicked point, ending where they end', () => {
    const curve = smoothLine(corner)
    expect(curve[0]).toEqual(corner[0])
    const last = curve[curve.length - 1]
    expect(last[0]).toBeCloseTo(corner[2][0], 9)
    expect(last[1]).toBeCloseTo(corner[2][1], 9)
    expect(curve.some((p) => Math.abs(p[0] - corner[1][0]) < 1e-9 && Math.abs(p[1] - corner[1][1]) < 1e-9)).toBe(true)
  })

  it('have points every few metres, and round the corner without overshooting it', () => {
    const curve = smoothLine(corner)
    const straight = lineLength(corner)
    expect(curve.length).toBeGreaterThan(straight / 6)
    // A smooth bend is a little longer than the two straight pieces would cut it, never wildly.
    expect(lineLength(curve)).toBeGreaterThan(straight * 0.95)
    expect(lineLength(curve)).toBeLessThan(straight * 1.1)
    // Through a right angle the curve swings a little past the corner before turning,
    // as a road bend would: well under a tenth of the legs (136 m and 133 m).
    for (const [lng, lat] of curve) {
      expect((lng - 5.252) * 68_100).toBeLessThan(13)
      expect((52.28 - lat) * 110_574).toBeLessThan(13)
    }
  })

  it('leave two points as a straight line', () => {
    expect(smoothLine(corner.slice(0, 2))).toEqual(corner.slice(0, 2))
  })
})

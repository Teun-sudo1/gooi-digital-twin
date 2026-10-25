/*
 * Smooth curves for drawn roads: a centripetal Catmull-Rom spline through the
 * clicked points (start junction, bends, end junction). It passes through
 * every point and doesn't overshoot or loop on sharp bends.
 */

type LngLat = [number, number]

/** Points of the curve about every `spacing` metres, including both ends. */
export function smoothLine(points: LngLat[], spacing = 4): LngLat[] {
  if (points.length < 3) return points
  // Work in local metres around the first point.
  const [lng0, lat0] = points[0]
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180)
  const ky = 110_574
  const xy = points.map(([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky] as [number, number])
  // Mirror the ends so the curve starts and ends along its first and last pieces.
  const mirror = (a: [number, number], b: [number, number]): [number, number] => [2 * a[0] - b[0], 2 * a[1] - b[1]]
  const p = [mirror(xy[0], xy[1]), ...xy, mirror(xy[xy.length - 1], xy[xy.length - 2])]

  const out: [number, number][] = [xy[0]]
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]]
    const knot = (a: [number, number], b: [number, number]) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])))
    const t1 = knot(p0, p1)
    const t2 = t1 + knot(p1, p2)
    const t3 = t2 + knot(p2, p3)
    const steps = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / spacing))
    for (let k = 1; k <= steps; k++) {
      const t = t1 + ((t2 - t1) * k) / steps
      const lerp = (a: [number, number], b: [number, number], ta: number, tb: number): [number, number] => {
        const w = (t - ta) / (tb - ta)
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]
      }
      const a1 = lerp(p0, p1, 0, t1)
      const a2 = lerp(p1, p2, t1, t2)
      const a3 = lerp(p2, p3, t2, t3)
      const b1 = lerp(a1, a2, 0, t2)
      const b2 = lerp(a2, a3, t1, t3)
      out.push(lerp(b1, b2, t1, t2))
    }
  }
  return out.map(([x, y]) => [lng0 + x / kx, lat0 + y / ky])
}

/** Length of a line in metres. */
export function lineLength(points: LngLat[]) {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const kx = 111_320 * Math.cos((((points[i][1] + points[i - 1][1]) / 2) * Math.PI) / 180)
    total += Math.hypot((points[i][0] - points[i - 1][0]) * kx, (points[i][1] - points[i - 1][1]) * 110_574)
  }
  return total
}

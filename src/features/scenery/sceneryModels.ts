/*
 * Low-poly meshes for trees and street lamps, in the same vertex layout as the
 * agent models: position (3), normal (3), material (1). Trees are built at
 * height 1 and scaled per instance; lamps are in metres.
 */

export const SceneryMaterial = { Foliage: 0, Trunk: 1, Metal: 2, LampHead: 3 } as const
export const SCENERY_VERTEX_FLOATS = 7

/** Mesh indices in the scenery layer. */
export const SceneryMesh = { RoundTree: 0, OvalTree: 1, Spruce: 2, Pine: 3, Lamp: 4 } as const

const { Foliage, Trunk, Metal, LampHead } = SceneryMaterial
type Ring = [radius: number, z: number]

class MeshBuilder {
  out: number[] = []

  triangle(a: number[], b: number[], c: number[], material: number) {
    const ux = b[0] - a[0]
    const uy = b[1] - a[1]
    const uz = b[2] - a[2]
    const vx = c[0] - a[0]
    const vy = c[1] - a[1]
    const vz = c[2] - a[2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    ny /= len
    nz /= len
    for (const v of [a, b, c]) this.out.push(v[0], v[1], v[2], nx, ny, nz, material)
  }

  /** A body of revolution through rings of (radius, height), with `sides` faces around. */
  lathe(rings: Ring[], sides: number, material: number, twist = 0) {
    const point = (r: number, z: number, i: number) => {
      const a = (i / sides) * Math.PI * 2 + twist
      return [Math.cos(a) * r, Math.sin(a) * r, z]
    }
    for (let k = 1; k < rings.length; k++) {
      const [r0, z0] = rings[k - 1]
      const [r1, z1] = rings[k]
      for (let i = 0; i < sides; i++) {
        const a = point(r0, z0, i)
        const b = point(r0, z0, i + 1)
        const c = point(r1, z1, i + 1)
        const d = point(r1, z1, i)
        if (r0 > 0) this.triangle(a, b, c, material)
        if (r1 > 0) this.triangle(a, c, d, material)
      }
    }
    // Flat underside so crowns are closed when seen from below.
    const [rb, zb] = rings[0]
    if (rb > 0) for (let i = 0; i < sides; i++) this.triangle([0, 0, zb], point(rb, zb, i + 1), point(rb, zb, i), material)
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, material: number) {
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
      this.triangle(a, b, c, material)
      this.triangle(a, c, d, material)
    }
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])
    quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0])
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0])
    quad([x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y0, z0])
    quad([x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [x1, y0, z0])
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0])
  }

  build() {
    return new Float32Array(this.out)
  }
}

function roundTree() {
  const m = new MeshBuilder()
  m.lathe([[0.04, 0], [0.03, 0.42]], 5, Trunk)
  m.lathe([[0.16, 0.3], [0.34, 0.42], [0.38, 0.6], [0.3, 0.8], [0.14, 0.95], [0, 1]], 7, Foliage)
  return m.build()
}

function ovalTree() {
  const m = new MeshBuilder()
  m.lathe([[0.035, 0], [0.025, 0.35]], 5, Trunk)
  m.lathe([[0.1, 0.25], [0.24, 0.38], [0.27, 0.6], [0.22, 0.82], [0.1, 0.96], [0, 1]], 6, Foliage, 0.4)
  return m.build()
}

/** Spruce or fir: stacked cones. */
function spruce() {
  const m = new MeshBuilder()
  m.lathe([[0.03, 0], [0.02, 0.3]], 5, Trunk)
  m.lathe([[0.2, 0.18], [0, 0.55]], 7, Foliage)
  m.lathe([[0.16, 0.4], [0, 0.78]], 7, Foliage, 0.3)
  m.lathe([[0.11, 0.62], [0, 1]], 7, Foliage, 0.6)
  return m.build()
}

/** Scots pine, common in the Gooi: a tall bare trunk with a flat crown. */
function pine() {
  const m = new MeshBuilder()
  m.lathe([[0.03, 0], [0.022, 0.7]], 5, Trunk)
  m.lathe([[0.1, 0.6], [0.22, 0.7], [0.24, 0.82], [0.15, 0.94], [0, 0.98]], 7, Foliage, 0.2)
  return m.build()
}

/** A Dutch street lamp: slim mast, short arm towards the street (+y) and a flat lantern. */
function lamp() {
  const m = new MeshBuilder()
  m.lathe([[0.09, 0], [0.06, 6.2], [0.05, 7.4]], 6, Metal)
  m.box(-0.04, 0.04, -0.05, 1.3, 7.25, 7.38, Metal)
  m.box(-0.22, 0.22, 1.1, 1.9, 7.2, 7.4, Metal)
  m.box(-0.18, 0.18, 1.15, 1.85, 7.15, 7.2, LampHead)
  return m.build()
}

/** One mesh per SceneryMesh value. */
export function buildSceneryModels(): Float32Array[] {
  return [roundTree(), ovalTree(), spruce(), pine(), lamp()]
}

import type { NetworkFile } from '../../types/simulation'

/**
 * Tiny synthetic network, 100 m blocks (coordinates in decimetres):
 *
 *   0 ── 1 ── 2
 *   │         │
 *   3 ──────► 4     3→4: one-way for cars, both ways for bikes and pedestrians
 */
export function tinyNetwork(): NetworkFile {
  const all = 1 | 2 | 4 | 8 | 16
  return {
    meta: {
      description: 'test',
      source: 'test',
      license: 'test',
      osmTimestamp: null,
      generated: '',
      bbox: [5.19, 52.29, 5.21, 52.31],
      projection: { lng0: 5.2, lat0: 52.3, kx: 68_000, ky: 110_574, unit: 0.1 },
    },
    classes: ['residential'],
    names: [],
    nodes: [0, 1000, 1000, 1000, 2000, 1000, 0, 0, 2000, 0],
    segments: {
      from: [0, 1, 0, 2, 3],
      to: [1, 2, 3, 4, 4],
      cls: [0, 0, 0, 0, 0],
      name: [-1, -1, -1, -1, -1],
      speed: [30, 30, 30, 30, 30],
      flags: [all, all, all, all, 1 | 4 | 8 | 16],
      way: [1, 2, 3, 4, 5],
      geom: [[], [], [], [], []],
    },
  }
}

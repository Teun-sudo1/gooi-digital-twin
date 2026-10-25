import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { describe, expect, it } from 'vitest'
import { buildStyle, DAY, NIGHT, paletteFor } from './style'

describe('map style', () => {
  // An invalid layer makes the whole style fail to load in the browser, so check it here.
  it('is valid by day, by night and in between', () => {
    for (const palette of [DAY, NIGHT, paletteFor(0.5)]) {
      const errors = validateStyleMin(buildStyle(palette))
      expect(errors.map((e) => e.message)).toEqual([])
    }
  })
})

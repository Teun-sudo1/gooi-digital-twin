import { defineConfig } from 'vitest/config'

// Deep simulation analysis (npm run check:deep): long runs of the whole model, kept out of `npm test`.
export default defineConfig({
  test: {
    include: ['checks/**/*.deep.ts'],
    testTimeout: 600_000,
    // One situation after another, so the timings in the report are comparable.
    fileParallelism: false,
  },
})

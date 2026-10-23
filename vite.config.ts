import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages serves the site from https://<user>.github.io/gooi-digital-twin/,
// so production builds (and `vite preview` of them) need that base path.
// The dev server keeps using "/".
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/gooi-digital-twin/' : '/',
  plugins: [react()],
  // MapLibre GL alone is ~1 MB minified; that is expected for a WebGL map engine.
  build: { chunkSizeWarningLimit: 1600 },
}))

# Gooi Digital Twin

Interactive 3D digital twin and urban mobility simulation of Huizen and the Gooi region, Netherlands.

**Live site:** https://teun-sudo1.github.io/gooi-digital-twin/

![3D view of central Huizen](docs/screenshot-huizen.png)

## Goals

A living geographic model of Huizen, Blaricum, Laren, Eemnes, Bussum, Naarden, Hilversum and the Gooimeer that can be explored in 3D and extended over time:

1. **Real 3D map** of the region (done: milestone 1).
2. **Living city:** a simplified, clearly labelled *simulated* traffic model on the real road network.
3. **Interactive infrastructure:** road closures, speed limits, cycle paths, bus lanes and housing scenarios that change the simulation, with the original scenario always restorable.

Everything runs in the browser as a static site. There is no backend.

## Features (milestone 1)

- Dark 3D map centred on Huizen, limited to the wider Gooi region
- Extruded buildings using OpenStreetMap height data
- Roads by class, rail, water, forests, parks and Dutch place and street labels
- Smooth pan, zoom, pitch and rotate; 2D/3D toggle; reset camera
- One-click views of every Gooi town and the whole region
- Address and place search through the PDOK Locatieserver, biased towards Huizen
- Collapsible layer panel
- Camera position kept in the URL hash, so views can be shared
- Loading, error and no-WebGL states; works at phone width

![Regional overview](docs/screenshot-region.png)

## Technology

React 19 · TypeScript · Vite · MapLibre GL JS 6 · Zustand · Turf.js (for the simulation) · oxlint

## Getting started

Requires Node.js 20.19+ or 22.12+ (`brew install node` on macOS).

```bash
npm install
npm run dev        # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Type-check and build the static site into `dist/` |
| `npm run preview` | Serve the production build at http://localhost:4173/gooi-digital-twin/ |
| `npm run typecheck` | TypeScript only |
| `npm run lint` | oxlint |

No API keys or environment variables are needed.

## Project structure

```
src/
  components/        UI: top bar, search, layer panel, camera controls, overlays
  features/map/      MapLibre map, dark style, layer groups, camera helpers
  features/simulation/  (milestone 2)
  features/scenarios/   (milestone 3)
  data/              Place presets and region bounds
  hooks/             React hooks (map instance)
  store/             Zustand app state (layers, map status)
  types/             Domain types: geography, roads, vehicles, routes, scenarios
  utils/             PDOK geocoder client
```

Camera movement is handled entirely inside MapLibre, so panning and zooming never re-render React. Vehicles will be drawn through map layers, not DOM elements.

## Data sources and attribution

| Data | Source | Licence |
| --- | --- | --- |
| Roads, buildings, water, land use, labels | [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via [OpenMapTiles](https://openmaptiles.org/) vector tiles hosted by [OpenFreeMap](https://openfreemap.org/) | ODbL (data), OpenMapTiles schema (CC-BY) |
| Address and place search | [PDOK Locatieserver](https://www.pdok.nl/) (Kadaster: BAG, BRT) | Dutch government open data (CC0 / CC BY 4.0) |

Attribution is shown in the map's attribution control. OpenFreeMap and PDOK are free public services, so please keep usage reasonable.

## Known limitations

- **Building heights are approximate.** They come from OSM `height` and `building:levels` tags. Where neither exists, the tile generator uses a small default height. No heights are invented by this app, but the defaults are not surveyed values.
- Building footprints and roads are as complete as OpenStreetMap is.
- Vector tiles stop at zoom 14 and are overzoomed beyond that, which is fine for buildings and roads.
- The Netherlands is flat, so there is no terrain elevation model.
- No traffic simulation yet. When it arrives, all traffic figures will be **simulated**, not observations of real traffic in Huizen.

## Roadmap

- [x] Milestone 1: interactive 3D map of Huizen and the Gooi region
- [ ] Milestone 2: road graph from OSM, animated vehicles, simulation clock, time-of-day demand, dashboard of simulated statistics
- [ ] Milestone 3: road closures that reroute traffic, speed limits, cycle paths, bus lanes, pedestrian zones, housing developments, scenario comparison

## Deployment (GitHub Pages)

Every push to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml). It lints, builds and publishes `dist/` to GitHub Pages with the official Pages actions.

- `vite.config.ts` sets the base path to `/gooi-digital-twin/` for builds, so assets load from the repository sub-path. The dev server still uses `/`.
- One-time setup (already done for this repo): **Settings → Pages → Build and deployment → Source: GitHub Actions**.
- Deployment status is in the repository's **Actions** tab. You can also rerun it manually there with **Run workflow**.

## Saving your work to GitHub

```bash
git status                     # see what changed
git add -A                     # stage changes (.env files are ignored)
git commit -m "feat: describe the change"
git push                       # publishes to GitHub and triggers a redeploy
```

Use short, descriptive commit messages such as `feat: add vehicle simulation` or `fix: search on mobile`. Never commit `.env` files or credentials. Because the repository is public, everything you push is visible to anyone.

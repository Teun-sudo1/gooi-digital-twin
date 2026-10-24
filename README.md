# Gooi Digital Twin

Interactive 3D digital twin and urban mobility simulation of the Gooi region (Hilversum, Bussum, Naarden, Huizen, Blaricum, Laren and Eemnes), Netherlands.

**Live site:** https://teun-sudo1.github.io/gooi-digital-twin/

![Hilversum station at midday: trains, buses, cars, cyclists and pedestrians](docs/screenshot-hilversum-station.png)

## Goals

A living geographic model of the Gooi that can be explored in 3D and extended over time:

1. **Real 3D map** of the region (done)
2. **Living city:** clearly labelled *simulated* cars, bikes, pedestrians, buses and trains on the real networks (done)
3. **Interactive infrastructure:** road closures, speed limits, car-free and pedestrian streets, bus-only roads and new cycle paths that change the simulation, with the original network always restorable (done; scenario comparison and sharing next)

Everything runs in the browser as a static site. There is no backend.

## Features

### Map

- 3D map of the whole Gooi region, with extruded buildings from OpenStreetMap
- **Day and night follow the simulated sun.** The map and interface fade from a light day palette to a dark night palette through twilight, using the sun's real elevation over the Gooi for today's date. Headlights come on after dusk. The layer panel can also force Day or Night.
- Roads, rail, water, forests, parks and Dutch place and street names
- **Trees:** the 9,000+ trees and tree rows mapped in OpenStreetMap at their real positions, and the Gooi's forests and woods filled with oaks, beeches, pines and spruces inside their real OSM outlines (the positions of individual forest trees are illustrative)
- **Street lighting:** lamp posts along lit streets, with warm pools of light on the road after dark; from far away the towns glow. About 150 lamps are mapped in OSM; the other ~34,000 are placed by rule (see [limitations](#known-limitations))
- Layer toggles, including **Transit routes & stops**, which only changes the map display: buses and trains keep running
- Rotate buttons (tap or hold), compass, 2D/3D toggle, reset view, keyboard shortcuts (press `?`)
- One-click views of each town; address search through the PDOK Locatieserver
- The camera is kept in the URL, so views can be shared

![The Gooi region on a weekday morning](docs/screenshot-region-day.png)

![Woods around the Bussummerheide](docs/screenshot-forest.png)

![Street lighting in Huizen at night](docs/screenshot-street-lights.png)

### Simulated traffic

- **Every agent is a 3D model** from street level up to zoom 13.5: cars (with glazed cabins, wheels, head- and brake lights), vans, trucks, buses in their line colours, NS train carriages, cyclists and pedestrians. They're drawn in a custom WebGL layer that shares depth with the 3D buildings. Agents are drawn larger than life (1.5× at street level, more when zoomed out), and further out they switch to flat icons.
- **Cars** of five types (hatchback, sedan, SUV, van, truck), each with its own size, colours, acceleration and top speed. Brake lights show when a car slows or stops.
- **Cyclists**, including faster e-bikes, on cycle paths and streets. Contraflow cycling is allowed where OSM tags it.
- **Pedestrians** on footways, pavements and paths, simulated around the area you are viewing at street level
- All modes follow the real street network: about 56,000 street segments from OpenStreetMap, with one-way rules, roundabouts and speed limits
- Cars brake for corners, keep a time gap to the car ahead, and follow Dutch right of way: side roads give way, roundabout traffic goes first, and on equal roads traffic from the right has priority. Queues form on their own.
- Weekday demand profiles per mode, with morning and evening rush hours, plus through traffic on the A1 and A27
- Play/pause, clock and time-of-day scrubber, speed 1–60×, traffic density slider
- A dashboard of **simulated** statistics: cars, cyclists, buses and trains in service, average speeds, car journey time, delayed cars, distance and estimated CO₂, plus a trend chart

### Road changes (scenarios)

Change the street network on the map and watch simulated traffic adapt:

- **Close road:** nobody can use the street any more
- **Car-free:** cars are banned; cyclists and pedestrians can still use the street
- **Pedestrians only:** walking only (works on streets and cycle paths)
- **Bus only:** cars and bikes are banned (pedestrians keep the pavement)
- **Speed limit:** 30, 50, 60, 80 or 100 km/h. Routes prefer faster streets, so a lower limit also moves traffic elsewhere.
- **New cycle path:** draw a two-way path between two junctions, with bends. It's open to cyclists and pedestrians.
- **Undo on street**, an undo button per change, and **Restore original network**

Pick a tool in the **Road changes** panel, then click streets on the map; the street under the pointer is highlighted first. Clicking a street again with the same tool undoes that change. Changes are drawn on the map in the tool's colour, with the new speed limit as a label.

When the network changes, every trip whose remaining route is no longer allowed is rerouted from the end of the street it is on. New trips plan their routes on the changed network. The panel shows how many trips were rerouted and how many had no way left. Buses and trains keep to their timetables and don't react to road changes yet.

![Road changes near Hilversum station: a closed street (red), a 30 km/h limit, a car-free street (green) and a new cycle path (teal)](docs/screenshot-road-changes.png)

### Public transport on real routes and timetables

- **Buses and trains run on their real routes and stops** from OpenStreetMap: Transdev's Gooi lines, R-net 320/321, Hilversum city lines, U-OV and Keolis lines, and NS Intercity and Sprinter services
- **Real timetables:** every trip on a normal weekday comes from the national GTFS feed (2,363 trips). Vehicles pass their stops at the scheduled times, pause at each stop and ease in between. Night buses and seasonal lines don't run on that weekday, so they don't appear.
- Buses carry their line colour, and a badge with the line number floats above every bus. Trains are drawn carriage by carriage in NS yellow and blue.

![Huizen at dusk, with an R-net bus](docs/screenshot-huizen-dusk.png)

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Q` / `E` (hold) | Rotate left / right |
| `N` | Face north |
| `T` | Toggle 2D / 3D |
| `H` | Reset view to the region |
| `Space` | Play / pause simulation |
| `/` | Focus search |
| `?` | Show shortcuts |
| `Esc` | Stop editing roads / cancel a cycle path |
| `Enter` / `Backspace` | Finish the cycle path / undo its last bend |

## Technology

React 19 · TypeScript · Vite · MapLibre GL JS 6 · Zustand · Web Workers · Vitest · oxlint

The trend chart is a small hand-written SVG component, so no charting library is needed.

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
| `npm test` | Unit tests: routing, traffic model, timetables, sun position |
| `npm run lint` / `npm run typecheck` | oxlint / TypeScript |
| `npm run data` | Rebuild all data files (see below) |

No API keys or environment variables are needed.

## How it works

```
src/
  components/           UI: top bar, search, panels, simulation bar, dashboard, chart
  features/map/         MapLibre map, day/night palettes, sun position, layers, camera, rotation
  features/simulation/  network, routing, traffic and transit models, worker, map client, icons
  features/scenarios/   road edits: scenario network, map layers, editing tools
  features/scenery/     trees and street lights: data, 3D models and layer
  hooks/ store/ types/ utils/ data/
public/data/            gooi-network.json, gooi-transit.json, gooi-scenery.json (generated, committed)
scripts/                fetch-osm.mjs, fetch-timetables.mjs, fetch-scenery.mjs, osm-common.mjs
```

- **Data build (offline).** `scripts/fetch-osm.mjs` downloads all streets and paths in the Gooi from the Overpass API. It splits them at junctions, works out car, bike and foot access in each direction, and keeps each mode's connected network. Roads leaving the area stay connected through a virtual "outside world" node, so through traffic works. It also extracts bus and train route relations, stitching their ways into continuous lines and projecting the stops onto them. `scripts/fetch-timetables.mjs` then streams the national GTFS feed. It matches every trip serving the Gooi to its OSM route variant by line number or train series, stop positions and stop order, and stores the trip's stop times. The outputs are compact (≈1 MB gzipped together) and are committed.
- **Simulation in a Web Worker.** Routing and stepping thousands of agents run off the main thread, so the map stays smooth. About 30 times a second the worker sends the positions of visible agents as a typed array. Close up, the main thread uploads them as instances to a custom WebGL layer (`agentLayer.ts`, one instanced draw call per agent kind, low-poly models in `models.ts`). Zoomed out, they go through MapLibre symbol layers. There are no DOM elements per vehicle, and React only gets statistics, four times a second.
- **Routing.** Car and bike trips start or end in about 250–400 destination zones per mode. Each zone has a cached shortest-path tree (one Dijkstra, about 4 ms), so a new trip's route is a pointer walk. Pedestrians use A* over short distances.
- **Transit** positions are a pure function of the clock (timetable interpolation), so time jumps are instant.
- **Trees and street lights** are drawn by a second instanced WebGL layer (`sceneryLayer.ts`), but only in 250 m cells near the camera (up to 110,000 trees and 12,000 lamps). Forest cells are generated on demand from the OSM outlines on a jittered 7.5 m grid, a few per frame, and cached. The light pools are a MapLibre circle layer that fades in with the night.
- **Road changes.** The main thread sends the whole scenario (closed or restricted segments, speed limits, new cycle paths) to the worker. The worker rebuilds the network from the original file (about 25 ms), clears the mode bits and changes the speeds of the edited streets, and appends new cycle paths after the original segments, so existing edge ids stay valid. Cached path trees are dropped. Trips whose remaining route is no longer allowed are rerouted a few at a time (at most 6 ms per step). Picking a street under the pointer also happens in the worker, on the original geometry.

## Data sources and attribution

| Data | Source | Licence |
| --- | --- | --- |
| Basemap: roads, buildings, water, land use, labels | [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via [OpenMapTiles](https://openmaptiles.org/) vector tiles hosted by [OpenFreeMap](https://openfreemap.org/) | ODbL; OpenMapTiles schema CC-BY |
| Street network, bus and train routes and stops | OpenStreetMap contributors, via the [Overpass API](https://overpass-api.de/) | ODbL 1.0 |
| Trees, forests, street lamps | OpenStreetMap contributors, via the Overpass API (`scripts/fetch-scenery.mjs`) | ODbL 1.0 |
| Bus and train timetables | [OVapi GTFS](https://gtfs.ovapi.nl/) (Stichting OpenGeo), from NDOV Loket open data | CC0 1.0 |
| Address and place search | [PDOK Locatieserver](https://www.pdok.nl/) (Kadaster) | Dutch government open data |

OpenFreeMap, Overpass, OVapi and PDOK are free public services, so keep usage reasonable. The data scripts identify themselves and cache downloads in `scripts/.cache/` (git-ignored).

## Known limitations

- **All traffic is simulated.** Car, bike and pedestrian numbers, speeds, journey times, delays and emissions come from a simplified model with assumed demand. They are not observations or predictions of real traffic.
- Buses and trains follow real timetables for one representative weekday (shown in the dashboard), but there is no live data: positions between stops are interpolated, and delays are not modelled. Transit vehicles don't interact with road traffic.
- No traffic lights, lanes, turn restrictions, parking or overtaking. Cars, bikes and pedestrians don't interact with each other.
- Pedestrians are only simulated around a street-level view (zoom 15+).
- Road changes work per street segment (junction to junction), and only the model reacts to them: buses keep their timetable, and the demand doesn't change (no one decides to cycle because a road was closed). New cycle paths are straight lines between the points you click and don't cross other streets at grade. Changes are not saved when the page is reloaded.
- CO₂ is a rough estimate (cars only, 150 g/km).
- Agents are drawn larger than true scale (1.5× at street level, more when zoomed out) so they stay visible, so they can look crowded in queues.
- Building heights are approximate where OSM has no height data.
- **Scenery is partly illustrative.** Mapped trees and tree rows are at their OSM positions (OSM covers only some street trees), but trees inside forests are placed on a jittered grid within the real outlines. Only about 150 street lamps are mapped in OSM; the rest are placed every 24–40 m along streets tagged as lit, or, without a tag, along urban streets with a limit of 50 km/h or less. Real lamp positions, heights and spacing differ. Trees and lamps are drawn from zoom 14 and 15.

## Roadmap

- [x] Milestone 1: interactive 3D map
- [x] Milestone 2: multimodal simulation, real transit routes and timetables, day/night
- [x] Milestone 3a: road closures, speed limits, car-free, pedestrian and bus-only streets, new cycle paths, with rerouting and restore
- [ ] Next: before/after scenario comparison, saving and sharing scenarios in the link, housing developments, traffic lights, buses affected by road traffic

## Refreshing the data

```bash
npm run data            # streets, transit routes, timetables, then trees and lights (uses cached downloads)
node scripts/fetch-osm.mjs --refresh          # force fresh OSM data
node scripts/fetch-scenery.mjs --refresh      # force fresh trees, forests and lamps
node scripts/fetch-timetables.mjs --refresh   # force a fresh GTFS feed (~240 MB)
node scripts/fetch-timetables.mjs --date 20261104   # use another service day
```

Review the changes to `public/data/`, run `npm test`, then commit.

## Deployment (GitHub Pages)

Every push to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml). It lints, tests, builds and publishes `dist/` to GitHub Pages. `vite.config.ts` sets the `/gooi-digital-twin/` base path for builds. Status is in the repository's **Actions** tab.

## Saving your work to GitHub

```bash
git status
git add -A
git commit -m "feat: describe the change"
git push                 # publishes and redeploys
```

Never commit `.env` files or credentials. The repository is public.

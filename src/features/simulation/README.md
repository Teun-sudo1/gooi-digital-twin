# Simulation

Simulated travellers on the real Gooi networks. Everything produced here is
model output, not measured traffic. Only the networks and the bus and train
timetables are real.

- `network.ts`: decodes `public/data/gooi-network.json` into typed arrays (local metres) with per-mode directed edges
- `routing.ts`: A* and cached shortest-path trees per mode, both with optional closed segments
- `traffic.ts`: cars (five types), bikes and pedestrians; demand, car-following, Dutch right of way, statistics
- `transit.ts`: buses and trains on OSM routes, driven by real GTFS stop times (or assumed frequencies without them)
- `sim.worker.ts`: runs the models in a Web Worker and streams visible agents as typed arrays
- `client.ts`: main-thread side: map layers, frame rendering, viewport updates, statistics
- `icons.ts`: vehicle and people icons drawn on canvas
- `simulation.test.ts`: unit tests on a synthetic network and the real data
- `agentLayer.ts` / `models.ts`: 3D rendering of all agents in a custom WebGL layer (instanced low-poly models)

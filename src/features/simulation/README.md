# Simulation

Simulated travellers on the real Gooi networks. Everything produced here is
model output, not measured traffic. Only the networks and the bus and train
timetables are real.

- `network.ts`: decodes `public/data/gooi-network.json` into typed arrays (local metres) with per-mode directed edges
- `routing.ts`: A* and cached shortest-path trees per mode (road edits are applied to the network's edge modes and speeds, see `../scenarios`)
- `traffic.ts`: cars (five types), bikes and pedestrians; demand, car-following, Dutch right of way, statistics
- `transit.ts`: bus and train lines on OSM routes with real GTFS stop times and stop names; trains are positioned from the timetable
- `buses.ts`: buses as vehicles in road traffic (route matching, stops, timetable keeping, diversions, simulated passengers, route diagrams)
- `lanes.ts`: lanes per direction from `public/data/gooi-lanes.json` (assumed by street type where unmapped); lane choice and overtaking live in `traffic.ts`
- `signals.ts`: traffic lights at OSM-mapped signals: one controller per junction, phases by direction, reacting to traffic (off by default)
- `useFollowVehicle.ts`: click a vehicle to follow it with the camera
- `sim.worker.ts`: runs the models in a Web Worker and streams visible agents as typed arrays
- `client.ts`: main-thread side: map layers, frame rendering, viewport updates, statistics
- `icons.ts`: vehicle and people icons drawn on canvas
- `simulation.test.ts` / `signals.test.ts`: unit tests on a synthetic network and the real data
- `agentLayer.ts` / `models.ts`: 3D rendering of all agents in a custom WebGL layer (instanced low-poly models)

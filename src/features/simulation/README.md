# Simulation

Simulated traffic on the real Huizen road network. Every number produced here is
model output, not measured traffic.

- `graph.ts`: loads `public/data/huizen-roads.json` and builds a directed graph in local metres
- `routing.ts`: A* fastest-route search, with optional closed segments
- `engine.ts`: demand, trip generation, car-following, right of way and statistics (no DOM or map code)
- `controller.ts`: animation loop, map layer for the cars, throttled stats for React
- `simulation.test.ts`: unit tests on a tiny synthetic network and on the real data

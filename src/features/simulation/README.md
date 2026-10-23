# Simulation (milestone 2)

Planned: a browser-side traffic simulation on a routable graph of the Huizen road
network. The graph will be built from OpenStreetMap once, by a script, and stored
as static GeoJSON in `src/data/`. Vehicles will be rendered through one MapLibre
GeoJSON source, not one DOM element per car.

Domain types are already defined in `src/types/simulation.ts`.

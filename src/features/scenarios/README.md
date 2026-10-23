# Scenarios (milestone 3)

Planned: interventions such as road closures and speed-limit changes that modify
the road graph used by the simulation, with the option to restore the baseline.
The engine already supports this: `TrafficSimulation.setClosedSegments()` closes
segments and reroutes affected cars (covered by a unit test). The UI is still to come.
See the `Intervention` and `Scenario` types in `src/types/simulation.ts`.

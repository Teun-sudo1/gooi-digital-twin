# Scenarios (milestone 3)

Planned: interventions such as road closures and speed-limit changes that modify
the network used by the simulation, with the option to restore the baseline.

Already in place: routing (`findRoute`, `PathTree`) accepts a set of closed
segments, and `TrafficModel.setClosures()` applies one (both covered by tests).
The UI and worker message are still to come. See the `Intervention` and
`Scenario` types in `src/types/simulation.ts`.

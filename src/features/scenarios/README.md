# Scenarios (milestone 3)

Road edits made on the map that change the street network used by the
simulation. An empty scenario is the original network.

- `tools.ts`: the editing tools (close road, car-free, pedestrians only, bus only, speed limit, new cycle path, undo), their colours and which streets each applies to
- `scenarioNetwork.ts`: worker side. Validates a scenario, rebuilds the network with the edits applied (new cycle paths are appended, so original edge ids stay stable), and picks the street or junction nearest to a point
- `scenarioLayers.ts`: map layers for edits, the street under the pointer and a cycle path being drawn
- `useScenarioEditing.ts`: pointer and keyboard interaction, and keeping the worker and the map in sync with `useScenarioStore`
- `scenarios.test.ts`: routing on edited networks, picking, validation and rerouting of live traffic

`TrafficModel.setNetwork()` swaps in the changed network and reroutes trips whose
remaining route is no longer allowed.

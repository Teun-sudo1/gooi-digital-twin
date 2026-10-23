import type { Route } from '../../types/simulation'
import type { RoadGraph } from './graph'

/** Minimal binary min-heap keyed by priority. */
class MinHeap {
  private keys: number[] = []
  private values: number[] = []

  get size() {
    return this.keys.length
  }

  push(key: number, value: number) {
    const { keys, values } = this
    let i = keys.length
    keys.push(key)
    values.push(value)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (keys[parent] <= key) break
      keys[i] = keys[parent]
      values[i] = values[parent]
      i = parent
    }
    keys[i] = key
    values[i] = value
  }

  pop(): number {
    const { keys, values } = this
    const top = values[0]
    const lastKey = keys.pop()!
    const lastValue = values.pop()!
    const n = keys.length
    if (n > 0) {
      let i = 0
      while (true) {
        let child = 2 * i + 1
        if (child >= n) break
        if (child + 1 < n && keys[child + 1] < keys[child]) child++
        if (keys[child] >= lastKey) break
        keys[i] = keys[child]
        values[i] = values[child]
        i = child
      }
      keys[i] = lastKey
      values[i] = lastValue
    }
    return top
  }
}

/**
 * Fastest route by free-flow travel time (length / speed limit), using A*
 * with a straight-line heuristic at the network's top speed, which never
 * overestimates and so keeps results optimal. Roads whose segment is in
 * `closed` are skipped. Returns null when no route exists.
 */
export function findRoute(
  graph: RoadGraph,
  from: number,
  to: number,
  closed?: ReadonlySet<string>,
): Route | null {
  if (from === to) return null
  const { nodes, roads, maxSpeedMs } = graph
  const n = nodes.length
  const cost = new Float64Array(n).fill(Infinity)
  const via = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  const target = nodes[to]
  const heuristic = (id: number) =>
    Math.hypot(nodes[id].x - target.x, nodes[id].y - target.y) / maxSpeedMs

  const heap = new MinHeap()
  cost[from] = 0
  heap.push(heuristic(from), from)

  while (heap.size > 0) {
    const u = heap.pop()
    if (done[u]) continue
    if (u === to) break
    done[u] = 1
    for (const roadId of nodes[u].outgoing) {
      const road = roads[roadId]
      if (closed?.has(road.segmentId)) continue
      const v = road.to
      if (done[v]) continue
      const next = cost[u] + road.lengthMeters / road.speedLimitMs
      if (next < cost[v]) {
        cost[v] = next
        via[v] = roadId
        heap.push(next + heuristic(v), v)
      }
    }
  }

  if (via[to] === -1) return null
  const path: number[] = []
  let lengthMeters = 0
  for (let node = to; node !== from; node = roads[via[node]].from) {
    path.push(via[node])
    lengthMeters += roads[via[node]].lengthMeters
  }
  path.reverse()
  return { roads: path, lengthMeters, freeFlowSeconds: cost[to] }
}

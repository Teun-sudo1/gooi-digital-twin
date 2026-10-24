import { edgeLength, MODE_BIT, type Network } from './network'
import type { Mode } from '../../types/simulation'

/** Minimal binary min-heap of (priority, value) pairs. */
export class MinHeap {
  private keys: number[] = []
  private values: number[] = []

  get size() {
    return this.keys.length
  }

  clear() {
    this.keys.length = 0
    this.values.length = 0
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

export interface Route {
  edges: Int32Array
  lengthMeters: number
  /** Travel time at the mode's free-flow speed. */
  freeFlowSeconds: number
}

// Road edits (closures, car-free streets) clear mode bits on the edges, so routing only checks those.
const usable = (net: Network, e: number, bit: number) => (net.edgeModes[e] & bit) !== 0

function finishRoute(net: Network, mode: Mode, edges: number[]): Route {
  let lengthMeters = 0
  let freeFlowSeconds = 0
  for (const e of edges) {
    const length = edgeLength(net, e)
    lengthMeters += length
    freeFlowSeconds += length / net.edgeSpeed[mode][e]
  }
  return { edges: Int32Array.from(edges), lengthMeters, freeFlowSeconds }
}

/**
 * Fastest route for one mode by free-flow travel time (A* with a
 * straight-line heuristic at the mode's top speed, which never overestimates
 * and so keeps routes optimal). Best for short or one-off trips.
 */
export function findRoute(net: Network, mode: Mode, from: number, to: number): Route | null {
  if (from === to) return null
  const bit = MODE_BIT[mode]
  const speed = net.edgeSpeed[mode]
  const n = net.nodeCount
  const cost = new Float64Array(n).fill(Infinity)
  const via = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  const tx = net.nodeX[to]
  const ty = net.nodeY[to]
  const vmax = net.maxSpeed[mode]
  const h = (i: number) => Math.hypot(net.nodeX[i] - tx, net.nodeY[i] - ty) / vmax

  const heap = new MinHeap()
  cost[from] = 0
  heap.push(h(from), from)
  while (heap.size) {
    const u = heap.pop()
    if (done[u]) continue
    if (u === to) break
    done[u] = 1
    for (let k = net.outStart[u]; k < net.outStart[u + 1]; k++) {
      const e = net.outEdges[k]
      if (!usable(net, e, bit)) continue
      const v = net.edgeTo[e]
      if (done[v]) continue
      const next = cost[u] + edgeLength(net, e) / speed[e]
      if (next < cost[v]) {
        cost[v] = next
        via[v] = e
        heap.push(next + h(v), v)
      }
    }
  }
  if (via[to] === -1) return null
  const edges: number[] = []
  for (let node = to; node !== from; node = net.edgeFrom[via[node]]) edges.push(via[node])
  edges.reverse()
  return finishRoute(net, mode, edges)
}

/**
 * A complete shortest-path tree for one mode around a root junction: either
 * every node's fastest way *to* the root ('to') or *from* the root ('from').
 * Building one costs a single Dijkstra over the network (~10 ms); after that,
 * a route between the root and any node is a pointer walk. Trips cluster on
 * a limited set of destination zones, so caching trees makes routing
 * thousands of trips cheap.
 */
export class PathTree {
  readonly net: Network
  readonly mode: Mode
  readonly root: number
  readonly direction: 'to' | 'from'
  /** Edge to follow next ('to' tree) or the edge used to arrive ('from' tree); -1 when unreachable. */
  readonly parent: Int32Array

  constructor(net: Network, mode: Mode, root: number, direction: 'to' | 'from') {
    this.net = net
    this.mode = mode
    this.root = root
    this.direction = direction
    const n = net.nodeCount
    const parent = new Int32Array(n).fill(-1)
    const cost = new Float64Array(n).fill(Infinity)
    const done = new Uint8Array(n)
    const bit = MODE_BIT[mode]
    const speed = net.edgeSpeed[mode]
    const forward = direction === 'from'
    const start = forward ? net.outStart : net.inStart
    const list = forward ? net.outEdges : net.inEdges
    const heap = new MinHeap()
    cost[root] = 0
    heap.push(0, root)
    while (heap.size) {
      const u = heap.pop()
      if (done[u]) continue
      done[u] = 1
      for (let k = start[u]; k < start[u + 1]; k++) {
        const e = list[k]
        if (!usable(net, e, bit)) continue
        const v = forward ? net.edgeTo[e] : net.edgeFrom[e]
        if (done[v]) continue
        const next = cost[u] + edgeLength(net, e) / speed[e]
        if (next < cost[v]) {
          cost[v] = next
          parent[v] = e
          heap.push(next, v)
        }
      }
    }
    this.parent = parent
  }

  /** Route between `node` and the root, in travel order; null when unreachable. */
  route(node: number): Route | null {
    if (node === this.root || this.parent[node] === -1) return null
    const { net, parent } = this
    const edges: number[] = []
    if (this.direction === 'to') {
      for (let u = node; u !== this.root; u = net.edgeTo[parent[u]]) edges.push(parent[u])
    } else {
      for (let u = node; u !== this.root; u = net.edgeFrom[parent[u]]) edges.push(parent[u])
      edges.reverse()
    }
    return finishRoute(net, this.mode, edges)
  }
}

/** Least-recently-used cache of path trees, keyed by mode, direction and root. */
export class TreeCache {
  private trees = new Map<string, PathTree>()
  private net: Network
  private capacity: number
  builtThisTick = 0

  constructor(net: Network, capacity: number) {
    this.net = net
    this.capacity = capacity
  }

  has(mode: Mode, root: number, direction: 'to' | 'from') {
    return this.trees.has(`${mode}:${direction}:${root}`)
  }

  get(mode: Mode, root: number, direction: 'to' | 'from'): PathTree {
    const key = `${mode}:${direction}:${root}`
    let tree = this.trees.get(key)
    if (tree) {
      // Refresh recency.
      this.trees.delete(key)
      this.trees.set(key, tree)
      return tree
    }
    tree = new PathTree(this.net, mode, root, direction)
    this.builtThisTick++
    this.trees.set(key, tree)
    if (this.trees.size > this.capacity) this.trees.delete(this.trees.keys().next().value!)
    return tree
  }
}

import { Kind } from '../../types/simulation'

/*
 * Low-poly 3D models for every agent kind, built from boxes. Coordinates are
 * metres: x to the right, y forward (direction of travel), z up, with the
 * origin on the ground at the centre of the vehicle. Each vertex carries a
 * material; the shader colours it per agent (paint, clothing, line colour).
 */

/** Materials understood by the agent shader (agentLayer.ts). */
export const Material = {
  Primary: 0, // paint, clothing, bus body
  Secondary: 1, // roof, trousers, bus line colour, train stripe
  Glass: 2,
  Tyre: 3,
  Headlight: 4,
  Taillight: 5,
  Skin: 6,
  Roof: 7, // neutral grey (train roofs, poles)
  // 8 is the headlight beam (agentLayer.ts)
  SignalRed: 9,
  SignalAmber: 10,
  SignalGreen: 11,
} as const

/** Floats per vertex: position (3), normal (3), material (1). */
export const VERTEX_FLOATS = 7

type Box = [x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, material: number]

function boxes(list: Box[]): Float32Array {
  const out: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], m: number) => {
    for (const v of [a, b, c, a, c, d]) out.push(v[0], v[1], v[2], n[0], n[1], n[2], m)
  }
  for (const [x0, x1, y0, y1, z0, z1, m] of list) {
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], m) // top
    quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1], m) // bottom
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], m) // front
    quad([x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y0, z0], [0, -1, 0], m) // back
    quad([x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [1, 0, 0], m) // right
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], m) // left
  }
  return new Float32Array(out)
}

const { Primary, Secondary, Glass, Tyre, Headlight, Taillight, Skin, Roof, SignalRed, SignalAmber, SignalGreen } = Material

/** Four wheels (or more for long vehicles) poking out under the body. */
function wheels(width: number, axles: number[], radius = 0.32): Box[] {
  const w = width / 2
  return axles.flatMap((y) => [
    [-w - 0.02, -w + 0.24, y - radius, y + radius, 0, radius * 2, Tyre] as Box,
    [w - 0.24, w + 0.02, y - radius, y + radius, 0, radius * 2, Tyre] as Box,
  ])
}

/** Head- and taillights on the front and back faces. */
function lights(width: number, length: number, z0: number, z1: number): Box[] {
  const w = width / 2
  const f = length / 2
  return [
    [-w + 0.1, -w + 0.45, f - 0.02, f + 0.03, z0, z1, Headlight],
    [w - 0.45, w - 0.1, f - 0.02, f + 0.03, z0, z1, Headlight],
    [-w + 0.08, -w + 0.4, -f - 0.03, -f + 0.02, z0, z1, Taillight],
    [w - 0.4, w - 0.08, -f - 0.03, -f + 0.02, z0, z1, Taillight],
  ]
}

/** A passenger car: body, glazed cabin with a painted roof, wheels and lights. */
function car(length: number, width: number, bodyTop: number, roofTop: number, cabinBack: number, cabinFront: number) {
  const w = width / 2
  const f = length / 2
  return boxes([
    [-w, w, -f, f, 0.28, bodyTop, Primary],
    [-w + 0.08, w - 0.08, cabinBack, cabinFront, bodyTop, roofTop - 0.06, Glass],
    [-w + 0.1, w - 0.1, cabinBack + 0.05, cabinFront - 0.05, roofTop - 0.06, roofTop, Primary],
    ...wheels(width, [f - 0.8, -f + 0.75]),
    ...lights(width, length, bodyTop - 0.28, bodyTop - 0.1),
  ])
}

function van() {
  const w = 1.0
  const f = 2.7
  return boxes([
    [-w, w, -f, f, 0.32, 1.0, Primary],
    [-w, w, -f, f - 0.9, 1.0, 2.25, Primary], // cargo body
    [-w + 0.06, w - 0.06, f - 0.9, f - 0.25, 1.0, 1.8, Glass], // sloping cab glass
    [-w + 0.1, w - 0.1, f - 0.9, f - 0.35, 1.8, 1.95, Primary],
    ...wheels(2.0, [f - 0.85, -f + 0.8], 0.34),
    ...lights(2.0, 5.4, 0.7, 0.88),
  ])
}

function truck() {
  const w = 1.25
  const f = 5
  return boxes([
    [-w, w, f - 2.3, f, 0.55, 2.0, Primary], // cab
    [-w + 0.05, w - 0.05, f - 0.45, f + 0.01, 1.5, 2.45, Glass],
    [-w, w, f - 2.3, f - 0.45, 2.0, 2.9, Primary],
    [-w, w, -f, f - 2.45, 0.9, 3.6, Secondary], // box body
    [-0.9, 0.9, -f, f - 2.3, 0.45, 0.9, Tyre], // chassis
    ...wheels(2.5, [f - 1.2, -f + 2.2, -f + 1.0], 0.48),
    ...lights(2.5, 10, 0.8, 1.0),
  ])
}

function bus() {
  const w = 1.275
  const f = 6
  return boxes([
    [-w, w, -f, f, 0.35, 3.0, Primary],
    [-w - 0.015, w + 0.015, -f + 1.0, f - 0.4, 1.25, 2.55, Glass], // side windows
    [-w + 0.1, w - 0.1, f - 0.01, f + 0.02, 0.9, 2.75, Glass], // windscreen
    [-w + 0.05, w - 0.05, -f + 0.3, f - 0.3, 3.0, 3.2, Secondary], // roof in line colour
    [-w - 0.02, w + 0.02, -f + 0.2, f - 0.2, 0.55, 0.85, Secondary], // skirt stripe
    ...wheels(2.55, [f - 2.3, -f + 2.8], 0.5),
    ...lights(2.55, 12, 0.6, 0.85),
  ])
}

function trainCar() {
  const w = 1.45
  const f = 13.25
  return boxes([
    [-w, w, -f + 0.3, f - 0.3, 0.9, 4.0, Primary],
    [-w - 0.015, w + 0.015, -f + 2, f - 2, 2.1, 3.1, Glass],
    [-w - 0.02, w + 0.02, -f + 0.5, f - 0.5, 1.3, 1.7, Secondary],
    [-w + 0.1, w - 0.1, -f + 0.4, f - 0.4, 4.0, 4.3, Roof],
    [-1.1, 1.1, -f + 1.5, -f + 4.5, 0.15, 0.9, Tyre], // bogies
    [-1.1, 1.1, f - 4.5, f - 1.5, 0.15, 0.9, Tyre],
  ])
}

/** Cyclist and bike, with the rider leaning slightly forward. */
function cyclist() {
  return boxes([
    [-0.03, 0.03, 0.2, 0.86, 0.02, 0.68, Tyre], // front wheel
    [-0.03, 0.03, -0.86, -0.2, 0.02, 0.68, Tyre], // rear wheel
    [-0.04, 0.04, -0.55, 0.55, 0.42, 0.58, Secondary], // frame
    [-0.25, 0.25, 0.48, 0.55, 0.95, 1.0, Secondary], // handlebar
    [-0.15, 0.15, -0.3, 0.05, 0.6, 1.0, Secondary], // legs
    [-0.2, 0.2, -0.28, 0.08, 1.0, 1.5, Primary], // torso
    [-0.22, 0.22, 0.0, 0.48, 1.12, 1.25, Primary], // arms
    [-0.11, 0.11, -0.12, 0.1, 1.52, 1.76, Skin], // head
  ])
}

function pedestrian() {
  return boxes([
    [-0.16, -0.02, -0.08, 0.08, 0, 0.85, Secondary],
    [0.02, 0.16, -0.08, 0.08, 0, 0.85, Secondary],
    [-0.22, 0.22, -0.12, 0.12, 0.85, 1.45, Primary],
    [-0.28, -0.22, -0.07, 0.07, 0.9, 1.4, Primary], // arms
    [0.22, 0.28, -0.07, 0.07, 0.9, 1.4, Primary],
    [-0.1, 0.1, -0.1, 0.1, 1.48, 1.72, Skin],
  ])
}

/** A traffic light: pole and a three-lamp head facing +y (the oncoming traffic). */
function trafficLight() {
  return boxes([
    [-0.06, 0.06, -0.06, 0.06, 0, 3.0, Roof],
    [-0.17, 0.17, -0.12, 0.1, 2.25, 3.2, Tyre],
    [-0.09, 0.09, 0.1, 0.13, 2.94, 3.12, SignalRed],
    [-0.09, 0.09, 0.1, 0.13, 2.65, 2.83, SignalAmber],
    [-0.09, 0.09, 0.1, 0.13, 2.36, 2.54, SignalGreen],
  ])
}

/** One mesh per Kind, indexed by the Kind value. */
export function buildModels(): Float32Array[] {
  const models: Float32Array[] = []
  models[Kind.Hatchback] = car(3.9, 1.75, 0.92, 1.48, -1.45, 0.55)
  models[Kind.Sedan] = car(4.7, 1.8, 0.9, 1.45, -1.3, 0.75)
  models[Kind.Suv] = car(4.8, 1.95, 1.1, 1.75, -1.95, 0.85)
  models[Kind.Van] = van()
  models[Kind.Truck] = truck()
  models[Kind.Bike] = cyclist()
  models[Kind.Pedestrian] = pedestrian()
  models[Kind.Bus] = bus()
  models[Kind.TrainCar] = trainCar()
  models[Kind.TrafficLight] = trafficLight()
  return models
}

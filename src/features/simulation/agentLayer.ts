import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MapLibreMap } from 'maplibre-gl'
import { Kind } from '../../types/simulation'
import { buildModels, VERTEX_FLOATS } from './models'

/*
 * Draws every simulated agent as a 3D model in a MapLibre custom WebGL layer:
 * one instanced draw call per kind, sharing the depth buffer with the 3D
 * buildings so they hide what is behind them.
 *
 * Precision: mercator coordinates for a whole city don't fit in 32-bit
 * floats without jitter, so instances are stored as small offsets from a
 * fixed origin, and the origin is folded into the matrix in 64-bit on the CPU.
 */

/** Floats per instance: offset (2), heading (1), colour (3), second colour (3), flags (1). */
export const INSTANCE_FLOATS = 10
export const InstanceFlag = { Braking: 1 } as const

/** Agents are drawn as 3D models from this zoom; below it the flat icons take over. */
export const MODEL_MIN_ZOOM = 13.5

const KINDS = [Kind.Hatchback, Kind.Sedan, Kind.Suv, Kind.Van, Kind.Truck, Kind.Bike, Kind.Pedestrian, Kind.Bus, Kind.TrainCar, Kind.TrafficLight]
const HEADLIGHT_KINDS = new Set<number>([Kind.Hatchback, Kind.Sedan, Kind.Suv, Kind.Van, Kind.Truck, Kind.Bus])
/** Front of each vehicle (metres ahead of its centre), where headlight beams start. */
const FRONT: Partial<Record<number, number>> = {
  [Kind.Hatchback]: 1.95,
  [Kind.Sedan]: 2.35,
  [Kind.Suv]: 2.4,
  [Kind.Van]: 2.7,
  [Kind.Truck]: 5,
  [Kind.Bus]: 6,
}

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in float a_material;
layout(location = 3) in vec2 i_offset;
layout(location = 4) in float i_heading;
layout(location = 5) in vec3 i_color;
layout(location = 6) in vec3 i_color2;
layout(location = 7) in float i_flags;
uniform mat4 u_matrix;
uniform vec3 u_scale;
out vec3 v_color;
out vec3 v_color2;
out vec3 v_normal;
out float v_material;
out float v_flags;
out float v_beam;
void main() {
  vec3 p = a_pos * u_scale;
  // Heading is clockwise from north; models face +y. Mercator y points south.
  float c = cos(i_heading);
  float s = sin(i_heading);
  vec2 east_north = vec2(p.x * c + p.y * s, -p.x * s + p.y * c);
  gl_Position = u_matrix * vec4(i_offset.x + east_north.x, i_offset.y - east_north.y, p.z, 1.0);
  v_normal = vec3(a_normal.x * c + a_normal.y * s, -a_normal.x * s + a_normal.y * c, a_normal.z);
  v_color = i_color;
  v_color2 = i_color2;
  v_material = a_material;
  v_flags = i_flags;
  v_beam = a_normal.x; // beams store their along-beam position here
}`

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec3 v_color;
in vec3 v_color2;
in vec3 v_normal;
in float v_material;
in float v_flags;
in float v_beam;
uniform float u_night;
out vec4 fragColor;
void main() {
  int m = int(v_material + 0.5);
  if (m == 8) {
    // Headlight beam on the road, fading with distance (drawn additively).
    fragColor = vec4(1.0, 0.93, 0.72, (1.0 - v_beam) * 0.2 * u_night);
    return;
  }
  if (m >= 9) {
    // Traffic light lamps: flags carry the state (0 green, 1 amber, 2 red).
    int state = int(v_flags + 0.5);
    vec3 on = m == 9 ? vec3(1.0, 0.16, 0.1) : m == 10 ? vec3(1.0, 0.68, 0.1) : vec3(0.2, 1.0, 0.45);
    bool lit = (m == 9 && state == 2) || (m == 10 && state == 1) || (m == 11 && state == 0);
    fragColor = vec4(lit ? on * 1.3 : on * 0.12, 1.0);
    return;
  }
  vec3 base =
    m == 0 ? v_color :
    m == 1 ? v_color2 :
    m == 2 ? vec3(0.13, 0.17, 0.22) :
    m == 3 ? vec3(0.07, 0.07, 0.08) :
    m == 4 ? vec3(0.95, 0.93, 0.85) :
    m == 5 ? vec3(0.45, 0.05, 0.04) :
    m == 6 ? vec3(0.86, 0.69, 0.56) :
    vec3(0.55, 0.57, 0.6);
  // Soft key light from the south-west and above, plus ambient.
  vec3 n = normalize(v_normal);
  float diffuse = 0.58 + 0.42 * max(dot(n, normalize(vec3(-0.4, -0.5, 0.75))), 0.0);
  vec3 lit = base * diffuse * mix(1.0, 0.5, u_night);
  if (m == 2) lit += vec3(0.07, 0.09, 0.12) * (1.0 - u_night) * max(n.z, 0.3);
  if (m == 4) lit = mix(lit, vec3(1.0, 0.96, 0.82) * 1.3, u_night);
  bool braking = mod(v_flags, 2.0) >= 1.0;
  if (m == 5) lit = braking ? vec3(1.0, 0.14, 0.08) : mix(lit, vec3(0.8, 0.08, 0.05), u_night);
  fragColor = vec4(lit, 1.0);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader error')
  return shader
}

/** A flat trapezoid on the road ahead of the vehicle (material 8). */
function beamMesh(front: number): Float32Array {
  const length = 11
  const near = 0.9
  const far = 3.5
  const z = 0.06
  // Vertex layout as models: pos(3), normal(3) → normal.x carries 0..1 along the beam, material.
  const v = (x: number, y: number, t: number) => [x, y, z, t, 0, 1, 8]
  const a = v(-near, front, 0)
  const b = v(near, front, 0)
  const c = v(far, front + length, 1)
  const d = v(-far, front + length, 1)
  return new Float32Array([...a, ...b, ...c, ...a, ...c, ...d])
}

interface Mesh {
  vao: WebGLVertexArrayObject
  buffer: WebGLBuffer
  count: number
}

/**
 * How much larger than life agents are drawn: modestly at street level, more
 * when zoomed out so they stay visible. Trains keep their true length (their
 * carriages are spaced to scale).
 */
function exaggeration(zoom: number) {
  return Math.min(7, Math.max(1.5, 1.5 * 2 ** ((17 - zoom) * 0.65)))
}

function kindScale(kind: number, k: number): [number, number, number] {
  if (kind === Kind.TrainCar) {
    const w = Math.min(k, 1.6)
    return [w, 1, w]
  }
  if (kind === Kind.Bus) return [k * 0.85, k * 0.85, k * 0.85]
  // People: noticeably larger than life, but not towering over the cars at street level.
  if (kind === Kind.Pedestrian) return [k * 0.9, k * 0.9, k * 0.9]
  if (kind === Kind.Bike) return [k, k, k]
  return [k, k, k]
}

export class AgentLayer implements CustomLayerInterface {
  readonly id = 'sim-agents-3d'
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const

  private map: MapLibreMap | null = null
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private instanceBuffer: WebGLBuffer | null = null
  private meshes: Mesh[] = []
  private beams: Mesh[] = []
  private uniforms: Record<string, WebGLUniformLocation | null> = {}
  private origin: MercatorCoordinate
  private metre: number
  private data: Float32Array = new Float32Array(0)
  private starts: number[] = []
  private counts: number[] = []
  private night = 0
  visible = true

  constructor(originLng: number, originLat: number) {
    this.origin = MercatorCoordinate.fromLngLat([originLng, originLat])
    this.metre = this.origin.meterInMercatorCoordinateUnits()
  }

  /** Mercator offset of a lng/lat from the layer origin, in 64-bit. */
  offset(lng: number, lat: number): [number, number] {
    const x = (lng + 180) / 360
    const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360
    return [x - this.origin.x, y - this.origin.y]
  }

  /** New instances, grouped by kind: `starts[kind]`/`counts[kind]` index into `data`. */
  setInstances(data: Float32Array, starts: number[], counts: number[]) {
    this.data = data
    this.starts = starts
    this.counts = counts
    const gl = this.gl
    if (gl && this.instanceBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
    }
    this.map?.triggerRepaint()
  }

  setNight(night: number) {
    this.night = night
    this.map?.triggerRepaint()
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map
    this.gl = gl
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link error')
    this.program = program
    for (const name of ['u_matrix', 'u_scale', 'u_night']) this.uniforms[name] = gl.getUniformLocation(program, name)
    this.instanceBuffer = gl.createBuffer()

    const upload = (vertices: Float32Array): Mesh => {
      const vao = gl.createVertexArray()!
      const buffer = gl.createBuffer()!
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
      const stride = VERTEX_FLOATS * 4
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12)
      gl.enableVertexAttribArray(2)
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 24)
      for (let loc = 3; loc <= 7; loc++) {
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribDivisor(loc, 1)
      }
      gl.bindVertexArray(null)
      return { vao, buffer, count: vertices.length / VERTEX_FLOATS }
    }
    const models = buildModels()
    for (const kind of KINDS) {
      this.meshes[kind] = upload(models[kind])
      const front = FRONT[kind]
      if (front !== undefined) this.beams[kind] = upload(beamMesh(front))
    }
    if (this.data.length) this.setInstances(this.data, this.starts, this.counts)
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext) {
    for (const mesh of [...this.meshes, ...this.beams]) {
      if (!mesh) continue
      gl.deleteVertexArray(mesh.vao)
      gl.deleteBuffer(mesh.buffer)
    }
    if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer)
    if (this.program) gl.deleteProgram(this.program)
    this.map = null
    this.gl = null
  }

  /** Points the per-instance attributes of a mesh at one kind's slice of the instance buffer. */
  private bindInstances(gl: WebGL2RenderingContext, mesh: Mesh, kind: number) {
    gl.bindVertexArray(mesh.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    const stride = INSTANCE_FLOATS * 4
    const base = this.starts[kind] * stride
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, base)
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, base + 8)
    gl.vertexAttribPointer(5, 3, gl.FLOAT, false, stride, base + 12)
    gl.vertexAttribPointer(6, 3, gl.FLOAT, false, stride, base + 24)
    gl.vertexAttribPointer(7, 1, gl.FLOAT, false, stride, base + 36)
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    const map = this.map
    if (!map || !this.program || !this.visible || map.getZoom() < MODEL_MIN_ZOOM || !this.data.length) return

    // Matrix: clip ← mercator coordinates (MapLibre's main projection matrix), with
    // the origin translation folded in using 64-bit floats.
    const m = options.defaultProjectionData.mainMatrix
    const { x, y } = this.origin
    const matrix = new Float32Array(16)
    for (let i = 0; i < 16; i++) matrix[i] = m[i]
    for (let r = 0; r < 4; r++) matrix[12 + r] = m[r] * x + m[4 + r] * y + m[12 + r]

    gl.useProgram(this.program)
    gl.uniformMatrix4fv(this.uniforms.u_matrix, false, matrix)
    gl.uniform1f(this.uniforms.u_night, this.night)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.depthMask(true)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.BLEND)

    const k = exaggeration(map.getZoom())
    for (const kind of KINDS) {
      const count = this.counts[kind] ?? 0
      if (!count) continue
      const [sx, sy, sz] = kindScale(kind, k)
      gl.uniform3f(this.uniforms.u_scale, sx * this.metre, sy * this.metre, sz * this.metre)
      const mesh = this.meshes[kind]
      this.bindInstances(gl, mesh, kind)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, mesh.count, count)
    }

    // Headlight beams after dark: translucent, no depth writes.
    if (this.night > 0.05) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
      gl.depthMask(false)
      for (const kind of KINDS) {
        const count = this.counts[kind] ?? 0
        const beam = this.beams[kind]
        if (!count || !beam || !HEADLIGHT_KINDS.has(kind)) continue
        const [sx, sy, sz] = kindScale(kind, k)
        gl.uniform3f(this.uniforms.u_scale, sx * this.metre, sy * this.metre, sz * this.metre)
        this.bindInstances(gl, beam, kind)
        gl.drawArraysInstanced(gl.TRIANGLES, 0, beam.count, count)
      }
      gl.depthMask(true)
      gl.disable(gl.BLEND)
    }
    gl.bindVertexArray(null)
  }
}

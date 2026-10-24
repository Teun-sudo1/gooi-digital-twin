import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MapLibreMap } from 'maplibre-gl'
import { CELL, type Scenery, type SceneryItem } from './sceneryData'
import { buildSceneryModels, SCENERY_VERTEX_FLOATS, SceneryMesh } from './sceneryModels'

/*
 * Draws trees and street lamps as instanced 3D models in a MapLibre custom
 * layer, sharing depth with the 3D buildings. Only cells near the camera are
 * drawn: the visible set is recomputed when the view moves to new cells, and
 * forest cells are generated a few at a time so panning never stalls.
 */

/** Floats per instance: offset (2), rotation (1), scale (1), colour (3). */
const INSTANCE_FLOATS = 7
const MESHES = [SceneryMesh.RoundTree, SceneryMesh.OvalTree, SceneryMesh.Spruce, SceneryMesh.Pine, SceneryMesh.Lamp]
export const TREE_MIN_ZOOM = 14
export const LAMP_MIN_ZOOM = 15
const MAX_TREES = 110_000
const MAX_LAMPS = 12_000
/** Time per frame spent generating forest cells. */
const GENERATE_BUDGET_MS = 6

const BROADLEAF = ['#4f7a38', '#5a8a3e', '#6a9444', '#46703a', '#77984a', '#5f8040'].map(rgb)
const CONIFER = ['#2f5636', '#35603b', '#2a4c31', '#3c6440'].map(rgb)

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in float a_material;
layout(location = 3) in vec2 i_offset;
layout(location = 4) in float i_rotation;
layout(location = 5) in float i_scale;
layout(location = 6) in vec3 i_color;
uniform mat4 u_matrix;
uniform float u_metre;
out vec3 v_color;
out vec3 v_normal;
out float v_material;
out float v_height;
void main() {
  vec3 p = a_pos * i_scale;
  float c = cos(i_rotation);
  float s = sin(i_rotation);
  // Rotation is clockwise from north; models face +y. Mercator y points south.
  vec2 en = vec2(p.x * c + p.y * s, -p.x * s + p.y * c);
  gl_Position = u_matrix * vec4(i_offset.x + en.x * u_metre, i_offset.y - en.y * u_metre, p.z * u_metre, 1.0);
  v_normal = vec3(a_normal.x * c + a_normal.y * s, -a_normal.x * s + a_normal.y * c, a_normal.z);
  v_color = i_color;
  v_material = a_material;
  v_height = a_pos.z;
}`

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec3 v_color;
in vec3 v_normal;
in float v_material;
in float v_height;
uniform float u_night;
out vec4 fragColor;
void main() {
  int m = int(v_material + 0.5);
  vec3 n = normalize(v_normal);
  float diffuse = 0.55 + 0.45 * max(dot(n, normalize(vec3(-0.4, -0.5, 0.75))), 0.0);
  if (m == 3) {
    // Lamp lantern: warm light after dark.
    fragColor = vec4(mix(vec3(0.75, 0.75, 0.72), vec3(1.0, 0.86, 0.55) * 1.6, u_night), 1.0);
    return;
  }
  vec3 base = m == 0 ? v_color * (0.82 + 0.3 * v_height) : m == 1 ? vec3(0.33, 0.26, 0.19) : vec3(0.36, 0.38, 0.4);
  fragColor = vec4(base * diffuse * mix(1.0, 0.42, u_night), 1.0);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader error')
  return shader
}

interface Mesh {
  vao: WebGLVertexArrayObject
  buffer: WebGLBuffer
  count: number
}

/** Radius (m) around the view centre in which scenery is drawn. */
function reach(zoom: number) {
  return Math.min(4500, Math.max(500, 1800 * 2 ** (15.5 - zoom)))
}

export class SceneryLayer implements CustomLayerInterface {
  readonly id = 'scenery-3d'
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const

  showTrees = true
  showLamps = true

  private map: MapLibreMap | null = null
  private program: WebGLProgram | null = null
  private instanceBuffer: WebGLBuffer | null = null
  private meshes: Mesh[] = []
  private uniforms: Record<string, WebGLUniformLocation | null> = {}
  private origin: MercatorCoordinate
  private metre: number
  private scenery: Scenery
  private night = 0
  private starts: number[] = []
  private counts: number[] = []
  /** Cells currently uploaded, and whether some were still missing. */
  private cellKey = ''
  private incomplete = false

  constructor(scenery: Scenery) {
    this.scenery = scenery
    const p = scenery.projection
    this.origin = MercatorCoordinate.fromLngLat([p.lng0, p.lat0])
    this.metre = this.origin.meterInMercatorCoordinateUnits()
  }

  setNight(night: number) {
    this.night = night
    this.map?.triggerRepaint()
  }

  setVisible(trees: boolean, lamps: boolean) {
    this.showTrees = trees
    this.showLamps = lamps
    this.cellKey = ''
    this.map?.triggerRepaint()
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link error')
    this.program = program
    for (const name of ['u_matrix', 'u_metre', 'u_night']) this.uniforms[name] = gl.getUniformLocation(program, name)
    this.instanceBuffer = gl.createBuffer()
    this.meshes = buildSceneryModels().map((vertices) => {
      const vao = gl.createVertexArray()!
      const buffer = gl.createBuffer()!
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
      const stride = SCENERY_VERTEX_FLOATS * 4
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12)
      gl.enableVertexAttribArray(2)
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 24)
      for (let loc = 3; loc <= 6; loc++) {
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribDivisor(loc, 1)
      }
      gl.bindVertexArray(null)
      return { vao, buffer, count: vertices.length / SCENERY_VERTEX_FLOATS }
    })
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext) {
    for (const mesh of this.meshes) {
      gl.deleteVertexArray(mesh.vao)
      gl.deleteBuffer(mesh.buffer)
    }
    if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer)
    if (this.program) gl.deleteProgram(this.program)
    this.map = null
  }

  /** Recomputes the instances when the view reaches new cells (or cells are still being generated). */
  private update(gl: WebGL2RenderingContext, map: MapLibreMap) {
    const zoom = map.getZoom()
    const p = this.scenery.projection
    const center = map.getCenter()
    const cx = (center.lng - p.lng0) * p.kx
    const cy = (center.lat - p.lat0) * p.ky
    const radius = reach(zoom)
    const trees = this.showTrees && zoom >= TREE_MIN_ZOOM
    const lamps = this.showLamps && zoom >= LAMP_MIN_ZOOM
    const lampRadius = Math.min(radius, 1500)
    const key = `${Math.floor(cx / CELL)},${Math.floor(cy / CELL)},${Math.round(radius / CELL)},${trees},${lamps}`
    if (key === this.cellKey && !this.incomplete) return

    // Cells within reach, nearest first.
    const cells: [number, number, number][] = []
    const r = Math.ceil(radius / CELL)
    const c0x = Math.floor(cx / CELL)
    const c0y = Math.floor(cy / CELL)
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const d = Math.hypot((c0x + i + 0.5) * CELL - cx, (c0y + j + 0.5) * CELL - cy)
        if (d <= radius + CELL) cells.push([c0x + i, c0y + j, d])
      }
    }
    cells.sort((a, b) => a[2] - b[2])

    const groups: SceneryItem[][][] = MESHES.map(() => [])
    let treeCount = 0
    let lampCount = 0
    let incomplete = false
    const started = performance.now()
    for (const [x, y, d] of cells) {
      if (trees && treeCount < MAX_TREES) {
        if (this.scenery.isReady(x, y) || performance.now() - started < GENERATE_BUDGET_MS) {
          const list = this.scenery.treesIn(x, y)
          const round: SceneryItem[] = []
          const oval: SceneryItem[] = []
          const spruce: SceneryItem[] = []
          const pine: SceneryItem[] = []
          for (const t of list) {
            if (t.conifer) (t.seed < 0.55 ? pine : spruce).push(t)
            else (t.seed < 0.6 ? round : oval).push(t)
          }
          groups[SceneryMesh.RoundTree].push(round)
          groups[SceneryMesh.OvalTree].push(oval)
          groups[SceneryMesh.Spruce].push(spruce)
          groups[SceneryMesh.Pine].push(pine)
          treeCount += list.length
        } else incomplete = true
      }
      if (lamps && d <= lampRadius + CELL && lampCount < MAX_LAMPS) {
        const list = this.scenery.lampsIn(x, y)
        groups[SceneryMesh.Lamp].push(list)
        lampCount += list.length
      }
    }

    // Upload, grouped by mesh.
    const total = treeCount + lampCount
    const data = new Float32Array(total * INSTANCE_FLOATS)
    const { x: ox, y: oy } = this.origin
    let w = 0
    this.starts = []
    this.counts = []
    for (const mesh of MESHES) {
      this.starts[mesh] = w / INSTANCE_FLOATS
      for (const list of groups[mesh]) {
        for (const item of list) {
          const lng = p.lng0 + item.x / p.kx
          const lat = p.lat0 + item.y / p.ky
          data[w] = (lng + 180) / 360 - ox
          data[w + 1] = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360 - oy
          if (mesh === SceneryMesh.Lamp) {
            data[w + 2] = (item.size * Math.PI) / 180
            data[w + 3] = 1
            data[w + 4] = data[w + 5] = data[w + 6] = 0
          } else {
            const palette = mesh === SceneryMesh.Spruce || mesh === SceneryMesh.Pine ? CONIFER : BROADLEAF
            const colour = palette[Math.floor(item.seed * 977) % palette.length]
            data[w + 2] = item.seed * Math.PI * 2
            data[w + 3] = item.size
            data[w + 4] = colour[0]
            data[w + 5] = colour[1]
            data[w + 6] = colour[2]
          }
          w += INSTANCE_FLOATS
        }
      }
      this.counts[mesh] = w / INSTANCE_FLOATS - this.starts[mesh]
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
    this.cellKey = key
    this.incomplete = incomplete
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    const map = this.map
    if (!map || !this.program || map.getZoom() < TREE_MIN_ZOOM || (!this.showTrees && !this.showLamps)) return
    this.update(gl, map)
    if (this.incomplete) map.triggerRepaint()

    const m = options.defaultProjectionData.mainMatrix
    const { x, y } = this.origin
    const matrix = new Float32Array(16)
    for (let i = 0; i < 16; i++) matrix[i] = m[i]
    for (let r = 0; r < 4; r++) matrix[12 + r] = m[r] * x + m[4 + r] * y + m[12 + r]

    gl.useProgram(this.program)
    gl.uniformMatrix4fv(this.uniforms.u_matrix, false, matrix)
    gl.uniform1f(this.uniforms.u_metre, this.metre)
    gl.uniform1f(this.uniforms.u_night, this.night)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.depthMask(true)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.BLEND)
    const stride = INSTANCE_FLOATS * 4
    for (const mesh of MESHES) {
      const count = this.counts[mesh] ?? 0
      if (!count) continue
      const { vao, count: vertices } = this.meshes[mesh]
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
      const base = this.starts[mesh] * stride
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, base)
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, base + 8)
      gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, base + 12)
      gl.vertexAttribPointer(6, 3, gl.FLOAT, false, stride, base + 16)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, vertices, count)
    }
    gl.bindVertexArray(null)
  }
}

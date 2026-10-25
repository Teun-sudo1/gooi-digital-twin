import { SegmentFlag } from '../../types/simulation'
import type { ScenarioTool } from '../../store/useScenarioStore'

const CARS = SegmentFlag.CarForward | SegmentFlag.CarBackward
const BIKES = SegmentFlag.BikeForward | SegmentFlag.BikeBackward

export interface ToolInfo {
  id: ScenarioTool
  label: string
  /** Shown while the tool is active. */
  hint: string
  colour: string
  /** Which streets the tool can be applied to (SegmentFlag bits in the original network). */
  mask: number
}

export const TOOLS: ToolInfo[] = [
  {
    id: 'closed',
    label: 'Close road',
    hint: 'Click a street to close it to everyone. Click it again to reopen it.',
    colour: '#e5484d',
    mask: CARS | BIKES | SegmentFlag.Foot,
  },
  {
    id: 'removed',
    label: 'Remove road',
    hint: 'Click a street or path to remove it completely, from the map as well. Click it again to bring it back.',
    colour: '#6b7480',
    mask: CARS | BIKES | SegmentFlag.Foot,
  },
  {
    id: 'no-cars',
    label: 'Car-free',
    hint: 'Click a street to ban cars. Cyclists and pedestrians can still use it.',
    colour: '#30a46c',
    mask: CARS,
  },
  {
    id: 'foot-only',
    label: 'Pedestrians only',
    hint: 'Click a street or cycle path to make it walking only.',
    colour: '#8e4ec6',
    mask: CARS | BIKES,
  },
  {
    id: 'bus-only',
    label: 'Bus only',
    hint: 'Click a road to reserve it for buses. Cars and bikes must go around; pedestrians keep the pavement.',
    colour: '#d6409f',
    mask: CARS,
  },
  {
    id: 'speed',
    label: 'Speed limit',
    hint: 'Pick a limit, then click roads to apply it.',
    colour: '#f5a524',
    mask: CARS,
  },
  {
    id: 'new-road',
    label: 'New road',
    hint: 'Choose the kind of road, click a junction to start, click to add bends, then double-click near a junction to finish. Backspace undoes a bend, Esc cancels.',
    colour: '#12a594',
    mask: 0,
  },
  {
    id: 'erase',
    label: 'Undo on street',
    hint: 'Click a changed street or a new road to undo the change.',
    colour: '#9aa6b4',
    mask: 0,
  },
]

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t])) as Record<ScenarioTool, ToolInfo>

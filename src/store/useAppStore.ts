import type { Map as MapLibreMap } from 'maplibre-gl'
import { create } from 'zustand'
import { DEFAULT_VISIBILITY, type LayerVisibility } from '../features/map/layers'
import { seasonOf, type LiveWeather, type Season, type SeasonSetting, type Weather, type WeatherSetting } from '../features/environment/environment'
import type { Basemap } from '../features/map/layers'
import { MAP_MODES, type MapMode } from '../features/map/mapModes'
import type { LightingMode } from '../features/map/lighting'
import type { LayerGroupId, MapStatus } from '../types/geo'

interface AppState {
  /** The single MapLibre instance, set once by MapView. Camera state lives in MapLibre, not here. */
  map: MapLibreMap | null
  mapStatus: MapStatus
  mapError: string | null
  layerVisibility: LayerVisibility
  layerPanelOpen: boolean
  shortcutsOpen: boolean
  /** The guided tour (opens by itself on a first visit). */
  tourOpen: boolean
  /** Follow the simulated sun, or force day or night. */
  lightingMode: LightingMode
  /** Drawn map or aerial photos. */
  basemap: Basemap
  /** The last chosen map mode (a preset of base map and layers). */
  mapMode: MapMode
  weatherSetting: WeatherSetting
  seasonSetting: SeasonSetting
  liveWeather: LiveWeather | null
  /** What is in effect: the chosen weather, or the live weather. */
  weather: Weather
  season: Season
  /** 1 solid, lower to see streets and traffic through the trees. */
  treeOpacity: number

  setMap: (map: MapLibreMap | null) => void
  setMapStatus: (status: MapStatus, error?: string) => void
  toggleLayer: (id: LayerGroupId) => void
  setLayerPanelOpen: (open: boolean) => void
  setShortcutsOpen: (open: boolean) => void
  setLightingMode: (mode: LightingMode) => void
  setMapMode: (mode: MapMode) => void
}


export const useAppStore = create<AppState>((set) => ({
  map: null,
  mapStatus: 'loading',
  mapError: null,
  layerVisibility: DEFAULT_VISIBILITY,
  // Start collapsed unless there is room for it beside the road-changes panel.
  layerPanelOpen: typeof window === 'undefined' || (window.innerWidth > 640 && window.innerHeight > 1100),
  shortcutsOpen: false,
  tourOpen: false,
  lightingMode: 'auto',
  basemap: 'map',
  mapMode: 'explore',
  weatherSetting: 'live',
  seasonSetting: 'auto',
  liveWeather: null,
  weather: 'dry',
  season: seasonOf(new Date()),
  treeOpacity: 1,

  setMap: (map) => set({ map }),
  setMapStatus: (mapStatus, error) => set({ mapStatus, mapError: error ?? null }),
  toggleLayer: (id) =>
    set((state) => ({
      layerVisibility: { ...state.layerVisibility, [id]: !state.layerVisibility[id] },
    })),
  setLayerPanelOpen: (layerPanelOpen) => set({ layerPanelOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setLightingMode: (lightingMode) => set({ lightingMode }),
  setMapMode: (mapMode) => {
    const mode = MAP_MODES.find((m) => m.id === mapMode)!
    set((state) => ({ mapMode, basemap: mode.basemap, layerVisibility: { ...state.layerVisibility, ...mode.layers } }))
  },
}))

import type { Map as MapLibreMap } from 'maplibre-gl'
import { create } from 'zustand'
import { DEFAULT_VISIBILITY, type LayerVisibility } from '../features/map/layers'
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
  /** Follow the simulated sun, or force day or night. */
  lightingMode: LightingMode

  setMap: (map: MapLibreMap | null) => void
  setMapStatus: (status: MapStatus, error?: string) => void
  toggleLayer: (id: LayerGroupId) => void
  setLayerPanelOpen: (open: boolean) => void
  setShortcutsOpen: (open: boolean) => void
  setLightingMode: (mode: LightingMode) => void
}

export const useAppStore = create<AppState>((set) => ({
  map: null,
  mapStatus: 'loading',
  mapError: null,
  layerVisibility: DEFAULT_VISIBILITY,
  // Start collapsed unless there is room for it beside the road-changes panel.
  layerPanelOpen: typeof window === 'undefined' || (window.innerWidth > 640 && window.innerHeight > 1100),
  shortcutsOpen: false,
  lightingMode: 'auto',

  setMap: (map) => set({ map }),
  setMapStatus: (mapStatus, error) => set({ mapStatus, mapError: error ?? null }),
  toggleLayer: (id) =>
    set((state) => ({
      layerVisibility: { ...state.layerVisibility, [id]: !state.layerVisibility[id] },
    })),
  setLayerPanelOpen: (layerPanelOpen) => set({ layerPanelOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setLightingMode: (lightingMode) => set({ lightingMode }),
}))

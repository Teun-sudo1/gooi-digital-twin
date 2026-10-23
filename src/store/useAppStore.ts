import type { Map as MapLibreMap } from 'maplibre-gl'
import { create } from 'zustand'
import { DEFAULT_VISIBILITY, type LayerVisibility } from '../features/map/layers'
import type { LayerGroupId, MapStatus } from '../types/geo'

interface AppState {
  /** The single MapLibre instance, set once by MapView. Camera state lives in MapLibre, not here. */
  map: MapLibreMap | null
  mapStatus: MapStatus
  mapError: string | null
  layerVisibility: LayerVisibility
  layerPanelOpen: boolean

  setMap: (map: MapLibreMap | null) => void
  setMapStatus: (status: MapStatus, error?: string) => void
  toggleLayer: (id: LayerGroupId) => void
  setLayerPanelOpen: (open: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  map: null,
  mapStatus: 'loading',
  mapError: null,
  layerVisibility: DEFAULT_VISIBILITY,
  // Start collapsed on phone-sized screens so the map stays visible.
  layerPanelOpen: typeof window === 'undefined' || window.innerWidth > 640,

  setMap: (map) => set({ map }),
  setMapStatus: (mapStatus, error) => set({ mapStatus, mapError: error ?? null }),
  toggleLayer: (id) =>
    set((state) => ({
      layerVisibility: { ...state.layerVisibility, [id]: !state.layerVisibility[id] },
    })),
  setLayerPanelOpen: (layerPanelOpen) => set({ layerPanelOpen }),
}))

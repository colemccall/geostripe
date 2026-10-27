import type { Map as MapLibreMap } from 'maplibre-gl';
import { LAYER_GROUPS } from './layerGroups';
import type { ViewMode } from '../store/useEditorStore';

/**
 * Info views: recolour the map by one property.
 *
 * Each view is a small table of paint overrides applied to the existing layers and removed
 * again when the view is left, so nothing about a view lives in the document. The imagery is
 * dimmed under every view but the normal one, because the question a view asks ("where is
 * the commercial land") is answered by colour and the photograph competes with it.
 */

/** Imagery brightness under a view, as a fraction of the user's own setting. */
export const VIEW_IMAGERY_FACTOR: Record<ViewMode, number> = {
  none: 1,
  landUse: 0.3,
  roadType: 0.35,
  height: 0.35,
  district: 0.4,
};

/** Colours by road family, for the road-type view. Kept in step with `FAMILY_COLORS` users. */
export const FAMILY_COLORS: Record<string, string> = {
  highway: '#D64545',
  arterial: '#F2994A',
  street: '#F2D04A',
  transit: '#4DA3FF',
  path: '#6FCF97',
  area: '#9AA5B1',
};

/** Colours by deck, for the height view: tunnel, ground, raised. */
export const DECK_COLORS = { '-1': '#2D9CDB', '0': '#9AA5B1', '1': '#E4572E' } as const;

const roadLayers = (): string[] => LAYER_GROUPS.find((g) => g.id === 'roads')!.layers;

export interface LegendEntry {
  label: string;
  color: string;
}

export function legendFor(view: ViewMode): LegendEntry[] {
  switch (view) {
    case 'roadType':
      return [
        { label: 'Highway', color: FAMILY_COLORS.highway! },
        { label: 'Arterial', color: FAMILY_COLORS.arterial! },
        { label: 'Street', color: FAMILY_COLORS.street! },
        { label: 'Transit', color: FAMILY_COLORS.transit! },
        { label: 'Path', color: FAMILY_COLORS.path! },
      ];
    case 'height':
      return [
        { label: 'Tunnel', color: DECK_COLORS['-1'] },
        { label: 'At ground', color: DECK_COLORS['0'] },
        { label: 'Raised', color: DECK_COLORS['1'] },
      ];
    default:
      return [];
  }
}

/** Apply a view to the map. Safe to call again after any style change. */
export function applyView(map: MapLibreMap, view: ViewMode): void {
  const set = (layer: string, prop: string, value: unknown) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop as never, value as never);
  };

  // Roads: normal colour, or recoloured by family or by deck.
  const color =
    view === 'roadType'
      ? ['get', 'familyColor']
      : view === 'height'
        ? ['get', 'deckColor']
        : ['get', 'color'];
  for (const layer of roadLayers()) {
    set(layer, 'line-color', color);
    set(layer, 'line-opacity', view === 'landUse' || view === 'district' ? 0.45 : 1);
  }

  // Land use: bolder when it is the subject, ordinary otherwise.
  set('zone-fill', 'fill-opacity', view === 'landUse' ? 0.88 : ['get', 'opacity']);
  set('zone-line', 'line-width', view === 'landUse' ? 1.6 : 1.2);

  // Districts: the wash is faint normally and the point of the district view.
  set('district-fill', 'fill-opacity', view === 'district' ? 0.4 : 0.1);
  set('district-line', 'line-width', view === 'district' ? 3.5 : 2.5);
}

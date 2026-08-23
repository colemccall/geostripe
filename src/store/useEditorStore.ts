import { create } from 'zustand';
import type { ComponentType, Direction } from '../library/primitives';
import { PRIMITIVES } from '../library/primitives';
import { TEMPLATES, instantiateTemplate } from '../library/templates';
import type { CrossSection, SectionComponent, Street } from '../model/types';
import { newId } from '../model/types';
import { autoAnchorOffset, geometricCentreOffset } from '../model/section';
import type { DisplayUnits } from '../lib/units';
import type { BasemapId } from '../map/basemaps';
import { DEFAULT_VINTAGE } from '../map/basemaps';
import { createDemoStreets } from '../demo/washingtonPark';

/**
 * Editor state.
 *
 * Undo/redo is built in rather than retrofitted: every mutation funnels through `commit`,
 * which is the only place history is recorded. Snapshots rather than patches — a project
 * is a handful of numbers and strings, so copying it is free and a snapshot cannot drift
 * out of sync the way a mis-applied patch can.
 *
 * Two edit targets, because the two pages edit different things: the Map Editor works on
 * the selected street's section, the Asset Builder on a standalone draft that has no
 * centerline. Passing the target explicitly keeps the store from having to know which
 * page is mounted.
 */

const HISTORY_LIMIT = 100;

export type EditTarget = 'street' | 'draft';
export type AnchorMode = 'travelway' | 'geometric' | 'leftEdge' | 'custom';

export interface Notice {
  kind: 'error' | 'success' | 'warning';
  title: string;
  details?: string[];
}

interface Snapshot {
  streets: Street[];
  draftSection: CrossSection;
}

interface EditorState extends Snapshot {
  // ---- chrome
  units: DisplayUnits;
  basemapId: BasemapId;
  customTileUrl: string;
  waybackRelease: string;
  arcgisApiKey: string;

  // ---- selection
  selectedStreetId: string | null;
  selectedComponentId: string | null;

  /** Swipe divider position, 0..1 across the map. null = off. */
  swipe: number | null;

  past: Snapshot[];
  future: Snapshot[];
  notice: Notice | null;

  // ---- chrome actions
  setUnits: (units: DisplayUnits) => void;
  setBasemap: (id: BasemapId) => void;
  setCustomTileUrl: (url: string) => void;
  setWaybackRelease: (release: string) => void;
  setArcgisApiKey: (key: string) => void;
  setSwipe: (value: number | null) => void;
  setNotice: (notice: Notice | null) => void;

  // ---- selection actions
  selectStreet: (id: string | null) => void;
  selectComponent: (id: string | null) => void;

  // ---- section editing, on either target
  addComponent: (target: EditTarget, type: ComponentType, index?: number) => void;
  removeComponent: (target: EditTarget, id: string) => void;
  setWidth: (target: EditTarget, id: string, metres: number) => void;
  setDirection: (target: EditTarget, id: string, direction: Direction) => void;
  moveComponent: (target: EditTarget, id: string, delta: number) => void;
  setAnchorMode: (target: EditTarget, mode: AnchorMode) => void;
  renameSection: (target: EditTarget, name: string) => void;
  applyTemplate: (target: EditTarget, templateId: string) => void;
  loadSection: (target: EditTarget, section: CrossSection) => void;

  // ---- street-level
  setExistingWidth: (streetId: string, metres: number) => void;
  setCenterline: (streetId: string, centerline: [number, number][]) => void;
  removeStreet: (streetId: string) => void;
  clearStreets: () => void;
  loadDemo: () => void;

  undo: () => void;
  redo: () => void;
}

const initialStreets = createDemoStreets();

export const useEditorStore = create<EditorState>((set, get) => {
  const snapshot = (): Snapshot => {
    const { streets, draftSection } = get();
    return { streets, draftSection };
  };

  const commit = (next: Partial<Snapshot>) => {
    const previous = snapshot();
    set({
      ...next,
      past: [...get().past, previous].slice(-HISTORY_LIMIT),
      future: [],
    });
  };

  /** Apply a transform to whichever section the target names. */
  const editSection = (target: EditTarget, fn: (section: CrossSection) => CrossSection) => {
    if (target === 'draft') {
      commit({ draftSection: fn(get().draftSection) });
      return;
    }
    const { streets, selectedStreetId } = get();
    const id = selectedStreetId ?? streets[0]?.id;
    if (!id) return;
    commit({
      streets: streets.map((s) => (s.id === id ? { ...s, section: fn(s.section) } : s)),
    });
  };

  const editComponents = (
    target: EditTarget,
    fn: (components: SectionComponent[]) => SectionComponent[],
  ) => editSection(target, (section) => ({ ...section, components: fn(section.components) }));

  return {
    units: 'ft',
    basemapId: 'usgsNaip',
    customTileUrl: '',
    waybackRelease: DEFAULT_VINTAGE,
    arcgisApiKey: '',

    streets: initialStreets,
    draftSection: instantiateTemplate(TEMPLATES[1]!),

    selectedStreetId: initialStreets[0]?.id ?? null,
    selectedComponentId: null,
    // Demo opens with the swipe on, so the redesign reads against the real street.
    swipe: 0.5,

    past: [],
    future: [],
    notice: null,

    setUnits: (units) => set({ units }),
    setBasemap: (basemapId) => set({ basemapId }),
    setCustomTileUrl: (customTileUrl) => set({ customTileUrl }),
    setWaybackRelease: (waybackRelease) => set({ waybackRelease }),
    setArcgisApiKey: (arcgisApiKey) => set({ arcgisApiKey }),
    setSwipe: (swipe) => set({ swipe }),
    setNotice: (notice) => set({ notice }),

    selectStreet: (selectedStreetId) => set({ selectedStreetId, selectedComponentId: null }),
    selectComponent: (selectedComponentId) => set({ selectedComponentId }),

    addComponent: (target, type, index) =>
      editComponents(target, (components) => {
        const spec = PRIMITIVES[type];
        const entry: SectionComponent = {
          id: newId('cmp'),
          componentType: type,
          widthMeters: spec.defaultWidthMeters,
          direction: spec.defaultDirection,
        };
        // Insert just inside the right-hand kerb rather than outside the footway, which
        // is almost never what someone means by "add a lane".
        const at = index ?? Math.max(components.length - 1, 0);
        const next = [...components];
        next.splice(at, 0, entry);
        return next;
      }),

    removeComponent: (target, id) => {
      editComponents(target, (components) => components.filter((c) => c.id !== id));
      if (get().selectedComponentId === id) set({ selectedComponentId: null });
    },

    setWidth: (target, id, metres) =>
      editComponents(target, (components) =>
        components.map((c) => (c.id === id ? { ...c, widthMeters: metres } : c)),
      ),

    setDirection: (target, id, direction) =>
      editComponents(target, (components) =>
        components.map((c) => (c.id === id ? { ...c, direction } : c)),
      ),

    moveComponent: (target, id, delta) =>
      editComponents(target, (components) => {
        const from = components.findIndex((c) => c.id === id);
        if (from < 0) return components;
        const to = from + delta;
        if (to < 0 || to >= components.length) return components;
        const next = [...components];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        return next;
      }),

    setAnchorMode: (target, mode) =>
      editSection(target, (section) => ({
        ...section,
        anchorOffsetMeters:
          mode === 'travelway'
            ? null
            : mode === 'geometric'
              ? geometricCentreOffset(section.components)
              : mode === 'leftEdge'
                ? 0
                : (section.anchorOffsetMeters ?? autoAnchorOffset(section.components)),
      })),

    renameSection: (target, name) => editSection(target, (section) => ({ ...section, name })),

    applyTemplate: (target, templateId) => {
      const def = TEMPLATES.find((t) => t.id === templateId);
      if (!def) return;
      const fresh = instantiateTemplate(def);
      editSection(target, (section) => ({ ...fresh, id: section.id }));
      set({ selectedComponentId: null });
    },

    loadSection: (target, section) => {
      editSection(target, () => section);
      set({ selectedComponentId: null });
    },

    setExistingWidth: (streetId, metres) =>
      commit({
        streets: get().streets.map((s) =>
          s.id === streetId ? { ...s, existingWidthMeters: metres } : s,
        ),
      }),

    setCenterline: (streetId, centerline) =>
      commit({
        streets: get().streets.map((s) => (s.id === streetId ? { ...s, centerline } : s)),
      }),

    removeStreet: (streetId) => {
      commit({ streets: get().streets.filter((s) => s.id !== streetId) });
      if (get().selectedStreetId === streetId) {
        set({ selectedStreetId: get().streets[0]?.id ?? null, selectedComponentId: null });
      }
    },

    clearStreets: () => {
      commit({ streets: [] });
      set({ selectedStreetId: null, selectedComponentId: null });
    },

    loadDemo: () => {
      const streets = createDemoStreets();
      commit({ streets });
      set({ selectedStreetId: streets[0]?.id ?? null, selectedComponentId: null, swipe: 0.5 });
    },

    undo: () => {
      const { past, future } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({
        ...previous,
        past: past.slice(0, -1),
        future: [snapshot(), ...future].slice(0, HISTORY_LIMIT),
      });
    },

    redo: () => {
      const { future, past } = get();
      const next = future[0];
      if (!next) return;
      set({
        ...next,
        past: [...past, snapshot()].slice(-HISTORY_LIMIT),
        future: future.slice(1),
      });
    },
  };
});

/** The section the Map Editor is currently editing. */
export function selectedStreet(state: EditorState): Street | undefined {
  return state.streets.find((s) => s.id === state.selectedStreetId) ?? state.streets[0];
}

/** Current anchor mode, inferred from the stored offset. */
export function anchorModeOf(section: CrossSection): AnchorMode {
  if (section.anchorOffsetMeters === null) return 'travelway';
  const offset = section.anchorOffsetMeters;
  if (Math.abs(offset - geometricCentreOffset(section.components)) < 1e-6) return 'geometric';
  if (Math.abs(offset) < 1e-6) return 'leftEdge';
  return 'custom';
}

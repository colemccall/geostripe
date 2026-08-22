import { create } from 'zustand';
import type { ComponentType, Direction } from '../library/primitives';
import { PRIMITIVES } from '../library/primitives';
import { TEMPLATES, instantiateTemplate } from '../library/templates';
import type { CrossSection } from '../model/types';
import { newId } from '../model/types';
import { autoAnchorOffset, geometricCentreOffset, totalWidth } from '../model/section';
import type { DisplayUnits } from '../lib/units';
import type { BasemapId } from '../map/basemaps';

/**
 * Editor state.
 *
 * Undo/redo is built in from the start rather than retrofitted — bolting a command
 * history onto an established store means rewriting every mutation, and the whole
 * premise here is that designs stay editable. Every change to the section funnels
 * through `commit`, which is the only place history is recorded.
 *
 * History uses snapshots rather than patches. A cross-section is a handful of numbers
 * and strings, so copying it is free, and snapshots cannot drift out of sync with the
 * state the way a mis-applied patch can. If this ever holds a full multi-street project,
 * revisit — not before.
 */

const HISTORY_LIMIT = 100;

export type AnchorMode = 'travelway' | 'geometric' | 'leftEdge' | 'custom';

export interface Notice {
  kind: 'error' | 'success' | 'warning';
  title: string;
  details?: string[];
}

interface EditorState {
  // ---- shared chrome
  units: DisplayUnits;
  basemapId: BasemapId;
  customTileUrl: string;

  // ---- the section being edited
  section: CrossSection;
  selectedComponentId: string | null;

  /** Measured curb-to-curb + walks of the real street, for the fit check. */
  measuredRowMeters: number;

  // ---- history
  past: CrossSection[];
  future: CrossSection[];

  notice: Notice | null;

  // ---- actions
  setUnits: (units: DisplayUnits) => void;
  setBasemap: (id: BasemapId) => void;
  setCustomTileUrl: (url: string) => void;
  setMeasuredRow: (metres: number) => void;
  setNotice: (notice: Notice | null) => void;

  select: (id: string | null) => void;
  rename: (name: string) => void;
  addComponent: (type: ComponentType, index?: number) => void;
  removeComponent: (id: string) => void;
  setWidth: (id: string, metres: number) => void;
  setDirection: (id: string, direction: Direction) => void;
  moveComponent: (id: string, delta: number) => void;
  setAnchorMode: (mode: AnchorMode) => void;

  loadSection: (section: CrossSection) => void;
  loadTemplate: (templateId: string) => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

const initialSection = instantiateTemplate(TEMPLATES[1]!);

export const useEditorStore = create<EditorState>((set, get) => {
  /** The single funnel for section mutations — records history, clears redo. */
  const commit = (next: CrossSection) => {
    const { section, past } = get();
    set({
      section: next,
      past: [...past, section].slice(-HISTORY_LIMIT),
      future: [],
    });
  };

  const mutateComponents = (
    fn: (components: CrossSection['components']) => CrossSection['components'],
  ) => {
    const { section } = get();
    commit({ ...section, components: fn(section.components) });
  };

  return {
    units: 'ft',
    basemapId: 'esri',
    customTileUrl: '',
    section: initialSection,
    selectedComponentId: null,
    measuredRowMeters: 18.6,
    past: [],
    future: [],
    notice: null,

    setUnits: (units) => set({ units }),
    setBasemap: (basemapId) => set({ basemapId }),
    setCustomTileUrl: (customTileUrl) => set({ customTileUrl }),
    setMeasuredRow: (measuredRowMeters) => set({ measuredRowMeters }),
    setNotice: (notice) => set({ notice }),

    select: (selectedComponentId) => set({ selectedComponentId }),

    rename: (name) => commit({ ...get().section, name }),

    addComponent: (type, index) =>
      mutateComponents((components) => {
        const spec = PRIMITIVES[type];
        const entry = {
          id: newId('cmp'),
          componentType: type,
          widthMeters: spec.defaultWidthMeters,
          direction: spec.defaultDirection,
        };
        // Default insertion sits just inside the right-hand kerb rather than outside the
        // sidewalk, which is almost never what someone means by "add a lane".
        const at = index ?? Math.max(components.length - 1, 0);
        const next = [...components];
        next.splice(at, 0, entry);
        return next;
      }),

    removeComponent: (id) => {
      mutateComponents((components) => components.filter((c) => c.id !== id));
      if (get().selectedComponentId === id) set({ selectedComponentId: null });
    },

    setWidth: (id, metres) =>
      mutateComponents((components) =>
        components.map((c) => (c.id === id ? { ...c, widthMeters: metres } : c)),
      ),

    setDirection: (id, direction) =>
      mutateComponents((components) =>
        components.map((c) => (c.id === id ? { ...c, direction } : c)),
      ),

    moveComponent: (id, delta) =>
      mutateComponents((components) => {
        const from = components.findIndex((c) => c.id === id);
        if (from < 0) return components;
        const to = from + delta;
        if (to < 0 || to >= components.length) return components;
        const next = [...components];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        return next;
      }),

    setAnchorMode: (mode) => {
      const { section } = get();
      const offset =
        mode === 'travelway'
          ? null
          : mode === 'geometric'
            ? geometricCentreOffset(section.components)
            : mode === 'leftEdge'
              ? 0
              : (section.anchorOffsetMeters ?? autoAnchorOffset(section.components));
      commit({ ...section, anchorOffsetMeters: offset });
    },

    loadSection: (section) => {
      commit(section);
      set({ selectedComponentId: null });
    },

    loadTemplate: (templateId) => {
      const def = TEMPLATES.find((t) => t.id === templateId);
      if (!def) return;
      commit(instantiateTemplate(def));
      set({ selectedComponentId: null });
    },

    undo: () => {
      const { past, section, future } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({
        section: previous,
        past: past.slice(0, -1),
        future: [section, ...future].slice(0, HISTORY_LIMIT),
      });
    },

    redo: () => {
      const { future, section, past } = get();
      const next = future[0];
      if (!next) return;
      set({
        section: next,
        past: [...past, section].slice(-HISTORY_LIMIT),
        future: future.slice(1),
      });
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,
  };
});

/** Current anchor mode, inferred from the stored offset. */
export function anchorModeOf(section: CrossSection): AnchorMode {
  if (section.anchorOffsetMeters === null) return 'travelway';
  const offset = section.anchorOffsetMeters;
  if (Math.abs(offset - geometricCentreOffset(section.components)) < 1e-6) return 'geometric';
  if (Math.abs(offset) < 1e-6) return 'leftEdge';
  return 'custom';
}

export function sectionWidth(section: CrossSection): number {
  return totalWidth(section.components);
}

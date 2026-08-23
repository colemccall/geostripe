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

/**
 * The active map tool.
 *
 * Deliberately modal rather than "click does whatever seems sensible". Drawing a
 * centerline and dragging an existing vertex both start with a mousedown on the map, and
 * guessing between them gets it wrong exactly when the user is being precise.
 */
export type Tool = 'select' | 'draw' | 'measure';

/**
 * Which cross-section a newly drawn street gets. A template id, or DRAFT_SECTION to use
 * whatever is currently open in the Asset Builder — which is the link between the two
 * pages: compose a section, then draw it onto the map.
 */
export const DRAFT_SECTION = 'draft';

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
  /** Names the downloaded file and is written into its metadata. Not undoable. */
  projectName: string;
  units: DisplayUnits;
  basemapId: BasemapId;
  customTileUrl: string;
  waybackRelease: string;
  arcgisApiKey: string;

  // ---- tools
  tool: Tool;
  drawSectionId: string;

  // ---- selection
  selectedStreetId: string | null;
  selectedComponentId: string | null;

  /** Swipe divider position, 0..1 across the map. null = off. */
  swipe: number | null;

  past: Snapshot[];
  future: Snapshot[];
  notice: Notice | null;

  // ---- chrome actions
  setProjectName: (name: string) => void;
  setUnits: (units: DisplayUnits) => void;
  setBasemap: (id: BasemapId) => void;
  setCustomTileUrl: (url: string) => void;
  setWaybackRelease: (release: string) => void;
  setArcgisApiKey: (key: string) => void;
  setSwipe: (value: number | null) => void;
  setNotice: (notice: Notice | null) => void;

  // ---- tool actions
  setTool: (tool: Tool) => void;
  setDrawSectionId: (id: string) => void;

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

  /** Create a street from a freshly drawn centerline. Returns its id. */
  addStreet: (centerline: [number, number][], name?: string) => string;
  renameStreet: (streetId: string, name: string) => void;
  toggleStreetVisible: (streetId: string) => void;
  duplicateStreet: (streetId: string) => void;
  loadStreets: (streets: Street[]) => void;

  // ---- centerline vertex editing
  removeVertex: (streetId: string, index: number) => void;
  /** Insert a vertex WITHOUT recording history — see beginGesture. */
  insertVertexLive: (streetId: string, afterIndex: number, point: [number, number]) => void;
  /** Move a vertex WITHOUT recording history — see beginGesture. */
  moveVertexLive: (streetId: string, index: number, point: [number, number]) => void;

  /**
   * Bracket a continuous gesture so a 200-frame drag becomes one undo step.
   *
   * beginGesture captures the state before the drag; endGesture pushes exactly that one
   * snapshot. Committing per frame would bury every other edit under a wall of history,
   * and committing only at the end would record the already-dragged state as "before".
   */
  beginGesture: () => void;
  endGesture: () => void;

  undo: () => void;
  redo: () => void;
}

const initialStreets = createDemoStreets();

/**
 * Copy a section with fresh component ids.
 *
 * Placing the Asset Builder draft on a street must not alias it — otherwise editing the
 * street's widths would silently rewrite the draft, and two streets from the same draft
 * would share component ids and select as one.
 */
export function cloneSection(section: CrossSection, name?: string): CrossSection {
  return {
    id: newId('sec'),
    name: name ?? section.name,
    anchorOffsetMeters: section.anchorOffsetMeters,
    components: section.components.map((c) => ({ ...c, id: newId('cmp') })),
  };
}

export const useEditorStore = create<EditorState>((set, get) => {
  const snapshot = (): Snapshot => {
    const { streets, draftSection } = get();
    return { streets, draftSection };
  };

  /** Captured at gesture start; null when no gesture is in flight. */
  let gestureBefore: Snapshot | null = null;

  const editStreet = (streetId: string, fn: (street: Street) => Street) =>
    get().streets.map((s) => (s.id === streetId ? fn(s) : s));

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
    projectName: 'Untitled project',
    units: 'ft',
    basemapId: 'usgsNaip',
    customTileUrl: '',
    waybackRelease: DEFAULT_VINTAGE,
    arcgisApiKey: '',

    streets: initialStreets,
    draftSection: instantiateTemplate(TEMPLATES[1]!),

    tool: 'select',
    drawSectionId: TEMPLATES[1]!.id,

    selectedStreetId: initialStreets[0]?.id ?? null,
    selectedComponentId: null,
    // Demo opens with the swipe on, so the redesign reads against the real street.
    swipe: 0.5,

    past: [],
    future: [],
    notice: null,

    setProjectName: (projectName) => set({ projectName }),
    setUnits: (units) => set({ units }),
    setBasemap: (basemapId) => set({ basemapId }),
    setCustomTileUrl: (customTileUrl) => set({ customTileUrl }),
    setWaybackRelease: (waybackRelease) => set({ waybackRelease }),
    setArcgisApiKey: (arcgisApiKey) => set({ arcgisApiKey }),
    setSwipe: (swipe) => set({ swipe }),
    setNotice: (notice) => set({ notice }),

    setTool: (tool) => set({ tool }),
    setDrawSectionId: (drawSectionId) => set({ drawSectionId }),

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

    addStreet: (centerline, name) => {
      const { streets, drawSectionId, draftSection } = get();
      const template = TEMPLATES.find((t) => t.id === drawSectionId);
      const section =
        drawSectionId === DRAFT_SECTION || !template
          ? cloneSection(draftSection)
          : instantiateTemplate(template);

      const street: Street = {
        id: newId('st'),
        name: name ?? `Street ${streets.length + 1}`,
        centerline,
        section,
        visible: true,
      };

      commit({ streets: [...streets, street] });
      // Drop straight back to select so the new street can be adjusted immediately —
      // staying in draw mode makes the next stray click start another street.
      set({ selectedStreetId: street.id, selectedComponentId: null, tool: 'select' });
      return street.id;
    },

    renameStreet: (streetId, name) =>
      commit({ streets: editStreet(streetId, (s) => ({ ...s, name })) }),

    toggleStreetVisible: (streetId) =>
      commit({ streets: editStreet(streetId, (s) => ({ ...s, visible: !s.visible })) }),

    duplicateStreet: (streetId) => {
      const source = get().streets.find((s) => s.id === streetId);
      if (!source) return;
      const copy: Street = {
        ...source,
        id: newId('st'),
        name: `${source.name} copy`,
        centerline: source.centerline.map((p) => [p[0], p[1]] as [number, number]),
        section: cloneSection(source.section),
      };
      commit({ streets: [...get().streets, copy] });
      set({ selectedStreetId: copy.id, selectedComponentId: null });
    },

    loadStreets: (streets) => {
      commit({ streets });
      set({ selectedStreetId: streets[0]?.id ?? null, selectedComponentId: null });
    },

    insertVertexLive: (streetId, afterIndex, point) =>
      set({
        streets: editStreet(streetId, (s) => {
          const centerline = [...s.centerline];
          centerline.splice(afterIndex + 1, 0, point);
          return { ...s, centerline };
        }),
      }),

    removeVertex: (streetId, index) => {
      const street = get().streets.find((s) => s.id === streetId);
      // Two points is the minimum that still describes a direction to offset from.
      if (!street || street.centerline.length <= 2) return;
      commit({
        streets: editStreet(streetId, (s) => ({
          ...s,
          centerline: s.centerline.filter((_, i) => i !== index),
        })),
      });
    },

    moveVertexLive: (streetId, index, point) =>
      set({
        streets: editStreet(streetId, (s) => {
          const centerline = [...s.centerline];
          if (index < 0 || index >= centerline.length) return s;
          centerline[index] = point;
          return { ...s, centerline };
        }),
      }),

    beginGesture: () => {
      gestureBefore = snapshot();
    },

    endGesture: () => {
      if (!gestureBefore) return;
      const before = gestureBefore;
      gestureBefore = null;
      // A gesture that ended where it started is not an edit worth undoing.
      if (before.streets === get().streets) return;
      set({ past: [...get().past, before].slice(-HISTORY_LIMIT), future: [] });
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

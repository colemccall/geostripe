import { create } from 'zustand';
import type { ComponentType, Direction } from '../library/primitives';
import { PRIMITIVES } from '../library/primitives';
import { TEMPLATES, instantiateTemplate } from '../library/templates';
import type { Area, CrossSection, SectionComponent, Street } from '../model/types';
import { newId } from '../model/types';
import { autoAnchorOffset, geometricCentreOffset } from '../model/section';
import type { DisplayUnits } from '../lib/units';
import type { BasemapId } from '../map/basemaps';
import { DEFAULT_VINTAGE } from '../map/basemaps';
import { createDemoStreets } from '../demo/washingtonPark';
import { DEFAULT_CORNER_RADIUS_METRES } from '../geo/intersection';
import type { CornerOverride, JunctionOverride, LegOverride } from '../geo/derived';
import { DEFAULT_CURVE } from '../geo/curve';
import { LANDCOVERS } from '../library/landcover';
import type { LandcoverType } from '../library/landcover';
import type { CurveSettings } from '../geo/curve';

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
export type Tool = 'select' | 'draw' | 'area' | 'measure';

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
  areas: Area[];
  draftSection: CrossSection;
  /**
   * Per-junction customisation, keyed by the junction's stable key.
   *
   * Junctions themselves are derived — detected wherever centerlines cross — so there is
   * nothing to keep in sync when a street moves. Only the overrides are stored, and only
   * for junctions somebody has actually touched, which is why this is a sparse map rather
   * than a list of junction records.
   */
  junctionOverrides: Record<string, JunctionOverride>;
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

  // ---- junctions
  selectedJunctionKey: string | null;
  defaultCornerRadiusMeters: number;
  trimAtJunctions: boolean;
  /**
   * Slack on the radius at which nearby crossings become one junction.
   *
   * A view setting, not part of the document: it changes how the same streets are read,
   * the way the trim toggle does, and putting it in the undo history would mean nudging a
   * slider buried every real edit behind it.
   */
  junctionMergeSlackMeters: number;

  // ---- selection
  selectedStreetId: string | null;
  selectedAreaId: string | null;
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

  // ---- junction actions
  selectJunction: (key: string | null) => void;
  setDefaultCornerRadius: (metres: number) => void;
  setTrimAtJunctions: (value: boolean) => void;
  setJunctionMergeSlack: (metres: number) => void;
  /** Merge a patch into one corner's settings. A field left out is left alone. */
  updateCorner: (key: string, cornerIndex: number, patch: Partial<CornerOverride>) => void;
  /** Merge a patch into one leg's settings. */
  updateLeg: (key: string, legIndex: number, patch: Partial<LegOverride>) => void;
  resetJunction: (key: string) => void;

  // ---- selection actions
  selectStreet: (id: string | null) => void;
  selectComponent: (id: string | null) => void;

  // ---- section editing, on either target
  addComponent: (target: EditTarget, type: ComponentType, index?: number) => void;
  removeComponent: (target: EditTarget, id: string) => void;
  setWidth: (target: EditTarget, id: string, metres: number) => void;
  setDirection: (target: EditTarget, id: string, direction: Direction) => void;
  /**
   * The paint on one band: its repeating symbol and the stripe on its left edge.
   *
   * A patch rather than three setters, because these three fields are always edited from
   * the same panel and a caller that sets one usually clears another — `glyph: undefined`
   * has to be expressible, and `undefined` means "back to the type's default" while
   * `'none'` means "deliberately bare".
   */
  setComponentMarkings: (
    target: EditTarget,
    id: string,
    patch: Pick<Partial<SectionComponent>, 'glyph' | 'glyphSpacingMeters' | 'stripeLeft'>,
  ) => void;
  moveComponent: (target: EditTarget, id: string, delta: number) => void;
  setAnchorMode: (target: EditTarget, mode: AnchorMode) => void;
  renameSection: (target: EditTarget, name: string) => void;
  applyTemplate: (target: EditTarget, templateId: string) => void;
  /**
   * Scale every component so the section totals `metres`.
   *
   * The answer to tracing a real street and finding the bands narrower than the pavement
   * underneath: measure the kerb-to-kerb width, then make the section match it. Scaling
   * proportionally keeps the relative design intact, which is what someone reaching for
   * this wants — they are correcting the overall size, not redesigning the street.
   */
  fitSectionToWidth: (target: EditTarget, metres: number) => void;
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
  /** 0 at grade, +1 overpass, -1 tunnel. */
  setStreetLevel: (streetId: string, level: number) => void;
  toggleStreetVisible: (streetId: string) => void;
  duplicateStreet: (streetId: string) => void;
  loadStreets: (
    streets: Street[],
    junctionOverrides?: Record<string, JunctionOverride>,
    areas?: Area[],
  ) => void;

  // ---- areas
  addArea: (ring: [number, number][], landcover?: LandcoverType) => string;
  selectArea: (id: string | null) => void;
  renameArea: (areaId: string, name: string) => void;
  setAreaLandcover: (areaId: string, landcover: LandcoverType) => void;
  setAreaCurve: (areaId: string, patch: Partial<CurveSettings>) => void;
  toggleAreaVisible: (areaId: string) => void;
  duplicateArea: (areaId: string) => void;
  removeArea: (areaId: string) => void;
  /** Vertex editing, mirroring the street methods. */
  moveAreaVertexLive: (areaId: string, index: number, point: [number, number]) => void;
  insertAreaVertexLive: (areaId: string, afterIndex: number, point: [number, number]) => void;
  removeAreaVertex: (areaId: string, index: number) => void;
  toggleAreaSharpVertex: (areaId: string, index: number) => void;
  /** The land type a newly drawn area gets. */
  drawLandcover: LandcoverType;
  setDrawLandcover: (type: LandcoverType) => void;

  // ---- curves
  setCurve: (streetId: string, patch: Partial<CurveSettings>) => void;
  /** Pin or release one control point as a hard corner. */
  toggleSharpVertex: (streetId: string, index: number) => void;

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
    const { streets, areas, draftSection, junctionOverrides } = get();
    return { streets, areas, draftSection, junctionOverrides };
  };

  /** Captured at gesture start; null when no gesture is in flight. */
  let gestureBefore: Snapshot | null = null;

  const editStreet = (streetId: string, fn: (street: Street) => Street) =>
    get().streets.map((s) => (s.id === streetId ? fn(s) : s));

  const editArea = (areaId: string, fn: (area: Area) => Area) =>
    get().areas.map((a) => (a.id === areaId ? fn(a) : a));

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
    areas: [],
    draftSection: instantiateTemplate(TEMPLATES[1]!),
    junctionOverrides: {},

    tool: 'select',
    drawSectionId: TEMPLATES[1]!.id,

    selectedJunctionKey: null,
    defaultCornerRadiusMeters: DEFAULT_CORNER_RADIUS_METRES,
    trimAtJunctions: true,
    junctionMergeSlackMeters: 0,

    selectedStreetId: initialStreets[0]?.id ?? null,
    selectedAreaId: null,
    drawLandcover: 'grass',
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

    selectJunction: (selectedJunctionKey) => set({ selectedJunctionKey }),
    setDefaultCornerRadius: (defaultCornerRadiusMeters) => set({ defaultCornerRadiusMeters }),
    setTrimAtJunctions: (trimAtJunctions) => set({ trimAtJunctions }),
    setJunctionMergeSlack: (junctionMergeSlackMeters) => set({ junctionMergeSlackMeters }),

    updateCorner: (key, cornerIndex, patch) => {
      const existing = get().junctionOverrides[key];
      const corners = [...(existing?.corners ?? [])];
      while (corners.length <= cornerIndex) corners.push(null);
      corners[cornerIndex] = { ...(corners[cornerIndex] ?? {}), ...patch };
      commit({
        junctionOverrides: { ...get().junctionOverrides, [key]: { ...existing, corners } },
      });
    },

    updateLeg: (key, legIndex, patch) => {
      const existing = get().junctionOverrides[key];
      const legs = [...(existing?.legs ?? [])];
      while (legs.length <= legIndex) legs.push(null);
      legs[legIndex] = { ...(legs[legIndex] ?? {}), ...patch };
      commit({
        junctionOverrides: { ...get().junctionOverrides, [key]: { ...existing, legs } },
      });
    },

    resetJunction: (key) => {
      const next = { ...get().junctionOverrides };
      delete next[key];
      commit({ junctionOverrides: next });
    },

    selectStreet: (selectedStreetId) =>
      set({
        selectedStreetId,
        selectedComponentId: null,
        selectedJunctionKey: null,
        selectedAreaId: null,
      }),
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

    setComponentMarkings: (target, id, patch) =>
      editComponents(target, (components) =>
        components.map((c) => {
          if (c.id !== id) return c;
          const next = { ...c, ...patch };
          // An explicitly undefined key has to actually leave the object, or "back to the
          // default" would serialise as the value it was overriding.
          for (const key of ['glyph', 'glyphSpacingMeters', 'stripeLeft'] as const) {
            if (key in patch && patch[key] === undefined) delete next[key];
          }
          return next;
        }),
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

    fitSectionToWidth: (target, metres) =>
      editSection(target, (section) => {
        const current = section.components.reduce((sum, c) => sum + c.widthMeters, 0);
        if (current <= 0 || metres <= 0) return section;
        const factor = metres / current;
        return {
          ...section,
          components: section.components.map((c) => ({
            ...c,
            widthMeters: Number((c.widthMeters * factor).toFixed(4)),
          })),
          // An explicit anchor was measured against the old widths, so it has to scale too.
          anchorOffsetMeters:
            section.anchorOffsetMeters === null ? null : section.anchorOffsetMeters * factor,
        };
      }),

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
      commit({ streets: [], areas: [] });
      set({ selectedStreetId: null, selectedComponentId: null, selectedAreaId: null });
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

    setStreetLevel: (streetId, level) =>
      commit({ streets: editStreet(streetId, (s) => ({ ...s, level })) }),

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

    loadStreets: (streets, junctionOverrides = {}, areas = []) => {
      commit({ streets, junctionOverrides, areas });
      set({
        selectedStreetId: streets[0]?.id ?? null,
        selectedComponentId: null,
        selectedJunctionKey: null,
        selectedAreaId: null,
      });
    },

    insertVertexLive: (streetId, afterIndex, point) =>
      set({
        streets: editStreet(streetId, (s) => {
          const centerline = [...s.centerline];
          centerline.splice(afterIndex + 1, 0, point);
          return { ...s, centerline };
        }),
      }),

    setDrawLandcover: (drawLandcover) => set({ drawLandcover }),

    addArea: (ring, landcoverType) => {
      const { areas, drawLandcover } = get();
      const type = landcoverType ?? drawLandcover;
      const area: Area = {
        id: newId('ar'),
        name: `${LANDCOVERS[type].label} ${areas.length + 1}`,
        landcover: type,
        ring,
        visible: true,
      };
      commit({ areas: [...areas, area] });
      // Straight back to select, for the same reason drawing a street does: staying in
      // draw mode makes the next stray click start another one.
      set({ selectedAreaId: area.id, selectedStreetId: null, tool: 'select' });
      return area.id;
    },

    selectArea: (selectedAreaId) =>
      set({ selectedAreaId, selectedStreetId: null, selectedJunctionKey: null }),

    renameArea: (areaId, name) => commit({ areas: editArea(areaId, (a) => ({ ...a, name })) }),

    setAreaLandcover: (areaId, landcoverType) =>
      commit({ areas: editArea(areaId, (a) => ({ ...a, landcover: landcoverType })) }),

    setAreaCurve: (areaId, patch) =>
      commit({
        areas: editArea(areaId, (a) => ({
          ...a,
          curve: { ...DEFAULT_CURVE, ...a.curve, ...patch },
        })),
      }),

    toggleAreaVisible: (areaId) =>
      commit({ areas: editArea(areaId, (a) => ({ ...a, visible: !a.visible })) }),

    duplicateArea: (areaId) => {
      const source = get().areas.find((a) => a.id === areaId);
      if (!source) return;
      const copy: Area = {
        ...source,
        id: newId('ar'),
        name: `${source.name} copy`,
        ring: source.ring.map((p) => [p[0], p[1]] as [number, number]),
      };
      commit({ areas: [...get().areas, copy] });
      set({ selectedAreaId: copy.id });
    },

    removeArea: (areaId) => {
      commit({ areas: get().areas.filter((a) => a.id !== areaId) });
      if (get().selectedAreaId === areaId) set({ selectedAreaId: null });
    },

    moveAreaVertexLive: (areaId, index, point) =>
      set({
        areas: editArea(areaId, (a) => {
          if (index < 0 || index >= a.ring.length) return a;
          const ring = [...a.ring];
          ring[index] = point;
          return { ...a, ring };
        }),
      }),

    insertAreaVertexLive: (areaId, afterIndex, point) =>
      set({
        areas: editArea(areaId, (a) => {
          const ring = [...a.ring];
          ring.splice(afterIndex + 1, 0, point);
          return { ...a, ring };
        }),
      }),

    removeAreaVertex: (areaId, index) => {
      const area = get().areas.find((a) => a.id === areaId);
      // Three points is the minimum that still encloses anything.
      if (!area || area.ring.length <= 3) return;
      commit({
        areas: editArea(areaId, (a) => ({ ...a, ring: a.ring.filter((_, i) => i !== index) })),
      });
    },

    toggleAreaSharpVertex: (areaId, index) =>
      commit({
        areas: editArea(areaId, (a) => {
          const curve = { ...DEFAULT_CURVE, ...a.curve };
          const sharp = new Set(curve.sharpVertices ?? []);
          if (sharp.has(index)) sharp.delete(index);
          else sharp.add(index);
          return { ...a, curve: { ...curve, sharpVertices: [...sharp].sort((x, y) => x - y) } };
        }),
      }),

    setCurve: (streetId, patch) =>
      commit({
        streets: editStreet(streetId, (s) => ({
          ...s,
          curve: { ...DEFAULT_CURVE, ...s.curve, ...patch },
        })),
      }),

    toggleSharpVertex: (streetId, index) =>
      commit({
        streets: editStreet(streetId, (s) => {
          const curve = { ...DEFAULT_CURVE, ...s.curve };
          const sharp = new Set(curve.sharpVertices ?? []);
          if (sharp.has(index)) sharp.delete(index);
          else sharp.add(index);
          return { ...s, curve: { ...curve, sharpVertices: [...sharp].sort((a, b) => a - b) } };
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

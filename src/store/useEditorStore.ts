import { create } from 'zustand';
import type { ComponentType, Direction } from '../library/primitives';
import { PRIMITIVES } from '../library/primitives';
import { assetMap, defaultAreaAssetId, defaultLineAssetId } from '../library/assets';
import { duplicateAsset, isLineAsset, newAssetId } from '../model/asset';
import type { Asset, AssetFamily, LineAsset } from '../model/asset';
import {
  addArea,
  addNode,
  addSegment,
  emptyDoc,
  mergeNodes,
  moveNode,
  removeArea,
  removeNode,
  removeSegment,
  splitPointFor,
  splitSegment,
} from '../model/doc';
import type { Doc, Segment, Snap } from '../model/doc';
import { newId } from '../model/types';
import type { SectionComponent } from '../model/types';
import { autoAnchorOffset, geometricCentreOffset, totalWidth } from '../model/section';
import { DEFAULT_CURVE } from '../geo/curve';
import type { CurveSettings } from '../geo/curve';
import type { LngLat } from '../geo/projection';
import type { DisplayUnits } from '../lib/units';
import type { BasemapId } from '../map/basemaps';
import { DEFAULT_VINTAGE } from '../map/basemaps';
import { loadDemo } from '../demo';
import type { DemoId } from '../demo';
import { allLayersVisible } from '../map/layerGroups';
import type { LayerGroupId } from '../map/layerGroups';

/**
 * Editor state.
 *
 * One document, one palette, and undo over both. The previous store carried two models at
 * once — long polyline streets with detected junctions, and a node-and-segment graph — plus
 * the overrides, near-miss reports and mode switches needed to keep them from contradicting
 * each other. Most of what is gone from this file is not a feature; it is the cost of
 * having had two answers to the same question.
 *
 * Undo is snapshots rather than patches. A document is a few thousand small objects and
 * copying the arrays is free, while a mis-applied patch drifts silently. The snapshot
 * covers the ASSETS as well as the geometry, because editing an asset changes every road
 * using it — an undo that put the road back but not its width would be worse than none.
 */

const HISTORY_LIMIT = 100;

/**
 * The active tool.
 *
 * Deliberately modal, and deliberately short. A road-building game has three verbs — build
 * it, look at it, knock it down — and the editor now has the same three, plus a shape tool
 * for the ground. What used to be six tools was mostly the old model asking for help:
 * a tool to place intersections the detector had missed, and one to measure a road so the
 * fit check had a number.
 */
export type Tool = 'select' | 'build' | 'area' | 'bulldoze';

export interface Notice {
  kind: 'error' | 'success' | 'warning';
  title: string;
  details?: string[];
}

/**
 * Everything undo restores.
 *
 * Selection is deliberately outside it. Selecting is looking, not editing, and an undo
 * that spends itself putting a selection back is an undo the user has to press twice.
 */
interface Snapshot {
  doc: Doc;
  assets: Asset[];
}

export interface EditorState extends Snapshot {
  // ----------------------------------------------------------------- project & chrome
  projectName: string;
  units: DisplayUnits;
  basemapId: BasemapId;
  customTileUrl: string;
  waybackRelease: string;
  arcgisApiKey: string;
  layerVisibility: Record<LayerGroupId, boolean>;
  imageryOpacity: number;
  railOpen: boolean;
  swipe: number | null;
  notice: Notice | null;

  // -------------------------------------------------------------------------- tools
  tool: Tool;
  /** The asset the build tool lays down. */
  activeLineAssetId: string;
  /** The asset the area tool fills with. */
  activeAreaAssetId: string;
  /**
   * The node the road under construction started from.
   *
   * Building is always node-to-node, so this is the whole of the in-flight state along with
   * the shape points collected since. Null means nothing is being built.
   */
  buildFromNodeId: string | null;
  /** Bends placed since the last node, which become the new segment's shape. */
  buildShape: LngLat[];
  /** Level the build tool lays at — Page Up and Page Down, as in the games. */
  buildLevel: number;
  curve: CurveSettings;
  /** Kerb radius for a node whose roads ask for nothing. */
  defaultRadiusMeters: number;
  showAllCenterlines: boolean;

  // ---------------------------------------------------------------------- selection
  selectedSegmentId: string | null;
  selectedNodeId: string | null;
  selectedAreaId: string | null;
  /** The asset open in the asset editor, which need not be one that is placed. */
  editingAssetId: string | null;
  selectedComponentId: string | null;
  recentAssetIds: string[];

  past: Snapshot[];
  future: Snapshot[];

  // ------------------------------------------------------------------------ actions
  setProjectName: (name: string) => void;
  setUnits: (units: DisplayUnits) => void;
  setBasemap: (id: BasemapId) => void;
  setCustomTileUrl: (url: string) => void;
  setWaybackRelease: (release: string) => void;
  setArcgisApiKey: (key: string) => void;
  setLayerVisible: (id: LayerGroupId, visible: boolean) => void;
  setImageryOpacity: (value: number) => void;
  setRailOpen: (open: boolean) => void;
  setSwipe: (value: number | null) => void;
  setNotice: (notice: Notice | null) => void;

  setTool: (tool: Tool) => void;
  setActiveAsset: (assetId: string) => void;
  setCurve: (curve: Partial<CurveSettings>) => void;
  setBuildLevel: (level: number) => void;
  setDefaultRadius: (metres: number) => void;
  setShowAllCenterlines: (value: boolean) => void;

  selectSegment: (id: string | null) => void;
  selectNode: (id: string | null) => void;
  selectArea: (id: string | null) => void;
  selectComponent: (id: string | null) => void;
  clearSelection: () => void;

  // building
  buildTo: (position: LngLat, snap?: Snap) => void;
  addBend: (position: LngLat) => void;
  cancelBuild: () => void;
  finishBuild: () => void;

  // editing what is there
  beginGesture: () => void;
  endGesture: () => void;
  moveNodeLive: (nodeId: string, position: LngLat) => void;
  moveShapePointLive: (segmentId: string, index: number, position: LngLat) => void;
  removeShapePoint: (segmentId: string, index: number) => void;
  insertShapePoint: (segmentId: string, index: number, position: LngLat) => void;
  setNodeRadius: (nodeId: string, metres: number | undefined) => void;
  renameNode: (nodeId: string, name: string) => void;
  joinNodes: (keepId: string, absorbId: string) => void;
  splitAt: (segmentId: string, position: LngLat) => string | null;
  setSegmentAsset: (segmentId: string, assetId: string) => void;
  setSegmentLevel: (segmentId: string, level: number) => void;
  reverseSegment: (segmentId: string) => void;
  setSegmentCurve: (segmentId: string, curve: CurveSettings) => void;
  bulldoze: (target: { segmentId?: string; nodeId?: string; areaId?: string }) => void;
  deleteSelection: () => void;

  // areas
  addAreaShape: (ring: LngLat[]) => string | null;
  setAreaAsset: (areaId: string, assetId: string) => void;

  // the palette
  editAsset: (assetId: string | null) => void;
  createAsset: (family: AssetFamily) => string;
  duplicateActiveAsset: (assetId: string) => string;
  renameAsset: (assetId: string, name: string) => void;
  removeAsset: (assetId: string) => void;
  setAssetFamily: (assetId: string, family: AssetFamily) => void;
  setAssetRadius: (assetId: string, metres: number | undefined) => void;
  addComponent: (assetId: string, type: ComponentType, index?: number) => void;
  removeComponent: (assetId: string, componentId: string) => void;
  duplicateComponent: (assetId: string, componentId: string) => void;
  moveComponent: (assetId: string, componentId: string, delta: number) => void;
  setComponentWidth: (assetId: string, componentId: string, metres: number) => void;
  setComponentDirection: (assetId: string, componentId: string, direction: Direction) => void;
  patchComponent: (
    assetId: string,
    componentId: string,
    patch: Partial<SectionComponent>,
  ) => void;
  mirrorAsset: (assetId: string) => void;
  setAssetAnchor: (assetId: string, mode: AnchorMode) => void;

  // whole-project
  loadProject: (doc: Doc, assets: Asset[], name: string) => void;
  openDemo: (id: DemoId) => void;
  clearProject: () => void;
  undo: () => void;
  redo: () => void;
}

export type AnchorMode = 'travelway' | 'geometric' | 'leftEdge';

const RECENT_LIMIT = 8;

export const useEditorStore = create<EditorState>((set, get) => {
  /** Captured at gesture start; null when no drag is in flight. */
  let gestureBefore: Snapshot | null = null;

  const snapshot = (): Snapshot => ({ doc: get().doc, assets: get().assets });

  const commit = (next: Partial<Snapshot>) => {
    const previous = snapshot();
    set({
      ...next,
      past: [...get().past, previous].slice(-HISTORY_LIMIT),
      future: [],
    });
  };

  /**
   * Change one asset.
   *
   * Every asset edit funnels through here, which is what makes "edit the type, and every
   * road of that type follows" true by construction rather than by remembering to do it.
   */
  const editAssetById = (assetId: string, fn: (asset: Asset) => Asset) => {
    commit({
      assets: get().assets.map((a) => {
        if (a.id !== assetId) return a;
        const next = fn(a);
        // `builtIn` means "still exactly as shipped", not "came from the shipped set". Once
        // it has been changed the reader's own copy is no longer a safe substitute, so the
        // flag goes and the project file starts carrying this asset itself.
        if (next.builtIn) delete next.builtIn;
        return next;
      }),
    });
  };

  const editLineAsset = (assetId: string, fn: (asset: LineAsset) => LineAsset) => {
    editAssetById(assetId, (asset) => (isLineAsset(asset) ? fn(asset) : asset));
  };

  const editComponents = (
    assetId: string,
    fn: (components: SectionComponent[]) => SectionComponent[],
  ) => editLineAsset(assetId, (asset) => ({ ...asset, components: fn(asset.components) }));

  const editSegment = (segmentId: string, fn: (segment: Segment) => Segment) => {
    commit({
      doc: {
        ...get().doc,
        segments: get().doc.segments.map((s) => (s.id === segmentId ? fn(s) : s)),
      },
    });
  };

  const noteRecent = (assetId: string) => {
    const recent = [assetId, ...get().recentAssetIds.filter((id) => id !== assetId)];
    set({ recentAssetIds: recent.slice(0, RECENT_LIMIT) });
  };

  // The editor opens on a real project rather than a blank map. An empty editor asks the
  // user to invent a place to stand before it has shown them anything.
  const initial = loadDemo('i75');
  const startingAssets = initial.assets;

  return {
    doc: initial.doc,
    assets: startingAssets,

    projectName: initial.name,
    units: 'ft',
    basemapId: 'usgsNaip',
    customTileUrl: '',
    waybackRelease: DEFAULT_VINTAGE,
    arcgisApiKey: '',
    layerVisibility: allLayersVisible(),
    imageryOpacity: 1,
    railOpen: true,
    swipe: null,
    notice: null,

    tool: 'select',
    activeLineAssetId: defaultLineAssetId(startingAssets),
    activeAreaAssetId: defaultAreaAssetId(startingAssets),
    buildFromNodeId: null,
    buildShape: [],
    buildLevel: 0,
    curve: DEFAULT_CURVE,
    defaultRadiusMeters: 6,
    showAllCenterlines: false,

    selectedSegmentId: null,
    selectedNodeId: null,
    selectedAreaId: null,
    editingAssetId: null,
    selectedComponentId: null,
    recentAssetIds: [],

    past: [],
    future: [],

    // ------------------------------------------------------------------- chrome
    setProjectName: (projectName) => set({ projectName }),
    setUnits: (units) => set({ units }),
    setBasemap: (basemapId) => set({ basemapId }),
    setCustomTileUrl: (customTileUrl) => set({ customTileUrl }),
    setWaybackRelease: (waybackRelease) => set({ waybackRelease }),
    setArcgisApiKey: (arcgisApiKey) => set({ arcgisApiKey }),
    setLayerVisible: (id, visible) =>
      set({ layerVisibility: { ...get().layerVisibility, [id]: visible } }),
    setImageryOpacity: (imageryOpacity) => set({ imageryOpacity }),
    setRailOpen: (railOpen) => set({ railOpen }),
    setSwipe: (swipe) => set({ swipe }),
    setNotice: (notice) => set({ notice }),

    // -------------------------------------------------------------------- tools
    setTool: (tool) => {
      // Leaving the build tool abandons whatever was half-drawn. Keeping it would mean the
      // next click on a different tool silently finished a road the user had moved on from.
      set({ tool, buildFromNodeId: null, buildShape: [] });
    },

    setActiveAsset: (assetId) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset) return;
      noteRecent(assetId);
      if (asset.kind === 'area') {
        set({ activeAreaAssetId: assetId, tool: 'area' });
      } else {
        set({ activeLineAssetId: assetId, tool: 'build' });
      }
    },

    setCurve: (patch) => set({ curve: { ...get().curve, ...patch } }),
    setBuildLevel: (buildLevel) => set({ buildLevel }),
    setDefaultRadius: (defaultRadiusMeters) => set({ defaultRadiusMeters }),
    setShowAllCenterlines: (showAllCenterlines) => set({ showAllCenterlines }),

    // ---------------------------------------------------------------- selection
    selectSegment: (selectedSegmentId) =>
      set({ selectedSegmentId, selectedNodeId: null, selectedAreaId: null }),
    selectNode: (selectedNodeId) =>
      set({ selectedNodeId, selectedSegmentId: null, selectedAreaId: null }),
    selectArea: (selectedAreaId) =>
      set({ selectedAreaId, selectedSegmentId: null, selectedNodeId: null }),
    selectComponent: (selectedComponentId) => set({ selectedComponentId }),
    clearSelection: () =>
      set({ selectedSegmentId: null, selectedNodeId: null, selectedAreaId: null }),

    // ----------------------------------------------------------------- building
    /**
     * Extend the road under construction to here.
     *
     * One call covers every case, because in this model they are the same case: land on a
     * node and use it, land on a road and split it, land on open ground and make a node.
     * The old editor needed a separate tool for placing intersections precisely because
     * clicking on a road could not mean "join here".
     */
    buildTo: (position, snap) => {
      const { doc, buildFromNodeId, buildShape, activeLineAssetId, buildLevel, curve } = get();
      let next = doc;
      let nodeId: string;

      if (snap?.kind === 'node') {
        nodeId = snap.nodeId;
      } else if (snap?.kind === 'segment') {
        const split = splitSegment(next, snap.segmentId, snap.position, snap.shapeIndex);
        if (!split) return;
        next = split.doc;
        nodeId = split.nodeId;
      } else {
        const added = addNode(next, position);
        next = added.doc;
        nodeId = added.nodeId;
      }

      // The first click of a road only sets where it starts.
      if (!buildFromNodeId) {
        commit({ doc: next });
        set({ buildFromNodeId: nodeId, buildShape: [] });
        return;
      }

      // A road from a node to itself is nothing. Keep the click as a restart rather than
      // silently doing nothing, which reads as the tool being broken.
      if (buildFromNodeId === nodeId) {
        set({ buildShape: [] });
        return;
      }

      const built = addSegment(next, {
        assetId: activeLineAssetId,
        fromNodeId: buildFromNodeId,
        toNodeId: nodeId,
        shape: buildShape,
        curve: curve.mode === 'straight' ? undefined : curve,
        level: buildLevel || undefined,
      });

      commit({ doc: built.doc });
      // Chain: the end of this road is the start of the next, which is how a run of blocks
      // gets drawn without re-clicking every junction.
      set({ buildFromNodeId: nodeId, buildShape: [], selectedSegmentId: built.segmentId });
      noteRecent(activeLineAssetId);
    },

    addBend: (position) => set({ buildShape: [...get().buildShape, position] }),
    cancelBuild: () => set({ buildFromNodeId: null, buildShape: [] }),
    finishBuild: () => set({ buildFromNodeId: null, buildShape: [] }),

    // ------------------------------------------------------------------ editing
    /**
     * Bracket a drag so the whole of it is one undo step.
     *
     * Without this, dragging a node across the map records a snapshot per mouse-move and
     * fills the history with a hundred entries nobody wants to step back through.
     */
    beginGesture: () => {
      gestureBefore = snapshot();
    },

    endGesture: () => {
      if (!gestureBefore) return;
      const before = gestureBefore;
      gestureBefore = null;
      if (before.doc === get().doc && before.assets === get().assets) return;
      set({ past: [...get().past, before].slice(-HISTORY_LIMIT), future: [] });
    },

    moveNodeLive: (nodeId, position) => set({ doc: moveNode(get().doc, nodeId, position) }),

    moveShapePointLive: (segmentId, index, position) =>
      set({
        doc: {
          ...get().doc,
          segments: get().doc.segments.map((s) =>
            s.id === segmentId
              ? { ...s, shape: s.shape.map((p, i) => (i === index ? position : p)) }
              : s,
          ),
        },
      }),

    removeShapePoint: (segmentId, index) =>
      editSegment(segmentId, (s) => ({ ...s, shape: s.shape.filter((_, i) => i !== index) })),

    insertShapePoint: (segmentId, index, position) =>
      editSegment(segmentId, (s) => ({
        ...s,
        shape: [...s.shape.slice(0, index), position, ...s.shape.slice(index)],
      })),

    setNodeRadius: (nodeId, metres) =>
      commit({
        doc: {
          ...get().doc,
          nodes: get().doc.nodes.map((n) => {
            if (n.id !== nodeId) return n;
            const next = { ...n };
            if (metres === undefined) delete next.radiusMeters;
            else next.radiusMeters = metres;
            return next;
          }),
        },
      }),

    renameNode: (nodeId, name) =>
      commit({
        doc: {
          ...get().doc,
          nodes: get().doc.nodes.map((n) => (n.id === nodeId ? { ...n, name } : n)),
        },
      }),

    joinNodes: (keepId, absorbId) => {
      commit({ doc: mergeNodes(get().doc, keepId, absorbId) });
      set({ selectedNodeId: keepId });
    },

    splitAt: (segmentId, position) => {
      const { doc } = get();
      const segment = doc.segments.find((s) => s.id === segmentId);
      if (!segment) return null;
      const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
      const at = splitPointFor(segment, nodes, position);
      if (!at) return null;
      const split = splitSegment(doc, segmentId, at.point, at.shapeIndex);
      if (!split) return null;
      commit({ doc: split.doc });
      set({ selectedNodeId: split.nodeId, selectedSegmentId: null });
      return split.nodeId;
    },

    setSegmentAsset: (segmentId, assetId) => {
      editSegment(segmentId, (s) => ({ ...s, assetId }));
      noteRecent(assetId);
    },

    setSegmentLevel: (segmentId, level) =>
      editSegment(segmentId, (s) => {
        const next = { ...s };
        if (level === 0) delete next.level;
        else next.level = level;
        return next;
      }),

    reverseSegment: (segmentId) =>
      editSegment(segmentId, (s) => {
        const next = { ...s };
        if (s.reversed) delete next.reversed;
        else next.reversed = true;
        return next;
      }),

    setSegmentCurve: (segmentId, curve) =>
      editSegment(segmentId, (s) => {
        const next = { ...s };
        if (curve.mode === 'straight') delete next.curve;
        else next.curve = curve;
        return next;
      }),

    bulldoze: ({ segmentId, nodeId, areaId }) => {
      const { doc } = get();
      if (segmentId) {
        commit({ doc: removeSegment(doc, segmentId) });
        set({ selectedSegmentId: null });
      } else if (nodeId) {
        commit({ doc: removeNode(doc, nodeId) });
        set({ selectedNodeId: null });
      } else if (areaId) {
        commit({ doc: removeArea(doc, areaId) });
        set({ selectedAreaId: null });
      }
    },

    deleteSelection: () => {
      const { selectedSegmentId, selectedNodeId, selectedAreaId } = get();
      get().bulldoze({
        segmentId: selectedSegmentId ?? undefined,
        nodeId: selectedNodeId ?? undefined,
        areaId: selectedAreaId ?? undefined,
      });
    },

    // -------------------------------------------------------------------- areas
    addAreaShape: (ring) => {
      if (ring.length < 3) return null;
      const { doc, activeAreaAssetId, curve } = get();
      const added = addArea(doc, {
        assetId: activeAreaAssetId,
        ring,
        curve: curve.mode === 'straight' ? undefined : curve,
      });
      commit({ doc: added.doc });
      set({ selectedAreaId: added.areaId });
      noteRecent(activeAreaAssetId);
      return added.areaId;
    },

    setAreaAsset: (areaId, assetId) =>
      commit({
        doc: {
          ...get().doc,
          areas: get().doc.areas.map((a) => (a.id === areaId ? { ...a, assetId } : a)),
        },
      }),

    // ------------------------------------------------------------------ palette
    editAsset: (editingAssetId) => set({ editingAssetId, selectedComponentId: null }),

    createAsset: (family) => {
      const id = newAssetId();
      const asset: Asset =
        family === 'area'
          ? { id, name: 'New ground', kind: 'area', family: 'area', material: 'grass' }
          : {
              id,
              name: 'New road',
              kind: 'line',
              family,
              components: [
                {
                  id: newId('c'),
                  componentType: 'travelLane',
                  widthMeters: PRIMITIVES.travelLane.defaultWidthMeters,
                  direction: 'forward',
                },
              ],
              anchorOffsetMeters: null,
            };
      commit({ assets: [...get().assets, asset] });
      set({ editingAssetId: id });
      return id;
    },

    duplicateActiveAsset: (assetId) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset) return assetId;
      const copy = duplicateAsset(asset);
      commit({ assets: [...get().assets, copy] });
      set({ editingAssetId: copy.id });
      return copy.id;
    },

    renameAsset: (assetId, name) => editAssetById(assetId, (asset) => ({ ...asset, name })),

    /**
     * Delete an asset, but never one still in the ground.
     *
     * A segment whose asset has gone cannot be drawn and cannot be repaired from the UI, so
     * this refuses rather than leaving the document referring to something absent.
     */
    removeAsset: (assetId) => {
      const { doc, assets } = get();
      const inUse =
        doc.segments.some((s) => s.assetId === assetId) ||
        doc.areas.some((a) => a.assetId === assetId);
      if (inUse) {
        set({
          notice: {
            kind: 'warning',
            title: 'That asset is still in use',
            details: ['Bulldoze what is built with it first, or change those roads to another asset.'],
          },
        });
        return;
      }
      commit({ assets: assets.filter((a) => a.id !== assetId) });
      if (get().editingAssetId === assetId) set({ editingAssetId: null });
    },

    setAssetFamily: (assetId, family) =>
      editAssetById(assetId, (asset) =>
        asset.kind === 'line' && family !== 'area' ? { ...asset, family } : asset,
      ),

    setAssetRadius: (assetId, metres) =>
      editLineAsset(assetId, (asset) => {
        const next = { ...asset };
        if (metres === undefined) delete next.cornerRadiusMeters;
        else next.cornerRadiusMeters = metres;
        return next;
      }),

    addComponent: (assetId, type, index) =>
      editComponents(assetId, (components) => {
        const component: SectionComponent = {
          id: newId('c'),
          componentType: type,
          widthMeters: PRIMITIVES[type].defaultWidthMeters,
          direction: PRIMITIVES[type].defaultDirection,
        };
        const at = index ?? components.length;
        return [...components.slice(0, at), component, ...components.slice(at)];
      }),

    removeComponent: (assetId, componentId) =>
      editComponents(assetId, (components) => components.filter((c) => c.id !== componentId)),

    duplicateComponent: (assetId, componentId) =>
      editComponents(assetId, (components) => {
        const at = components.findIndex((c) => c.id === componentId);
        if (at < 0) return components;
        const copy = { ...components[at]!, id: newId('c') };
        return [...components.slice(0, at + 1), copy, ...components.slice(at + 1)];
      }),

    moveComponent: (assetId, componentId, delta) =>
      editComponents(assetId, (components) => {
        const at = components.findIndex((c) => c.id === componentId);
        const to = at + delta;
        if (at < 0 || to < 0 || to >= components.length) return components;
        const next = [...components];
        const [moved] = next.splice(at, 1);
        next.splice(to, 0, moved!);
        return next;
      }),

    setComponentWidth: (assetId, componentId, metres) =>
      editComponents(assetId, (components) =>
        components.map((c) => (c.id === componentId ? { ...c, widthMeters: metres } : c)),
      ),

    setComponentDirection: (assetId, componentId, direction) =>
      editComponents(assetId, (components) =>
        components.map((c) => (c.id === componentId ? { ...c, direction } : c)),
      ),

    patchComponent: (assetId, componentId, patch) =>
      editComponents(assetId, (components) =>
        components.map((c) => (c.id === componentId ? { ...c, ...patch } : c)),
      ),

    /**
     * Flip an asset left to right.
     *
     * The anchor has to move with it or a mirrored asymmetric street jumps sideways: the
     * distance from the left edge to the line is now the distance from what used to be the
     * right edge. Deriving it afresh would be wrong for a section that pinned it.
     */
    mirrorAsset: (assetId) =>
      editLineAsset(assetId, (asset) => ({
        ...asset,
        components: [...asset.components].reverse(),
        anchorOffsetMeters:
          asset.anchorOffsetMeters === null
            ? null
            : totalWidth(asset.components) - asset.anchorOffsetMeters,
      })),

    setAssetAnchor: (assetId, mode) =>
      editLineAsset(assetId, (asset) => ({
        ...asset,
        anchorOffsetMeters:
          mode === 'travelway'
            ? null
            : mode === 'geometric'
              ? geometricCentreOffset(asset.components)
              : 0,
      })),

    // ---------------------------------------------------------------- project
    loadProject: (doc, assets, projectName) => {
      set({
        doc,
        assets,
        projectName,
        past: [],
        future: [],
        selectedSegmentId: null,
        selectedNodeId: null,
        selectedAreaId: null,
        buildFromNodeId: null,
        buildShape: [],
        activeLineAssetId: defaultLineAssetId(assets),
        activeAreaAssetId: defaultAreaAssetId(assets),
      });
    },

    openDemo: (id) => {
      const demo = loadDemo(id);
      get().loadProject(demo.doc, demo.assets, demo.name);
    },

    clearProject: () => {
      commit({ doc: emptyDoc() });
      set({
        selectedSegmentId: null,
        selectedNodeId: null,
        selectedAreaId: null,
        buildFromNodeId: null,
        buildShape: [],
      });
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
      const { past, future } = get();
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

/** The palette, indexed. Selector-shaped so components can subscribe to it directly. */
export const selectAssetMap = (state: EditorState): Map<string, Asset> => assetMap(state.assets);

/** The asset a segment is built from, or undefined if the document is inconsistent. */
export function assetForSegment(state: EditorState, segmentId: string): Asset | undefined {
  const segment = state.doc.segments.find((s) => s.id === segmentId);
  return segment ? state.assets.find((a) => a.id === segment.assetId) : undefined;
}

export { autoAnchorOffset };

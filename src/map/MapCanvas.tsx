import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AttributionControl,
  GeoJSONSource,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl';
import type { MapMouseEvent, PointLike, StyleSpecification } from 'maplibre-gl';
import type { Asset } from '../model/asset';
import type { Doc } from '../model/doc';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { basemapById, tileUrlsFor } from './basemaps';
import type { BasemapId, TileSourceOptions } from './basemaps';
import { designLayers, emptySources, paintDoc, paintPreview } from './paint';
import { renderAllGlyphs } from './glyphImages';
import type { PaintSources } from './paint';
import { HANDLES_FOR as HANDLES_FOR_MODE, useEditorStore } from '../store/useEditorStore';
import type { Tool } from '../store/useEditorStore';
import { assetMap } from '../library/assets';
import { joinCandidate, splitPointFor } from '../model/doc';
import type { Snap } from '../model/doc';
import { roadIssues } from '../model/validity';
import { applyView, VIEW_IMAGERY_FACTOR } from './views';
import { setPointer } from './pointer';
import { nearestRoadPoint } from '../geo/snapEngine';
import { bearingToFace } from '../model/buildings';
import { footprint } from '../model/buildings';
import { PLACEMENT_TEXT, placementIssues } from '../model/placement';
import { circle } from '../geo/region';
import { blockAt, findFaces } from '../model/blocks';
import type { Face } from '../model/blocks';
import { distanceMetres } from '../geo/crs';
import { buildSnapIndex, findSnaps } from '../geo/snapEngine';
import type { SnapCandidate, SnapContext, SnapIndex } from '../geo/snapEngine';
import { directionGuidesAt, guideLine, snapToGuides } from '../geo/snapping';
import { localPlane, metresPerPixel } from '../geo/crs';
import type { LngLat } from '../geo/crs';
import { LAYER_GROUPS } from './layerGroups';
import type { LayerGroupId } from './layerGroups';

/**
 * Point MapLibre at its own worker, copied verbatim into public/ by a prebuild script.
 *
 * Without this MapLibre resolves the worker relative to its own chunk, asks for a file
 * Rollup never emitted, and gets index.html back. The failure is silent and partial: raster
 * imagery keeps working because tiles load on the main thread, while every GeoJSON layer
 * stays invisible because those are parsed in the worker — so it reads as a geometry bug.
 * Vite's own `?worker&url` bundling does not fix it; the bundle loads and then never
 * answers. BASE_URL keeps it correct under a project path and a custom domain alike.
 */
setWorkerUrl(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`);

/**
 * The map, and every pointer gesture on it.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT THIS FILE DOES
 *
 * Two jobs, and deliberately no others:
 *
 *   1. Keep MapLibre's sources fed from the store. Everything drawn comes out of
 *      `paint.ts`; this file never computes geometry, it only pushes what paint produced.
 *   2. Turn pointer events into store actions. It decides WHAT a click meant, never what
 *      the document should become — that is the store's and the model's business.
 *
 * WHAT A CLICK MEANS
 *
 * The whole interaction model rests on a click being unambiguous. `snapAt` asks the
 * RENDERED map what is under the cursor, in that order of preference:
 *
 *   a node      → use it. Building here JOINS.
 *   a road      → use the point on it. Building here SPLITS it at that point.
 *   open ground → make a new node.
 *
 * Asked of the rendered map rather than of the model on purpose: "what is under the cursor"
 * is a question about pixels, and a tolerance in metres would be right at exactly one zoom.
 *
 * WHAT IS SHOWN BEFORE THE CLICK IS SPENT
 *
 * Three things, all on pointer move, because a tool you have to trust is worse than one you
 * can see:
 *
 *   the preview   the road under construction, at its REAL width, painted by the same
 *                 renderer that draws finished roads (`paintPreview`)
 *   the snap ring what the next click will attach to — amber for a node you would join,
 *                 teal for a road you would split
 *   the guide     the direction the road has been pulled onto, when leaving a junction
 *
 * WHY SO MANY REFS
 *
 * `hover`, `drag`, `areaRing`, `painted`, `styleKey` and `assetMapRef` are refs rather than
 * state because they change at pointer rate. Re-rendering React sixty times a second to
 * move a dashed line is how an editor starts feeling heavy for no reason; the map's sources
 * are updated directly instead.
 * ---------------------------------------------------------------------------------------
 */

/** How near, in screen pixels, a click has to be to snap to a node or a road. */
const SNAP_PX = 14;

/** Angle snapping increments while Shift is held. */
const SNAP_ANGLE_DEGREES = 15;

/**
 * How near a node has to be dropped on another to merge with it, in metres.
 *
 * Tighter than the reach used to SUGGEST a join, because dropping is an action and being
 * wrong about it costs an undo, while suggesting is only ever an offer.
 */
const MERGE_DROP_METRES = 12;

function buildStyle(basemapId: BasemapId, options: TileSourceOptions): StyleSpecification {
  const basemap = basemapById(basemapId);
  const tiles = tileUrlsFor(basemapId, options);

  return {
    version: 8,
    sources: tiles.length
      ? {
          basemap: {
            type: 'raster',
            tiles,
            tileSize: basemap.tileSize,
            maxzoom: basemap.maxzoom,
            attribution: basemap.attribution,
          },
        }
      : {},
    layers: tiles.length
      ? [
          {
            id: 'basemap',
            type: 'raster',
            source: 'basemap',
            // No cross-fade: it keeps both zoom levels of tiles alive and composites them,
            // which on imagery mostly reads as the map being slow to sharpen up.
            paint: { 'raster-fade-duration': 0 },
          },
        ]
      : [],
  } as StyleSpecification;
}

/** Sources the preview and the snap ring own, which are not part of a paint of the document. */
const LIVE_SOURCES = ['preview', 'snap'] as const;

const SOURCE_KEYS: (keyof PaintSources)[] = [
  'areas',
  'zones',
  'districts',
  'buildings',
  'bands',
  'stripes',
  'stamps',
  'shadows',
  'plates',
  'guides',
  'handles',
];

/**
 * Sources that need MapLibre to measure distance along the line.
 *
 * `line-gradient` is expressed against `line-progress`, and MapLibre only computes that when
 * the source asks for it. Without this the ramp shadow silently renders as nothing — the
 * layer is valid, so neither the style validator nor the console has anything to say.
 */
const LINE_METRICS_SOURCES: ReadonlySet<string> = new Set(['shadows']);

/** The rubber band: what the road under construction would look like if you clicked now. */
const DRAFT_SOURCE = 'draft';

function setData(map: MapLibreMap, id: string, data: FeatureCollection) {
  const source = map.getSource(id);
  if (source && 'setData' in source) (source as GeoJSONSource).setData(data);
}

const emptyFC = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

/** Feed every design source from one paint. */
function pushSources(map: MapLibreMap, sources: PaintSources) {
  for (const key of SOURCE_KEYS) setData(map, key, sources[key] as FeatureCollection);
}

/**
 * Install the design sources and layers. Idempotent, so it is safe after every setStyle.
 *
 * Each layer goes in independently: one invalid paint property must not abort the rest, or
 * a typo in a colour renders as bare imagery with no error anywhere on screen.
 */
function addDesign(map: MapLibreMap) {
  // Pavement symbols are images the symbol layer refers to by name. They have to be
  // registered before the layer that uses them, and again after any setStyle, because a
  // style change clears the image registry along with everything else.
  for (const glyph of renderAllGlyphs()) {
    if (!map.hasImage(glyph.id)) {
      map.addImage(glyph.id, glyph.data, { pixelRatio: 1 });
    }
  }

  for (const id of [...SOURCE_KEYS, ...LIVE_SOURCES, DRAFT_SOURCE]) {
    if (!map.getSource(id)) {
      map.addSource(id, {
        type: 'geojson',
        data: emptyFC(),
        lineMetrics: LINE_METRICS_SOURCES.has(id) || undefined,
      });
    }
  }

  for (const layer of designLayers()) {
    if (map.getLayer(layer.id)) continue;
    try {
      map.addLayer(layer);
    } catch (error) {
      console.error(`layer ${layer.id} failed`, error);
    }
  }

  if (!map.getLayer('draft-line')) {
    map.addLayer({
      id: 'draft-line',
      type: 'line',
      source: DRAFT_SOURCE,
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'invalid'], 1], '#D64545', '#4DA3FF'],
        'line-width': 2,
        'line-dasharray': [2, 2],
      },
    });
  }
  if (!map.getLayer('draft-point')) {
    map.addLayer({
      id: 'draft-point',
      type: 'circle',
      source: DRAFT_SOURCE,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#4DA3FF',
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#FFFFFF',
      },
    });
  }

  // Layers are created with their ordinary paint; put the current info view back on them.
  applyView(map, useEditorStore.getState().view);
}

export interface MapCanvasProps {
  className?: string;
}

export function MapCanvas({ className }: MapCanvasProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);

  const doc = useEditorStore((s) => s.doc);
  const assets = useEditorStore((s) => s.assets);
  const tool = useEditorStore((s) => s.tool);
  const selectedSegmentId = useEditorStore((s) => s.selectedSegmentId);
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId);
  const selectedAreaId = useEditorStore((s) => s.selectedAreaId);
  const showAllCenterlines = useEditorStore((s) => s.showAllCenterlines);
  const defaultRadiusMeters = useEditorStore((s) => s.defaultRadiusMeters);
  const buildFromNodeId = useEditorStore((s) => s.buildFromNodeId);
  const buildHandles = useEditorStore((s) => s.buildHandles);
  const basemapId = useEditorStore((s) => s.basemapId);
  const customTileUrl = useEditorStore((s) => s.customTileUrl);
  const waybackRelease = useEditorStore((s) => s.waybackRelease);
  const arcgisApiKey = useEditorStore((s) => s.arcgisApiKey);
  const imageryOpacity = useEditorStore((s) => s.imageryOpacity);
  const layerVisibility = useEditorStore((s) => s.layerVisibility);
  const view = useEditorStore((s) => s.view);

  /**
   * Live pointer position, for the rubber band.
   *
   * A ref rather than state: it changes on every mouse move, and re-rendering React at
   * pointer rate to draw one dashed line is the kind of thing that makes an editor feel
   * heavy for no reason. The map source is updated directly instead.
   */
  const hover = useRef<LngLat | null>(null);

  /** What is being dragged, if anything. Refs for the same reason. */
  const drag = useRef<
    | { kind: 'node'; nodeId: string }
    | { kind: 'shape'; segmentId: string; index: number }
    | { kind: 'stroke'; points: LngLat[] }
    | null
  >(null);

  const areaRing = useRef<LngLat[]>([]);
  /** The model index snapping queries, rebuilt only when the document or palette changes. */
  const snapCache = useRef<{ doc: Doc; assets: Asset[]; index: SnapIndex } | null>(null);
  /** What the last snap query landed on, so a click resolves to the position that was shown. */
  const lastSnap = useRef<SnapCandidate | null>(null);
  /** Which of several candidates under the cursor Tab has chosen, and where Tab was pressed. */
  const cycle = useRef({ index: 0, anchor: [0, 0] as [number, number] });
  const lastPointer = useRef<MapMouseEvent | null>(null);
  /** The blocks between roads, recomputed only when the document or palette changes. */
  const facesCache = useRef<{ doc: Doc; assets: Asset[]; faces: Face[] } | null>(null);

  /**
   * The palette, indexed, for the preview to paint with.
   *
   * A ref because the preview runs on every pointer move and rebuilding a map of a hundred
   * and eighty assets at pointer rate is real work for no reason. Refreshed whenever the
   * palette actually changes.
   */
  const assetMapRef = useRef(assetMap(assets));

  /**
   * The most recent paint, kept so the style can be refilled without waiting for the
   * document to change.
   *
   * `setStyle` throws away every source and layer, so switching imagery re-adds them empty
   * and the design would stay invisible until the next edit. The data has to be pushed
   * again from here rather than re-derived, because nothing about the document changed.
   */
  const painted = useRef<PaintSources>(emptySources());

  /**
   * The style the map is currently built with.
   *
   * Initialised to what the map was CREATED with, so the imagery effect does not rebuild
   * the style on its first run. That rebuild used to land in the middle of the first paint:
   * the data went into sources that `setStyle` then destroyed, and the map came up showing
   * bare imagery with the whole design missing.
   */
  const styleKey = useRef(
    JSON.stringify([basemapId, customTileUrl, waybackRelease, arcgisApiKey]),
  );

  // ------------------------------------------------------------------------ snapping

  /**
   * What a click at this point should attach to.
   *
   * Asked of the MODEL rather than of the rendered map: every candidate is measured in real
   * metres (the pixel reach is converted at this zoom and latitude), ranked by an explicit
   * priority per tool, and Tab steps through the ones that overlap. See geo/snapEngine.ts.
   *
   * Returning `undefined` means open ground, which is a real answer and not a failure. Some
   * candidates (a kerb, a ground-shape corner) are positions with no model operation behind
   * them; those leave `lastSnap` set and `resolvePoint` picks the position up from there.
   */
  const candidatesAt = useCallback((event: MapMouseEvent, context: SnapContext): SnapCandidate[] => {
    const map = mapRef.current;
    if (!map || event.originalEvent.altKey) return [];
    const state = useEditorStore.getState();
    let cache = snapCache.current;
    if (!cache || cache.doc !== state.doc || cache.assets !== state.assets) {
      cache = {
        doc: state.doc,
        assets: state.assets,
        index: buildSnapIndex(state.doc, assetMapRef.current),
      };
      snapCache.current = cache;
    }
    const cursor: LngLat = [event.lngLat.lng, event.lngLat.lat];
    const tolerance = SNAP_PX * metresPerPixel(cursor[1], map.getZoom());
    return findSnaps(cache.index, cursor, tolerance, context);
  }, []);

  const snapAt = useCallback(
    (event: MapMouseEvent): Snap | undefined => {
      const tool = useEditorStore.getState().tool;
      const context: SnapContext = tool === 'area' ? 'area' : tool === 'build' ? 'build' : 'select';
      lastPointer.current = event;

      // A fresh position starts the cycle over; Tab at the same spot keeps stepping.
      const [ax, ay] = cycle.current.anchor;
      if (Math.hypot(event.point.x - ax, event.point.y - ay) > 3) cycle.current.index = 0;

      const found = candidatesAt(event, context);
      if (found.length === 0) {
        lastSnap.current = null;
        return undefined;
      }
      const pick = found[cycle.current.index % found.length]!;
      lastSnap.current = pick;
      return pick.snap;
    },
    [candidatesAt],
  );

  /** Where a point actually lands: on what it snapped to, or where the mouse is. */
  const resolvePoint = useCallback((event: MapMouseEvent, snap?: Snap): LngLat => {
    if (!snap && lastSnap.current) return lastSnap.current.position;
    if (snap?.kind === 'segment') return snap.position;
    if (snap?.kind === 'node') {
      const node = useEditorStore.getState().doc.nodes.find((n) => n.id === snap.nodeId);
      if (node) return node.position;
    }
    return [event.lngLat.lng, event.lngLat.lat];
  }, []);

  // ---------------------------------------------------------------------- create once

  useEffect(() => {
    if (!container.current || mapRef.current) return;

    const map = new MapLibreMap({
      container: container.current,
      style: buildStyle(basemapId, { customUrl: customTileUrl, waybackRelease, arcgisApiKey }),
      center: [-84.512, 39.107],
      zoom: 16,
      // North-up. Every width on screen is a metre expression evaluated against the map's
      // own scale, and the before/after swipe clips against a meridian; both assume it.
      pitch: 0,
      bearing: 0,
      dragRotate: false,
      attributionControl: false,
    });

    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new ScaleControl({ unit: 'imperial' }), 'bottom-left');
    map.touchZoomRotate.disableRotation();

    map.on('load', () => {
      addDesign(map);
      pushSources(map, painted.current);
      setReady(true);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Style options are applied by their own effect; re-creating the map for them would
    // throw away the user's viewport every time they changed imagery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------- pointer input

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    /**
     * Where a building would stand and which way it would face: toward the nearest road if
     * one is near, plus whatever turn the user has added. Null when there is no map yet.
     */
    const buildingGhost = (event: MapMouseEvent) => {
      const state = useEditorStore.getState();
      let cache = snapCache.current;
      if (!cache || cache.doc !== state.doc || cache.assets !== state.assets) {
        cache = { doc: state.doc, assets: state.assets, index: buildSnapIndex(state.doc, assetMapRef.current) };
        snapCache.current = cache;
      }
      const position: LngLat = [event.lngLat.lng, event.lngLat.lat];
      const road = nearestRoadPoint(cache.index, position, 80);
      // The front of a footprint is its south edge at heading 0, so facing a bearing b
      // means turning by b - 180.
      const base = road ? bearingToFace(position, road) - 180 : 0;
      const rotation = (((base + state.buildingTurn) % 360) + 360) % 360;
      const issues = placementIssues(state.doc, cache.index, {
        typeId: state.activeBuildingType,
        position,
        rotation,
      });
      return { position, rotation, issues };
    };

    const onClick = (event: MapMouseEvent) => {
      const state = useEditorStore.getState();
      const snap = snapAt(event);
      const point = resolvePoint(event, snap);

      if (state.tool === 'build') {
        state.buildTo(point, snap);
        return;
      }

      if (state.tool === 'area') {
        areaRing.current = [...areaRing.current, point];
        drawDraft(map, areaRing.current, null);
        return;
      }

      if ((state.tool === 'zone' || state.tool === 'district') && state.paintMode === 'fill') {
        state.fillBlock(point);
        return;
      }

      // Outline mode traces a shape point by point; brush mode paints on drag instead.
      if ((state.tool === 'zone' || state.tool === 'district') && state.paintMode === 'outline') {
        areaRing.current = [...areaRing.current, point];
        drawDraft(map, areaRing.current, null);
        return;
      }
      if (state.tool === 'zone' || state.tool === 'district') return;

      if (state.tool === 'roundabout') {
        state.placeRoundabout(point);
        return;
      }

      if (state.tool === 'building') {
        const ghost = buildingGhost(event);
        if (ghost && ghost.issues.length === 0) state.placeBuilding(ghost.position, ghost.rotation);
        else if (ghost) {
          state.setNotice({
            kind: 'warning',
            title: 'Cannot place here',
            details: ghost.issues.map((i) => PLACEMENT_TEXT[i]),
          });
        }
        return;
      }

      // Retype a road to whatever is armed. The click that would have selected it instead
      // changes it, which is what a game's upgrade tool does.
      if (state.tool === 'upgrade') {
        const hit = pick(map, event);
        if (hit.segmentId) state.upgradeSegment(hit.segmentId);
        return;
      }

      if (state.tool === 'bulldoze') {
        if (snap?.kind === 'node') {
          state.bulldoze({ nodeId: snap.nodeId });
          return;
        }
        const hit = pick(map, event);
        if (hit.buildingId) state.bulldoze({ buildingId: hit.buildingId });
        else if (hit.segmentId) state.bulldoze({ segmentId: hit.segmentId });
        else if (hit.areaId) state.bulldoze({ areaId: hit.areaId });
        else if (hit.zoneId) state.bulldoze({ zoneId: hit.zoneId });
        else if (hit.districtId) state.bulldoze({ districtId: hit.districtId });
        return;
      }

      // Select.
      if (snap?.kind === 'node') {
        state.selectNode(snap.nodeId);
        return;
      }
      const hit = pick(map, event);
      if (hit.segmentId) state.selectSegment(hit.segmentId);
      else if (hit.areaId) state.selectArea(hit.areaId);
      else state.clearSelection();
    };

    /** Finish an area on a double click, which is how every drawing tool ends a shape. */
    const onDoubleClick = (event: MapMouseEvent) => {
      const state = useEditorStore.getState();

      // Editing the bends of the selected road: double-click a bend to remove it, or the
      // road itself to add one there.
      if (state.tool === 'select') {
        const box: [PointLike, PointLike] = [
          [event.point.x - SNAP_PX, event.point.y - SNAP_PX],
          [event.point.x + SNAP_PX, event.point.y + SNAP_PX],
        ];
        const handle = map
          .queryRenderedFeatures(box, { layers: ['handle-point'] })
          .find((f) => f.properties?.kind === 'shape');
        if (handle) {
          event.preventDefault();
          state.removeShapePoint(String(handle.properties!.segmentId), Number(handle.properties!.shapeIndex));
          return;
        }
        const selected = state.doc.segments.find((x) => x.id === state.selectedSegmentId);
        if (selected && pick(map, event).segmentId === selected.id) {
          const at = splitPointFor(
            selected,
            new Map(state.doc.nodes.map((n) => [n.id, n])),
            [event.lngLat.lng, event.lngLat.lat],
          );
          if (at) {
            event.preventDefault();
            state.insertShapePoint(selected.id, at.shapeIndex, at.point);
          }
        }
        return;
      }

      const outlining =
        (state.tool === 'zone' || state.tool === 'district') && state.paintMode === 'outline';
      if (state.tool !== 'area' && !outlining) return;
      event.preventDefault();
      if (areaRing.current.length >= 3) {
        if (outlining) state.paintOutline(areaRing.current);
        else state.addAreaShape(areaRing.current);
      }
      areaRing.current = [];
      drawDraft(map, [], null);
    };

    const onMouseDown = (event: MapMouseEvent) => {
      const state = useEditorStore.getState();

      // The brush: press to start a stroke, drag to paint, release to commit one undo step.
      if ((state.tool === 'zone' || state.tool === 'district') && state.paintMode === 'brush') {
        if (event.originalEvent.button !== 0) return;
        drag.current = { kind: 'stroke', points: [[event.lngLat.lng, event.lngLat.lat]] };
        map.dragPan.disable();
        event.preventDefault();
        drawBrush(map, drag.current.points[0]!, state.brushRadiusMeters, drag.current.points);
        return;
      }

      if (state.tool !== 'select') return;

      const { x, y } = event.point;
      const box: [PointLike, PointLike] = [
        [x - SNAP_PX, y - SNAP_PX],
        [x + SNAP_PX, y + SNAP_PX],
      ];
      const handle = map.queryRenderedFeatures(box, { layers: ['handle-point'] })[0];
      if (!handle) return;

      if (handle.properties?.kind === 'node') {
        drag.current = { kind: 'node', nodeId: String(handle.properties.nodeId) };
      } else if (handle.properties?.kind === 'shape') {
        drag.current = {
          kind: 'shape',
          segmentId: String(handle.properties.segmentId),
          index: Number(handle.properties.shapeIndex),
        };
      } else {
        return;
      }

      // The whole drag is one undo step, not one per animation frame.
      state.beginGesture();
      map.dragPan.disable();
      event.preventDefault();
    };

    const onMouseMove = (event: MapMouseEvent) => {
      hover.current = [event.lngLat.lng, event.lngLat.lat];
      const state = useEditorStore.getState();
      setPointer({ position: hover.current, snap: lastSnap.current?.label ?? null });

      if (drag.current?.kind === 'stroke') {
        const point: LngLat = [event.lngLat.lng, event.lngLat.lat];
        const points = drag.current.points;
        // A new point only once the brush has moved a useful way, so a long drag stays a
        // few hundred points rather than thousands.
        if (distanceMetres(points[points.length - 1]!, point) >= Math.max(1, state.brushRadiusMeters / 4)) {
          points.push(point);
        }
        drawBrush(map, point, state.brushRadiusMeters, points);
        return;
      }

      if ((state.tool === 'zone' || state.tool === 'district') && state.paintMode === 'fill') {
        let cache = facesCache.current;
        if (!cache || cache.doc !== state.doc || cache.assets !== state.assets) {
          const byId = assetMapRef.current;
          cache = { doc: state.doc, assets: state.assets, faces: findFaces(state.doc, byId) };
          facesCache.current = cache;
        }
        const block = blockAt(state.doc, assetMapRef.current, cache.faces, [event.lngLat.lng, event.lngLat.lat]);
        const features: FeatureCollection['features'] = (block?.shape ?? []).map((ring) => ({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [...ring, ring[0]!].map((p) => block!.plane.toLngLat(p)),
          },
          properties: {},
        }));
        setData(map, DRAFT_SOURCE, { type: 'FeatureCollection', features });
        return;
      }

      if (state.tool === 'zone' || state.tool === 'district') {
        if (state.paintMode === 'brush') {
          drawBrush(map, [event.lngLat.lng, event.lngLat.lat], state.brushRadiusMeters, []);
        } else if (areaRing.current.length > 0) {
          drawDraft(map, [...areaRing.current, [event.lngLat.lng, event.lngLat.lat]], null);
        }
        return;
      }

      if (state.tool === 'bulldoze' || state.tool === 'upgrade') {
        const snapped = state.tool === 'bulldoze' ? snapAt(event) : undefined;
        const nodePosition =
          snapped?.kind === 'node'
            ? (state.doc.nodes.find((n) => n.id === snapped.nodeId)?.position ?? null)
            : null;
        const hit = nodePosition ? {} : pick(map, event);
        // Upgrade only acts on roads, so only a road is shown as its target.
        const target = state.tool === 'upgrade' ? (hit.segmentId ? { segmentId: hit.segmentId } : {}) : hit;
        highlight(map, painted.current, target, nodePosition, state.tool === 'bulldoze');
        return;
      }

      if (state.tool === 'roundabout') {
        drawBrush(map, [event.lngLat.lng, event.lngLat.lat], state.roundaboutRadius, []);
        return;
      }

      if (state.tool === 'building') {
        const ghost = buildingGhost(event);
        if (ghost) {
          drawGhost(map, footprint({ typeId: state.activeBuildingType, position: ghost.position, rotation: ghost.rotation }), ghost.issues.length > 0);
          map.getCanvas().style.cursor = ghost.issues.length > 0 ? 'not-allowed' : 'crosshair';
        }
        return;
      }

      if (drag.current) {
        const point: LngLat = [event.lngLat.lng, event.lngLat.lat];
        if (drag.current.kind === 'node') {
          state.moveNodeLive(drag.current.nodeId, point);
          // Ring what letting go would merge into, so a join is never a surprise.
          const target = joinCandidate(
            useEditorStore.getState().doc,
            drag.current.nodeId,
            MERGE_DROP_METRES,
          );
          const at = target
            ? useEditorStore.getState().doc.nodes.find((n) => n.id === target.nodeId)?.position
            : null;
          showSnap(map, at ? { kind: 'node' } : undefined, at ?? null);
        } else {
          state.moveShapePointLive(drag.current.segmentId, drag.current.index, point);
        }
        return;
      }

      // What the next click would attach to, shown before it is spent. Snapping that is
      // invisible is snapping you have to trust rather than see, which is what made the
      // build tool feel like guesswork.
      const snap = state.tool === 'build' || state.tool === 'area' ? snapAt(event) : undefined;
      const shown = snap ?? lastSnap.current ?? undefined;
      if (state.tool === 'area' || state.tool !== 'build' || !state.buildFromNodeId) {
        if (state.tool === 'build' || state.tool === 'area') {
          showSnap(map, shown, shown ? resolvePoint(event, snap) : null);
        } else {
          showSnap(map, undefined, null);
        }
      }

      if (state.tool === 'build') {
        const from = state.doc.nodes.find((n) => n.id === state.buildFromNodeId);
        if (from) {
          // Landing on something wins: an explicit target beats a direction.
          let cursor = snap
            ? resolvePoint(event, snap)
            : snapAngle(event, state.buildHandles, from.position);
          let guide: LngLat[] = [];
          let guideKind = '';

          // Otherwise pull onto what the junction implies — carry straight on, or turn
          // square. Alt lets go of it, the way it lets go of everything else.
          if (!snap && !event.originalEvent.altKey && !event.originalEvent.shiftKey) {
            const anchor = state.buildHandles.length
              ? state.buildHandles[state.buildHandles.length - 1]!
              : from.position;
            const guides =
              state.buildHandles.length === 0 ? directionGuidesAt(state.doc, from.id) : [];
            const pulled = snapToGuides(anchor, cursor, guides);
            if (pulled) {
              cursor = pulled.point;
              guide = guideLine(anchor, pulled.point);
              guideKind = pulled.guide.kind;
            }
          }

          showGuide(map, guide, guideKind, snap, snap ? cursor : null);
          const controls = [from.position, ...state.buildHandles, cursor];
          const preview = paintPreview(
            assetMapRef.current,
            state.activeLineAssetId,
            controls,
            state.buildMode !== 'straight',
            state.buildLevel,
          ) as FeatureCollection;

          // The same rules the click will apply, shown before it: a road the rules refuse is
          // drawn red and the cursor says so.
          const issues =
            state.buildHandles.length >= HANDLES_FOR_MODE[state.buildMode]
              ? roadIssues(
                  state.doc,
                  { position: from.position, nodeId: from.id },
                  { position: cursor, nodeId: snap?.kind === 'node' ? snap.nodeId : undefined },
                ).filter((issue) => issue !== 'sameNode')
              : [];
          const invalid = issues.length > 0;
          for (const feature of preview.features) feature.properties = { ...feature.properties, invalid: invalid ? 1 : 0 };
          map.getCanvas().style.cursor = invalid ? 'not-allowed' : 'crosshair';
          setData(map, 'preview', preview);
        } else {
          setData(map, 'preview', emptyFC());
        }
        return;
      }

      if (state.tool === 'area' && areaRing.current.length > 0) {
        drawDraft(map, [...areaRing.current, [event.lngLat.lng, event.lngLat.lat]], null);
      }
    };

    const onMouseUp = () => {
      const dragged = drag.current;
      if (!dragged) return;
      drag.current = null;
      const state = useEditorStore.getState();

      if (dragged.kind === 'stroke') {
        map.dragPan.enable();
        setData(map, DRAFT_SOURCE, emptyFC());
        state.paintStroke(dragged.points);
        return;
      }
      state.endGesture();
      map.dragPan.enable();
      showSnap(map, undefined, null);

      // Dropping a node onto another merges them, which is how two roads drawn separately
      // become connected. The model always had the operation; there was no way to ask for it.
      if (dragged.kind === 'node') {
        const target = joinCandidate(state.doc, dragged.nodeId, MERGE_DROP_METRES);
        if (target) state.joinNodes(target.nodeId, dragged.nodeId);
      }
    };

    map.on('click', onClick);
    map.on('dblclick', onDoubleClick);
    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);

    return () => {
      map.off('click', onClick);
      map.off('dblclick', onDoubleClick);
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
    };
  }, [ready, snapAt, resolvePoint]);

  // --------------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const state = useEditorStore.getState();

      // Tab steps through everything under the cursor, strongest first, for the moments a
      // junction, a road and a kerb are all within reach and the first is not the one meant.
      if (event.key === 'Tab' && ['build', 'area', 'select'].includes(state.tool) && lastPointer.current) {
        const last = lastPointer.current;
        cycle.current = { index: cycle.current.index + 1, anchor: [last.point.x, last.point.y] };
        const snap = snapAt(last);
        const map = mapRef.current;
        if (map && lastSnap.current) {
          showSnap(map, lastSnap.current, resolvePoint(last, snap));
          event.preventDefault();
        }
        return;
      }

      // Tool hotkeys, the ones the toolbar has always advertised.
      if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        const tools: Record<string, Tool> = {
          v: 'select',
          b: 'build',
          u: 'upgrade',
          g: 'area',
          o: 'roundabout',
          z: 'zone',
          n: 'building',
          d: 'district',
          x: 'bulldoze',
        };
        const tool = tools[event.key.toLowerCase()];
        if (tool && !event.shiftKey) {
          state.setTool(tool);
          areaRing.current = [];
          if (mapRef.current) drawDraft(mapRef.current, [], null);
          return;
        }
        if (event.key.toLowerCase() === 'e' && (state.tool === 'zone' || state.tool === 'district')) {
          state.setEraseMode(!state.eraseMode);
          return;
        }
        if (event.key === '[') {
          state.setBrushRadius(state.brushRadiusMeters / 1.25);
          return;
        }
        if (event.key === ']') {
          state.setBrushRadius(state.brushRadiusMeters * 1.25);
          return;
        }
        if (event.key.toLowerCase() === 'r' && state.tool === 'building') {
          state.turnBuilding(event.shiftKey ? 1 : 15);
          return;
        }
      }

      if (event.key === 'Escape') {
        state.cancelBuild();
        areaRing.current = [];
        if (mapRef.current) drawDraft(mapRef.current, [], null);
        return;
      }

      if (
        event.key === 'Enter' &&
        (state.tool === 'zone' || state.tool === 'district') &&
        state.paintMode === 'outline' &&
        areaRing.current.length >= 3
      ) {
        state.paintOutline(areaRing.current);
        areaRing.current = [];
        if (mapRef.current) drawDraft(mapRef.current, [], null);
        return;
      }

      if (event.key === 'Enter' && state.tool === 'area' && areaRing.current.length >= 3) {
        state.addAreaShape(areaRing.current);
        areaRing.current = [];
        if (mapRef.current) drawDraft(mapRef.current, [], null);
        return;
      }

      // Raise and lower what you are about to build, the way the games do it.
      if (event.key === 'PageUp') {
        state.setBuildLevel(Math.min(2, state.buildLevel + 1));
        event.preventDefault();
        return;
      }
      if (event.key === 'PageDown') {
        state.setBuildLevel(Math.max(-2, state.buildLevel - 1));
        event.preventDefault();
        return;
      }

      if (event.key === 'Backspace' && state.tool === 'build') {
        state.undoLastPoint();
        event.preventDefault();
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (state.tool === 'select') state.deleteSelection();
        return;
      }

      // Road modes, on the number row, the way a game does it.
      if (state.tool === 'build' && ['1', '2', '3'].includes(event.key)) {
        state.setBuildMode(
          event.key === '1' ? 'straight' : event.key === '2' ? 'curved' : 'freeform',
        );
        return;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ------------------------------------------------------------------ tool cursor

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const canvas = map.getCanvas();
    canvas.style.cursor =
      tool === 'build' || tool === 'area' || tool === 'roundabout' || tool === 'zone' || tool === 'district' || tool === 'building'
        ? 'crosshair'
        : tool === 'bulldoze'
          ? 'not-allowed'
          : tool === 'upgrade'
            ? 'cell'
            : '';
    // A ghost, brush ring or half-drawn outline belongs to the tool that made it.
    areaRing.current = [];
    setData(map, DRAFT_SOURCE, emptyFC());
    // Double click places a point in the shape tools; zooming would fight it.
    if (tool === 'area' || tool === 'zone' || tool === 'district') map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [tool, ready]);

  // ------------------------------------------------------------------- basemap

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const key = JSON.stringify([basemapId, customTileUrl, waybackRelease, arcgisApiKey]);
    if (key === styleKey.current) return;
    styleKey.current = key;

    map.setStyle(buildStyle(basemapId, { customUrl: customTileUrl, waybackRelease, arcgisApiKey }));
    map.once('styledata', () => {
      addDesign(map);
      // The new style's sources are empty. Refill them from the last paint, or changing
      // imagery would silently erase the design until the next edit.
      pushSources(map, painted.current);
    });
  }, [basemapId, customTileUrl, waybackRelease, arcgisApiKey, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('basemap')) return;
    map.setPaintProperty('basemap', 'raster-opacity', imageryOpacity * VIEW_IMAGERY_FACTOR[view]);
  }, [imageryOpacity, view, ready]);

  // Info views recolour the design layers; re-applied after every style rebuild too.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    applyView(map, view);
  }, [view, ready, basemapId, customTileUrl, waybackRelease, arcgisApiKey]);

  // ---------------------------------------------------------------- design data

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    assetMapRef.current = assetMap(assets);

    // At most one repaint per animation frame. A drag can deliver several store updates
    // between frames, and only the latest is ever visible.
    const frame = requestAnimationFrame(() => {
      const sources = paintDoc(doc, assetMapRef.current, {
        selectedSegmentId,
        selectedNodeId,
        selectedAreaId,
        defaultRadiusMeters,
        showAllCenterlines,
      });

      painted.current = sources;
      pushSources(map, sources);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    doc,
    assets,
    ready,
    selectedSegmentId,
    selectedNodeId,
    selectedAreaId,
    defaultRadiusMeters,
    showAllCenterlines,
  ]);

  // Clear the preview when the road in progress ends, whether it was finished or abandoned.
  // The preview itself is driven by the pointer, so there is nothing to redraw here.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || buildFromNodeId) return;
    setData(map, 'preview', emptyFC());
    setData(map, 'snap', emptyFC());
  }, [buildFromNodeId, buildHandles, ready]);

  // ------------------------------------------------------------- layer visibility

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const group of LAYER_GROUPS) {
      const visible = layerVisibility[group.id as LayerGroupId] !== false;
      for (const id of group.layers) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
        }
      }
    }
  }, [layerVisibility, ready]);

  return <div ref={container} className={className} style={{ width: '100%', height: '100%' }} />;
}

// ------------------------------------------------------------------------- helpers

/** What is under the cursor, among the things a click can select. */
/** The ring of a circle on the ground, as a closed line, for the brush outline. */
function brushRing(centre: LngLat, radiusMetres: number): LngLat[] {
  const plane = localPlane(centre);
  const ring = circle({ x: 0, y: 0 }, radiusMetres, 48).map((p) => plane.toLngLat(p));
  return [...ring, ring[0]!];
}

function drawBrush(map: MapLibreMap, centre: LngLat, radiusMetres: number, stroke: readonly LngLat[]) {
  const features: FeatureCollection['features'] = [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: brushRing(centre, radiusMetres) },
      properties: {},
    },
  ];
  if (stroke.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: stroke as LngLat[] },
      properties: {},
    });
  }
  setData(map, DRAFT_SOURCE, { type: 'FeatureCollection', features });
}

/** What a bulldoze or upgrade click would hit, as lines, so the target is shown before it is hit. */
function highlight(
  map: MapLibreMap,
  painted: PaintSources,
  hit: ReturnType<typeof pick>,
  nodeAt: LngLat | null,
  destructive: boolean,
) {
  const props = { invalid: destructive ? 1 : 0 };
  const features: FeatureCollection['features'] = [];
  const outline = (rings: readonly (readonly (readonly number[])[])[]) => {
    for (const ring of rings) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: ring as unknown as LngLat[] },
        properties: props,
      });
    }
  };

  if (nodeAt) {
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: nodeAt }, properties: props });
  } else if (hit.buildingId) {
    for (const f of painted.buildings.features) {
      if (f.properties?.buildingId === hit.buildingId) outline(f.geometry.coordinates);
    }
  } else if (hit.segmentId) {
    const f = painted.bands.features.find((b) => b.properties?.segmentId === hit.segmentId);
    if (f) {
      features.push({ type: 'Feature', geometry: f.geometry, properties: props });
    }
  } else if (hit.areaId) {
    for (const f of painted.areas.features) {
      if (f.properties?.areaId === hit.areaId) outline(f.geometry.coordinates);
    }
  } else if (hit.zoneId) {
    for (const f of painted.zones.features) {
      if (f.properties?.zoneId === hit.zoneId) outline(f.geometry.coordinates);
    }
  } else if (hit.districtId) {
    for (const f of painted.districts.features) {
      if (f.properties?.districtId === hit.districtId) outline(f.geometry.coordinates);
    }
  }
  setData(map, DRAFT_SOURCE, { type: 'FeatureCollection', features });
}

function drawGhost(map: MapLibreMap, corners: readonly LngLat[], invalid: boolean) {
  setData(map, DRAFT_SOURCE, {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [...corners, corners[0]!] as LngLat[] },
        properties: { invalid: invalid ? 1 : 0 },
      },
    ],
  });
}

function pick(map: MapLibreMap, event: MapMouseEvent): {
  segmentId?: string;
  areaId?: string;
  zoneId?: string;
  buildingId?: string;
  districtId?: string;
} {
  if (map.getLayer('building-fill')) {
    const onBuilding = map.queryRenderedFeatures(event.point, { layers: ['building-fill'] })[0];
    if (onBuilding?.properties?.buildingId) return { buildingId: String(onBuilding.properties.buildingId) };
  }

  const bandLayers = ['band--1', 'band-0', 'band-1'].filter((id) => map.getLayer(id));
  const onRoad = map.queryRenderedFeatures(event.point, { layers: bandLayers })[0];
  if (onRoad?.properties?.segmentId) return { segmentId: String(onRoad.properties.segmentId) };

  if (map.getLayer('area-fill')) {
    const onArea = map.queryRenderedFeatures(event.point, { layers: ['area-fill'] })[0];
    if (onArea?.properties?.areaId) return { areaId: String(onArea.properties.areaId) };
  }
  if (map.getLayer('zone-fill')) {
    const onZone = map.queryRenderedFeatures(event.point, { layers: ['zone-fill'] })[0];
    if (onZone?.properties?.zoneId) return { zoneId: String(onZone.properties.zoneId) };
  }
  if (map.getLayer('district-fill')) {
    const onDistrict = map.queryRenderedFeatures(event.point, { layers: ['district-fill'] })[0];
    if (onDistrict?.properties?.districtId) return { districtId: String(onDistrict.properties.districtId) };
  }
  return {};
}

/**
 * Ring whatever the next click would attach to.
 *
 * Two colours, because the two answers mean different things: landing on a node JOINS there,
 * landing on a road SPLITS it. Those have different consequences and the tool should say
 * which one is about to happen.
 */
function showSnap(map: MapLibreMap, snap: { kind: string } | undefined, at: LngLat | null) {
  if (!snap || !at) {
    setData(map, 'snap', emptyFC());
    return;
  }
  setData(map, 'snap', {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: at },
        properties: { kind: snap.kind },
      },
    ],
  });
}

/** The guide line and the snap ring together: both say where the next click lands. */
function showGuide(
  map: MapLibreMap,
  guide: readonly LngLat[],
  kind: string,
  snap: Snap | undefined,
  at: LngLat | null,
) {
  const features: FeatureCollection['features'] = [];

  if (guide.length === 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: guide as LngLat[] },
      properties: { kind },
    });
  }
  if (snap && at) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: at },
      properties: { kind: snap.kind },
    });
  }

  setData(map, 'snap', { type: 'FeatureCollection', features });
}

/** The rubber band and its points, as one collection. */
function drawDraft(map: MapLibreMap, line: readonly LngLat[], _unused: null) {
  const features: FeatureCollection['features'] = [];
  if (line.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: line as LngLat[] },
      properties: {},
    });
  }
  for (const point of line) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: point },
      properties: {},
    });
  }
  setData(map, DRAFT_SOURCE, { type: 'FeatureCollection', features });
}

/**
 * Where the cursor is, snapped to a 15-degree increment when Shift is held.
 *
 * Measured from the last point placed rather than from the start of the road, which is what
 * makes it useful for the second bend of a curve as well as the first.
 */
function snapAngle(
  event: MapMouseEvent,
  shape: readonly LngLat[],
  origin: LngLat,
): LngLat {
  const point: LngLat = [event.lngLat.lng, event.lngLat.lat];
  if (!event.originalEvent.shiftKey) return point;

  const from = shape[shape.length - 1] ?? origin;
  const plane = localPlane(from);
  const { x: dx, y: dy } = plane.toPlane(point);
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return point;

  const step = (SNAP_ANGLE_DEGREES * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return plane.toLngLat({ x: Math.cos(angle) * length, y: Math.sin(angle) * length });
}


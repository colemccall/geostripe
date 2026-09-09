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
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { basemapById, tileUrlsFor } from './basemaps';
import type { BasemapId, TileSourceOptions } from './basemaps';
import { designLayers, emptySources, paintDoc, paintPreview, projectCentre } from './paint';
import { renderAllGlyphs } from './glyphImages';
import type { PaintSources } from './paint';
import { useEditorStore } from '../store/useEditorStore';
import { assetMap } from '../library/assets';
import { joinCandidate, splitPointFor } from '../model/doc';
import type { Snap } from '../model/doc';
import { directionGuidesAt, guideLine, snapToGuides } from '../geo/snapping';
import type { LngLat } from '../geo/projection';
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
 * The interaction model is a road-building game's, and the change from what came before is
 * not cosmetic. Drawing used to mean tracing a whole street as a polyline, finishing it, and
 * then hoping the junction detector agreed with where you had aimed. Here a click is
 * unambiguous: it lands on a node, on a road, or on open ground, and each of those means
 * exactly one thing. Nothing is inferred afterwards, so nothing can be inferred wrongly.
 *
 * What the map draws comes entirely from `paint.ts`, which turns the document into offset
 * lines rather than polygons. This file's job is therefore small: keep the sources fed, and
 * translate pointer events into document edits.
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
  'bands',
  'stripes',
  'stamps',
  'plates',
  'guides',
  'handles',
];

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
function addDesign(map: MapLibreMap, latDeg: number) {
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
      map.addSource(id, { type: 'geojson', data: emptyFC() });
    }
  }

  for (const layer of designLayers(latDeg)) {
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
      paint: { 'line-color': '#4DA3FF', 'line-width': 2, 'line-dasharray': [2, 2] },
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
    | null
  >(null);

  const areaRing = useRef<LngLat[]>([]);

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
   * Asked of the rendered map rather than of the model, because the question is "what is
   * under the cursor", and a tolerance in metres would be right at one zoom and wrong at
   * every other. Nodes win over roads: if both are within reach you meant the junction.
   */
  const snapAt = useCallback(
    (event: MapMouseEvent): Snap | undefined => {
      const map = mapRef.current;
      if (!map) return undefined;
      const { x, y } = event.point;
      const box: [PointLike, PointLike] = [
        [x - SNAP_PX, y - SNAP_PX],
        [x + SNAP_PX, y + SNAP_PX],
      ];

      const onNode = map
        .queryRenderedFeatures(box, { layers: ['handle-point'] })
        .find((f) => f.properties?.kind === 'node');
      if (onNode?.properties?.nodeId) {
        return { kind: 'node', nodeId: String(onNode.properties.nodeId) };
      }

      const state = useEditorStore.getState();
      const bandLayers = designLayers(0)
        .filter((l) => l.id.startsWith('band-'))
        .map((l) => l.id)
        .filter((id) => map.getLayer(id));
      const onRoad = map.queryRenderedFeatures(box, { layers: bandLayers })[0];
      const segmentId = onRoad?.properties?.segmentId ? String(onRoad.properties.segmentId) : null;
      if (!segmentId) return undefined;

      const segment = state.doc.segments.find((s) => s.id === segmentId);
      if (!segment) return undefined;

      const nodes = new Map(state.doc.nodes.map((n) => [n.id, n]));
      const at = splitPointFor(segment, nodes, [event.lngLat.lng, event.lngLat.lat]);
      if (!at) return undefined;

      return { kind: 'segment', segmentId, shapeIndex: at.shapeIndex, position: at.point };
    },
    [],
  );

  /** Where a point actually lands: on what it snapped to, or where the mouse is. */
  const resolvePoint = useCallback((event: MapMouseEvent, snap?: Snap): LngLat => {
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
      addDesign(map, projectCentre(useEditorStore.getState().doc)[1] || 39.1);
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
        if (hit.segmentId) state.bulldoze({ segmentId: hit.segmentId });
        else if (hit.areaId) state.bulldoze({ areaId: hit.areaId });
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
      if (state.tool !== 'area') return;
      event.preventDefault();
      if (areaRing.current.length >= 3) state.addAreaShape(areaRing.current);
      areaRing.current = [];
      drawDraft(map, [], null);
    };

    const onMouseDown = (event: MapMouseEvent) => {
      const state = useEditorStore.getState();
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
          showSnap(map, at ? { kind: 'node', nodeId: target!.nodeId } : undefined, at ?? null);
        } else {
          state.moveShapePointLive(drag.current.segmentId, drag.current.index, point);
        }
        return;
      }

      // What the next click would attach to, shown before it is spent. Snapping that is
      // invisible is snapping you have to trust rather than see, which is what made the
      // build tool feel like guesswork.
      const snap = state.tool === 'build' ? snapAt(event) : undefined;
      if (state.tool !== 'build' || !state.buildFromNodeId) {
        showSnap(map, snap, snap ? resolvePoint(event, snap) : null);
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
          setData(
            map,
            'preview',
            paintPreview(
              assetMapRef.current,
              state.activeLineAssetId,
              controls,
              state.buildMode !== 'straight',
              state.buildLevel,
            ) as FeatureCollection,
          );
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

      if (event.key === 'Escape') {
        state.cancelBuild();
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

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        if (event.shiftKey) state.redo();
        else state.undo();
        event.preventDefault();
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
      tool === 'build' || tool === 'area'
        ? 'crosshair'
        : tool === 'bulldoze'
          ? 'not-allowed'
          : tool === 'upgrade'
            ? 'cell'
            : '';
    // Double click places a point in the shape tools; zooming would fight it.
    if (tool === 'area') map.doubleClickZoom.disable();
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
      addDesign(map, projectCentre(useEditorStore.getState().doc)[1] || 39.1);
      // The new style's sources are empty. Refill them from the last paint, or changing
      // imagery would silently erase the design until the next edit.
      pushSources(map, painted.current);
    });
  }, [basemapId, customTileUrl, waybackRelease, arcgisApiKey, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('basemap')) return;
    map.setPaintProperty('basemap', 'raster-opacity', imageryOpacity);
  }, [imageryOpacity, ready]);

  // ---------------------------------------------------------------- design data

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    assetMapRef.current = assetMap(assets);
    const sources = paintDoc(doc, assetMapRef.current, {
      selectedSegmentId,
      selectedNodeId,
      selectedAreaId,
      defaultRadiusMeters,
      showAllCenterlines,
    });

    painted.current = sources;
    pushSources(map, sources);
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
function pick(map: MapLibreMap, event: MapMouseEvent): {
  segmentId?: string;
  areaId?: string;
} {
  const bandLayers = ['band--1', 'band-0', 'band-1'].filter((id) => map.getLayer(id));
  const onRoad = map.queryRenderedFeatures(event.point, { layers: bandLayers })[0];
  if (onRoad?.properties?.segmentId) return { segmentId: String(onRoad.properties.segmentId) };

  if (map.getLayer('area-fill')) {
    const onArea = map.queryRenderedFeatures(event.point, { layers: ['area-fill'] })[0];
    if (onArea?.properties?.areaId) return { areaId: String(onArea.properties.areaId) };
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
function showSnap(map: MapLibreMap, snap: Snap | undefined, at: LngLat | null) {
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
  const scale = Math.cos((from[1] * Math.PI) / 180);
  const dx = (point[0] - from[0]) * scale;
  const dy = point[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-12) return point;

  const step = (SNAP_ANGLE_DEGREES * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return [from[0] + (Math.cos(angle) * length) / scale, from[1] + Math.sin(angle) * length];
}

export const emptyPaintSources = emptySources;

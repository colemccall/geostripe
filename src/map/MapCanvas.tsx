import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl';
import type { MapMouseEvent, MapOptions } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';

import { basemapById, tileUrlsFor, unconfiguredReason } from './basemaps';
import type { BasemapId, TileSourceOptions } from './basemaps';
import { buildDesignData, clipEastOf, clipLinesEastOf } from './designLayers';
import { LAYER_GROUPS } from './layerGroups';
import type { LayerGroupId } from './layerGroups';
import type { DesignData } from './designLayers';
import type { JunctionOverride } from '../geo/derived';
import { distanceMeters, lineLengthMeters } from '../geo/measure';
import { snapPoint } from '../geo/snap';
import type { SnapResult } from '../geo/snap';
import { DEFAULT_CURVE, tessellate } from '../geo/curve';
import type { CurveSettings } from '../geo/curve';
import type { Area, JunctionNode, Street } from '../model/types';
import type { Tool } from '../store/useEditorStore';
import type { DisplayUnits } from '../lib/units';
/**
 * Tell MapLibre where its worker actually is. Do not remove.
 *
 * Left alone, MapLibre resolves the worker with
 * `new URL('./maplibre-gl-worker.mjs', import.meta.url)`, relative to whichever file it
 * is running from — which in a production build is the hashed chunk in /assets/, where
 * no such file exists. The request comes back as index.html.
 *
 * Two things make this hard to spot. The failure is silent, and it is partial: raster
 * imagery keeps working because tiles load on the main thread, while every GeoJSON layer
 * stays invisible because those are parsed in the worker. It reads as a geometry bug.
 *
 * Vite's own worker bundling (`?worker&url`) does NOT fix it. That produces a bundle
 * MapLibre loads without complaint and which then never answers, leaving
 * `isSourceLoaded()` false forever. So instead scripts/sync-maplibre-worker.mjs copies
 * MapLibre's untouched files into public/maplibre/, where the worker's sibling import of
 * ./maplibre-gl-shared.mjs resolves normally.
 *
 * BASE_URL keeps this correct under both /geostripe/ and a custom domain root.
 */
setWorkerUrl(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`);


/**
 * MapLibre wrapper.
 *
 * The map instance is deliberately kept out of React state — it is a mutable, imperative
 * object with its own lifecycle, and re-rendering it causes tile thrash. React owns the
 * container; MapLibre owns everything inside it.
 *
 * Rotation is disabled on purpose. Plan-view street design has no use for a rotated
 * north, and holding the map north-up is what lets the before/after swipe clip against a
 * meridian rather than needing screen-space clipping MapLibre does not offer.
 *
 * Interaction state splits in two, deliberately:
 *
 *   - Anything a *frame* touches — the rubber-band point under the cursor, a vertex
 *     mid-drag — lives in refs and goes straight to the GeoJSON sources. Routing 60 Hz
 *     pointer moves through React state would re-render both rails to move one dot.
 *   - Anything that *outlives* the gesture — a committed vertex, a finished centerline —
 *     goes to the store, where undo can see it.
 */

/** MapLibre 6 removed the default export and no longer re-exports StyleSpecification. */
type MapStyle = NonNullable<MapOptions['style']>;

type LngLat = [number, number];

/** Streets and areas share the vertex-editing machinery; this says which one is meant. */
export type EntityKind = 'street' | 'area';

export interface MapView {
  lng: number;
  lat: number;
  zoom: number;
}

/** Imperative operations the surrounding UI needs — toolbar buttons, mostly. */
export interface MapHandle {
  finishDraw: () => void;
  cancelDraw: () => void;
  undoDraftPoint: () => void;
  clearMeasure: () => void;
  zoomTo: (centerline: readonly LngLat[]) => void;
  /** Step the zoom, for on-map buttons. MapLibre animates both. */
  zoomBy: (delta: number) => void;
  /** Frame everything drawn. Does nothing when there is nothing to frame. */
  zoomToAll: () => void;
}

interface Props {
  basemapId: BasemapId;
  sourceOptions: TileSourceOptions;
  units: DisplayUnits;
  streets: readonly Street[];
  selectedStreetId: string | null;
  tool: Tool;
  /** 0..1 across the viewport; null hides the divider and shows the full design. */
  swipe: number | null;
  center: LngLat;
  zoom: number;
  onViewChange?: (view: MapView) => void;
  onSelectStreet?: (streetId: string) => void;
  onSelectArea?: (areaId: string) => void;
  onAreaComplete?: (ring: LngLat[]) => void;
  areas?: readonly Area[];
  selectedAreaId?: string | null;
  onSelectJunction?: (key: string) => void;
  onWarnings?: (warnings: DesignData['warnings']) => void;
  onJunctions?: (
    junctions: DesignData['junctions'],
    warnings: string[],
    offsetPairs: DesignData['offsetPairs'],
  ) => void;

  // ---- junctions
  junctionOverrides?: Readonly<Record<string, JunctionOverride>>;
  defaultCornerRadiusMeters?: number;
  trimAtJunctions?: boolean;
  junctionMergeSlackMeters?: number;
  mergeBelowDegrees?: number;
  nodes?: readonly JunctionNode[];
  junctionMode?: 'auto' | 'nodes';
  selectedNodeId?: string | null;
  onSelectNode?: (id: string | null) => void;
  onPlaceNode?: (position: LngLat) => void;
  onMoveNode?: (id: string, position: LngLat) => void;
  /** Clicking bare ground, and Escape. Deselecting has to be as easy as selecting. */
  onClearSelection?: () => void;
  /** Delete or Backspace with something selected. */
  onDeleteSelection?: () => void;
  selectedJunctionKey?: string | null;
  showAllCenterlines?: boolean;
  /** Which groups of layers are drawn. Missing or true means visible. */
  layerVisibility?: Partial<Record<LayerGroupId, boolean>>;
  /** Imagery opacity, 0 to 1. Fading it back is how a design is checked against the trace. */
  imageryOpacity?: number;

  // ---- drawing
  /** Committed draft vertices and their running length, for the toolbar readout. */
  onDraftChange?: (points: LngLat[], metres: number) => void;
  /**
   * The drawn line, plus which of its points were placed as hard corners.
   *
   * Two lists rather than one, because a control point and its cornering are separate
   * facts: the point is where the street goes, the flag is how it gets there. Keeping them
   * apart is what lets a finished street be switched wholesale between straight and curved
   * without losing which corners were deliberately kept sharp.
   */
  onDrawComplete?: (points: LngLat[], sharpVertices: number[]) => void;
  /**
   * How the NEXT point placed joins the last one.
   *
   * 'straight' pins it as a hard corner; 'curved' lets the arc run through it. Toggled
   * while drawing, so one street can be straight down a block and swing round a bend
   * without stopping and starting again.
   */
  segmentMode?: 'straight' | 'curved';
  /** Corner radius for the curved segments of the line being drawn. */
  drawRadiusMeters?: number;

  // ---- centerline editing
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onVertexMove?: (kind: EntityKind, id: string, index: number, point: LngLat) => void;
  onVertexInsert?: (kind: EntityKind, id: string, afterIndex: number, point: LngLat) => void;
  onVertexDelete?: (kind: EntityKind, id: string, index: number) => void;
  /** Shift-click a control point to pin or release it as a hard corner. */
  onVertexSharp?: (kind: EntityKind, id: string, index: number) => void;

  // ---- measuring
  onMeasureChange?: (points: LngLat[], metres: number) => void;

  /**
   * How much geometry actually reached the map. Surfaced in the status bar because the
   * difference between "no bands generated" and "bands generated but not drawn" is
   * otherwise invisible, and both look like an empty map.
   */
  onRenderStats?: (stats: {
    bands: number;
    drawn: boolean;
    rendered: number;
    sourceLoaded: string;
    layerCount: number;
  }) => void;
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** How close a click must land to a handle, in pixels, to count as hitting it. */
const SNAP_PX = 14;

function buildStyle(basemapId: BasemapId, options: TileSourceOptions): MapStyle {
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
      ? [{ id: 'basemap', type: 'raster', source: 'basemap' }]
      : [],
  };
}

/** How near, in screen pixels, a drawn point has to be to snap to something. */
const SNAP_DRAW_PX = 14;

/** Angle snapping increments, when Shift is held. */
const SNAP_ANGLE_DEGREES = 15;

const DESIGN_SOURCES = [
  'areas',
  'junction-footprint',
  'junction-paved',
  'junction-points',
  'crossings',
  'stop-lines',
  'bands',
  'markings',
  'stamps',
  'centerlines',
  'midpoints',
  'vertices',
  'draft',
  'draft-points',
  'measure',
  'measure-points',
  'nodes',
  'snap',
] as const;

/**
 * Add the design sources and layers. Idempotent — safe to call after every setStyle.
 *
 * Each layer is added independently so that one invalid paint property cannot abort the
 * rest. A thrown addLayer used to take the whole function down before any data was set,
 * which rendered as bare imagery with no error anywhere on screen.
 */
function addLayerSafely(map: MapLibreMap, spec: Parameters<MapLibreMap['addLayer']>[0]) {
  if (map.getLayer(spec.id)) return;
  try {
    map.addLayer(spec);
  } catch (error) {
    console.error(`[GeoStripe] could not add layer "${spec.id}":`, error);
  }
}

function addDesignLayers(map: MapLibreMap) {
  for (const id of DESIGN_SOURCES) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
  }

  // Land cover is the ground: below every part of the street design, above the imagery.
  addLayerSafely(map, {
    id: 'area-fill',
    type: 'fill',
    source: 'areas',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'opacity'] },
  });

  addLayerSafely(map, {
    id: 'area-outline',
    type: 'line',
    source: 'areas',
    paint: {
      'line-color': ['case', ['get', 'selected'], '#F2C14E', 'rgba(0,0,0,0.45)'],
      'line-width': ['case', ['get', 'selected'], 2, 0.8],
    },
  });

  // Order is load-bearing. The footprint goes down first in footway colour and the paved
  // area on top of it; streets are trimmed so roadway stops at the paved edge and footway
  // at the footprint edge, which leaves precisely the corner showing as footway. The
  // stacking order IS the boolean that carves the corner sidewalk.
  addLayerSafely(map, {
    id: 'junction-footprint-fill',
    type: 'fill',
    source: 'junction-footprint',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.82 },
  });

  addLayerSafely(map, {
    id: 'junction-paved-fill',
    type: 'fill',
    source: 'junction-paved',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.82 },
  });

  addLayerSafely(map, {
    id: 'junction-paved-outline',
    type: 'line',
    source: 'junction-paved',
    paint: {
      'line-color': ['case', ['get', 'selected'], '#F2C14E', 'rgba(0,0,0,0.55)'],
      'line-width': ['case', ['get', 'selected'], 1.8, 0.6],
    },
  });

  addLayerSafely(map, {
    id: 'band-fill',
    type: 'fill',
    source: 'bands',
    paint: {
      // Colour travels with the feature so a palette change needs no layer rebuild.
      'fill-color': ['get', 'color'],
      // A tunnel shows the ground through it; anything at or above grade is solid.
      'fill-opacity': ['case', ['<', ['coalesce', ['get', 'level'], 0], 0], 0.42, 0.82],
    },
  });

  addLayerSafely(map, {
    id: 'band-outline',
    type: 'line',
    source: 'bands',
    paint: {
      'line-color': 'rgba(0,0,0,0.55)',
      // An overpass gets a heavier edge, which is what reads as a deck from above.
      'line-width': ['case', ['>', ['coalesce', ['get', 'level'], 0], 0], 2.2, 0.6],
    },
  });

  // Two layers rather than one with an expression: `line-dasharray` is not a data-driven
  // property in MapLibre, and feeding it a `case` expression makes addLayer throw — which
  // aborts the rest of this function and leaves the whole design layer empty. So the split
  // is solid / dashed, the one thing that CANNOT travel on the feature, and colour and
  // width travel on the feature so every stripe style is covered by these two.
  addLayerSafely(map, {
    id: 'marking-solid',
    type: 'line',
    source: 'markings',
    filter: ['!=', ['get', 'dashed'], true],
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['coalesce', ['get', 'lineWidth'], 1.2],
      'line-opacity': 0.9,
    },
  });

  addLayerSafely(map, {
    id: 'marking-dashed',
    type: 'line',
    source: 'markings',
    filter: ['==', ['get', 'dashed'], true],
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['coalesce', ['get', 'lineWidth'], 1.1],
      'line-opacity': 0.85,
      'line-dasharray': [3, 2.5],
    },
  });

  // Pavement symbols sit above the stripes and below the editing handles: they are paint
  // on the road, and nothing that is paint should ever cover a control point.
  addLayerSafely(map, {
    id: 'stamp-fill',
    type: 'fill',
    source: 'stamps',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.94 },
  });

  addLayerSafely(map, {
    id: 'crossing-fill',
    type: 'fill',
    source: 'crossings',
    paint: {
      'fill-color': ['get', 'color'],
      // A raised table is a surface, not paint, so it sits back a little.
      'fill-opacity': ['case', ['==', ['get', 'kind'], 'table'], 0.7, 0.92],
    },
  });

  addLayerSafely(map, {
    id: 'centerline-line',
    type: 'line',
    source: 'centerlines',
    paint: {
      'line-color': '#F2C14E',
      'line-width': ['case', ['get', 'selected'], 2, 1.2],
      'line-opacity': ['case', ['get', 'selected'], 0.95, 0.5],
      'line-dasharray': [2, 2],
    },
  });

  // Hollow, and smaller than a real vertex, so "add one here" reads differently from
  // "move this one".
  addLayerSafely(map, {
    id: 'midpoint-point',
    type: 'circle',
    source: 'midpoints',
    paint: {
      'circle-radius': 3.2,
      'circle-color': 'rgba(20,24,26,0.55)',
      'circle-stroke-color': '#F2C14E',
      'circle-stroke-width': 1.4,
    },
  });

  addLayerSafely(map, {
    id: 'vertex-point',
    type: 'circle',
    source: 'vertices',
    paint: {
      // A pinned corner reads as hollow: the curve runs through the filled ones and
      // stops at these.
      'circle-radius': ['case', ['get', 'sharp'], 5, 4.5],
      'circle-color': ['case', ['get', 'sharp'], '#14181A', '#F2C14E'],
      'circle-stroke-color': ['case', ['get', 'sharp'], '#F2C14E', '#14181A'],
      'circle-stroke-width': ['case', ['get', 'sharp'], 2.2, 1.6],
    },
  });

  addLayerSafely(map, {
    id: 'stop-line',
    type: 'line',
    source: 'stop-lines',
    paint: { 'line-color': '#F5F2E8', 'line-width': 2.4, 'line-opacity': 0.9 },
  });

  // Placed intersections. Bigger than a vertex and drawn above the design, because they
  // are the one handle you have to be able to hit without hunting for it.
  addLayerSafely(map, {
    id: 'node-point',
    type: 'circle',
    source: 'nodes',
    paint: {
      'circle-radius': ['case', ['get', 'selected'], 9, 7],
      // A disabled node is hollow: it is still yours, it just makes no junction.
      'circle-color': [
        'case',
        ['get', 'disabled'],
        'rgba(0,0,0,0.25)',
        ['get', 'selected'],
        '#F2C14E',
        '#7FB2E5',
      ],
      'circle-stroke-width': 2.2,
      'circle-stroke-color': ['case', ['get', 'selected'], '#FFFFFF', 'rgba(10,14,16,0.85)'],
    },
  });

  addLayerSafely(map, {
    id: 'junction-point',
    type: 'circle',
    source: 'junction-points',
    paint: {
      'circle-radius': ['case', ['get', 'selected'], 6, 4],
      'circle-color': ['case', ['get', 'selected'], '#F2C14E', 'rgba(20,24,26,0.75)'],
      'circle-stroke-color': '#F2C14E',
      'circle-stroke-width': 1.6,
    },
  });

  addLayerSafely(map, {
    id: 'draft-line',
    type: 'line',
    source: 'draft',
    paint: { 'line-color': '#6FD3C7', 'line-width': 2, 'line-dasharray': [1.5, 1.5] },
  });

  addLayerSafely(map, {
    id: 'draft-vertex',
    type: 'circle',
    source: 'draft-points',
    paint: {
      'circle-radius': 4,
      'circle-color': '#6FD3C7',
      'circle-stroke-color': '#14181A',
      'circle-stroke-width': 1.6,
    },
  });

  addLayerSafely(map, {
    id: 'measure-line',
    type: 'line',
    source: 'measure',
    paint: { 'line-color': '#FF9E6D', 'line-width': 1.8, 'line-dasharray': [2, 1.5] },
  });

  // The snap indicator sits above everything: it is feedback about what the next click
  // will do, so it must never be behind the thing it is pointing at.
  addLayerSafely(map, {
    id: 'snap-point',
    type: 'circle',
    source: 'snap',
    paint: {
      'circle-radius': 6,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 2,
      'circle-stroke-color': ['case', ['==', ['get', 'kind'], 'angle'], '#7FB2E5', '#F2C14E'],
    },
  });

  addLayerSafely(map, {
    id: 'measure-vertex',
    type: 'circle',
    source: 'measure-points',
    paint: {
      'circle-radius': 4,
      'circle-color': '#FF9E6D',
      'circle-stroke-color': '#14181A',
      'circle-stroke-width': 1.6,
    },
  });
}

function setData(map: MapLibreMap, id: string, data: FeatureCollection) {
  const source = map.getSource(id);
  if (source && 'setData' in source) {
    (source as { setData: (d: FeatureCollection) => void }).setData(data);
  }
}

function lineFC(points: readonly LngLat[]): FeatureCollection {
  if (points.length < 2) return EMPTY;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [...points] },
      },
    ],
  };
}

function pointsFC(points: readonly LngLat[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((p, index) => ({
      type: 'Feature',
      id: index,
      properties: { index },
      geometry: { type: 'Point', coordinates: p },
    })),
  };
}

const MapCanvas = forwardRef<MapHandle, Props>(function MapCanvas(
  {
    basemapId,
    sourceOptions,
    units,
    streets,
    selectedStreetId,
    tool,
    swipe,
    center,
    zoom,
    onViewChange,
    onSelectStreet,
    onSelectArea,
    onAreaComplete,
    areas,
    selectedAreaId,
    onSelectJunction,
    onWarnings,
    onJunctions,
    junctionOverrides,
    defaultCornerRadiusMeters,
    trimAtJunctions,
    junctionMergeSlackMeters,
    mergeBelowDegrees,
    nodes,
    junctionMode,
    selectedNodeId,
    onSelectNode,
    onPlaceNode,
    onMoveNode,
    onClearSelection,
    onDeleteSelection,
    selectedJunctionKey,
    showAllCenterlines,
    layerVisibility,
    imageryOpacity,
    onDraftChange,
    onDrawComplete,
    segmentMode,
    drawRadiusMeters,
    onGestureStart,
    onGestureEnd,
    onVertexMove,
    onVertexInsert,
    onVertexDelete,
    onVertexSharp,
    onMeasureChange,
    onRenderStats,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const scaleRef = useRef<ScaleControl | null>(null);
  const [ready, setReady] = useState(false);

  // Latest values without making them effect dependencies, so the map is never rebuilt.
  const handlers = {
    tool,
    streets,
    selectedStreetId,
    swipe,
    onViewChange,
    onSelectStreet,
    onSelectArea,
    onAreaComplete,
    areas,
    selectedAreaId,
    onSelectJunction,
    onWarnings,
    onJunctions,
    junctionOverrides,
    defaultCornerRadiusMeters,
    trimAtJunctions,
    junctionMergeSlackMeters,
    mergeBelowDegrees,
    nodes,
    junctionMode,
    selectedNodeId,
    onSelectNode,
    onPlaceNode,
    onMoveNode,
    onClearSelection,
    onDeleteSelection,
    selectedJunctionKey,
    showAllCenterlines,
    layerVisibility,
    imageryOpacity,
    onDraftChange,
    onDrawComplete,
    segmentMode,
    drawRadiusMeters,
    onGestureStart,
    onGestureEnd,
    onVertexMove,
    onVertexInsert,
    onVertexDelete,
    onVertexSharp,
    onMeasureChange,
    onRenderStats,
  };
  const latest = useRef(handlers);
  latest.current = handlers;

  // ---- gesture state. Refs, not state: these change once per animation frame.
  const draftRef = useRef<LngLat[]>([]);
  /** Which draft points were placed in straight mode, and so stay hard corners. */
  const draftSharpRef = useRef<number[]>([]);
  const hoverRef = useRef<LngLat | null>(null);
  const measureRef = useRef<LngLat[]>([]);
  const dragRef = useRef<{ kind: EntityKind; streetId: string; index: number } | null>(null);
  const nodeDragRef = useRef<string | null>(null);
  const statsTimer = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const measureReportedAt = useRef(0);

  const drawDraft = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('draft')) return;
    const committed = draftRef.current;
    const hover = hoverRef.current;
    const open = hover && committed.length > 0 ? [...committed, hover] : committed;
    // An area closes back to its first point while you draw it, so the shape you are
    // about to get is the shape you can see.
    const closed = latest.current.tool === 'area' && open.length > 2 ? [...open, open[0]!] : open;

    // Preview the ARC, not the control polygon. Drawing a bend and seeing a chain of
    // straight lines means judging the result in your head, which is exactly what the
    // curve feature exists to stop.
    const settings = draftCurveSettings();
    const rubber =
      settings.mode === 'straight' || closed.length < 3
        ? closed
        : tessellate(closed, {
            ...settings,
            // The hovering point is the one under the cursor and has no flag yet; treat it
            // as an endpoint, which is what it will be if the line finishes here.
            sharpVertices: settings.sharpVertices,
          });

    setData(map, 'draft', lineFC(rubber));
    setData(map, 'draft-points', pointsFC(committed));
  }, []);

  /** The curve the draft is being drawn with, from the current tool settings. */
  const draftCurveSettings = (): CurveSettings => {
    const mode = latest.current.segmentMode ?? 'straight';
    return {
      mode: mode === 'curved' ? 'rounded' : 'straight',
      radiusMeters: latest.current.drawRadiusMeters ?? DEFAULT_CURVE.radiusMeters,
      sharpVertices: [...draftSharpRef.current],
    };
  };

  const drawMeasure = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('measure')) return;
    const committed = measureRef.current;
    const hover = hoverRef.current;
    const rubber = hover && committed.length === 1 ? [...committed, hover] : committed;
    setData(map, 'measure', lineFC(rubber));
    setData(map, 'measure-points', pointsFC(committed));

    // The line follows the cursor every frame; the React readout does not need to. A
    // committed point always reports, so the final number is never a stale sample.
    const now = performance.now();
    if (committed.length >= 2 || now - measureReportedAt.current > 60) {
      measureReportedAt.current = now;
      latest.current.onMeasureChange?.(rubber, lineLengthMeters(rubber));
    }
  }, []);

  const reportDraft = useCallback(() => {
    latest.current.onDraftChange?.([...draftRef.current], lineLengthMeters(draftRef.current));
  }, []);

  const finishDraw = useCallback(() => {
    const points = draftRef.current;
    const sharp = draftSharpRef.current;
    const forArea = latest.current.tool === 'area';
    draftRef.current = [];
    draftSharpRef.current = [];
    hoverRef.current = null;
    drawDraft();
    reportDraft();

    if (forArea) {
      // Three points is the minimum that encloses anything. The ring is stored unclosed —
      // repeating the first point would mean every later edit had to keep two copies of
      // one vertex in step.
      if (points.length >= 3) latest.current.onAreaComplete?.(points);
      return;
    }
    // Two points is the minimum that describes a direction to offset from; anything less
    // is a stray click, not a street.
    if (points.length >= 2) latest.current.onDrawComplete?.(points, sharp);
  }, [drawDraft, reportDraft]);

  const cancelDraw = useCallback(() => {
    draftRef.current = [];
    draftSharpRef.current = [];
    hoverRef.current = null;
    drawDraft();
    reportDraft();
  }, [drawDraft, reportDraft]);

  const undoDraftPoint = useCallback(() => {
    const dropped = draftRef.current.length - 1;
    draftRef.current = draftRef.current.slice(0, -1);
    // The flag belongs to the point that just went, so it has to go with it — otherwise
    // the indices shift and a later point inherits a corner it was never given.
    draftSharpRef.current = draftSharpRef.current.filter((index) => index !== dropped);
    drawDraft();
    reportDraft();
  }, [drawDraft, reportDraft]);

  const clearMeasure = useCallback(() => {
    measureRef.current = [];
    hoverRef.current = null;
    drawMeasure();
  }, [drawMeasure]);

  useImperativeHandle(
    ref,
    () => ({
      finishDraw,
      cancelDraw,
      undoDraftPoint,
      clearMeasure,
      zoomBy: (delta) => mapRef.current?.easeTo({ zoom: (mapRef.current.getZoom() ?? 0) + delta }),
      zoomToAll: () => {
        const map = mapRef.current;
        if (!map) return;
        const points = [
          ...latest.current.streets.flatMap((street) => street.centerline),
          ...(latest.current.areas ?? []).flatMap((area) => area.ring),
        ];
        if (points.length === 0) return;
        let minLng = Infinity;
        let minLat = Infinity;
        let maxLng = -Infinity;
        let maxLat = -Infinity;
        for (const [lng, lat] of points) {
          minLng = Math.min(minLng, lng);
          maxLng = Math.max(maxLng, lng);
          minLat = Math.min(minLat, lat);
          maxLat = Math.max(maxLat, lat);
        }
        map.fitBounds(
          [
            [minLng, minLat],
            [maxLng, maxLat],
          ],
          { padding: 90, maxZoom: 19, duration: 600 },
        );
      },
      zoomTo: (centerline) => {
        const map = mapRef.current;
        if (!map || centerline.length === 0) return;
        let minLng = Infinity;
        let minLat = Infinity;
        let maxLng = -Infinity;
        let maxLat = -Infinity;
        for (const [lng, lat] of centerline) {
          minLng = Math.min(minLng, lng);
          maxLng = Math.max(maxLng, lng);
          minLat = Math.min(minLat, lat);
          maxLat = Math.max(maxLat, lat);
        }
        map.fitBounds(
          [
            [minLng, minLat],
            [maxLng, maxLat],
          ],
          { padding: 90, maxZoom: 19, duration: 600 },
        );
      },
    }),
    [finishDraw, cancelDraw, undoDraftPoint, clearMeasure],
  );

  /**
   * Show and hide whole groups of layers.
   *
   * Runs on every change of the toggles and after every style load, because a basemap
   * switch rebuilds the style and takes the layers with it — a toggle applied once at
   * click time would silently come back on the next imagery change.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const group of LAYER_GROUPS) {
      const visible = layerVisibility?.[group.id] ?? true;
      for (const id of group.layers) {
        if (!map.getLayer(id)) continue;
        try {
          map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
        } catch {
          // A layer the current style does not have is not an error worth surfacing.
        }
      }
    }
  }, [layerVisibility, ready, basemapId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('basemap')) return;
    try {
      map.setPaintProperty('basemap', 'raster-opacity', imageryOpacity ?? 1);
    } catch {
      // Same: a style without a basemap layer is a configuration state, not a fault.
    }
  }, [imageryOpacity, ready, basemapId]);

  /** Rebuild derived geometry and push it to the map, applying the swipe clip. */
  const refresh = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    // Guard on the source existing, NOT on map.isStyleLoaded().
    //
    // isStyleLoaded() looks like "is the style ready", but internally it also requires
    // every tile currently in view to have finished loading. Against a dynamic image
    // service like USGS NAIP, tiles stream more or less continuously, so that flag is
    // almost never true and gating on it silently suppressed every design update — bands
    // were generated correctly and simply never reached the map.
    //
    // Writing to a GeoJSON source has no such requirement: it only needs the source to
    // exist, which addDesignLayers guarantees before it calls back here.
    if (!map.getSource('bands')) return;

    const {
      streets: s,
      selectedStreetId: sel,
      swipe: sw,
      onWarnings: warn,
      onJunctions: reportJunctions,
    } = latest.current;

    const data = buildDesignData(s, sel, {
      areas: latest.current.areas,
      selectedAreaId: latest.current.selectedAreaId,
      overrides: latest.current.junctionOverrides,
      defaultCornerRadiusMeters: latest.current.defaultCornerRadiusMeters,
      trimAtJunctions: latest.current.trimAtJunctions,
      junctionMergeSlackMeters: latest.current.junctionMergeSlackMeters,
      mergeBelowDegrees: latest.current.mergeBelowDegrees,
      nodes: latest.current.nodes,
      junctionMode: latest.current.junctionMode,
      selectedNodeId: latest.current.selectedNodeId,
      selectedJunctionKey: latest.current.selectedJunctionKey,
      showAllCenterlines: latest.current.showAllCenterlines,
    });
    warn?.(data.warnings);
    reportJunctions?.(data.junctions, data.junctionWarnings, data.offsetPairs);

    if (sw === null) {
      setData(map, 'bands', data.bands);
      setData(map, 'markings', data.markings);
      setData(map, 'stamps', data.stamps);
      setData(map, 'centerlines', data.centerlines);
      setData(map, 'junction-paved', data.junctionPaved);
      setData(map, 'junction-footprint', data.junctionFootprint);
      setData(map, 'crossings', data.crossings);
    } else {
      // Screen x -> longitude. Exact while the map is north-up, which it always is here.
      const x = map.getContainer().clientWidth * sw;
      const minLng = map.unproject([x, map.getContainer().clientHeight / 2]).lng;
      setData(map, 'bands', clipEastOf(data.bands, minLng));
      setData(map, 'markings', clipLinesEastOf(data.markings, minLng));
      setData(map, 'stamps', clipEastOf(data.stamps, minLng));
      setData(map, 'centerlines', clipLinesEastOf(data.centerlines, minLng));
      setData(map, 'junction-paved', clipEastOf(data.junctionPaved, minLng));
      setData(map, 'junction-footprint', clipEastOf(data.junctionFootprint, minLng));
      setData(map, 'crossings', clipEastOf(data.crossings, minLng));
    }

    // Editing handles are never clipped: they are UI, not design, and a handle that
    // disappears behind the swipe divider is a handle you cannot grab.
    setData(map, 'areas', data.areas);
    setData(map, 'vertices', data.vertices);
    setData(map, 'midpoints', data.midpoints);
    setData(map, 'junction-points', data.junctionPoints);
    setData(map, 'nodes', data.nodes);
    setData(map, 'stop-lines', data.stopLines);

    // queryRenderedFeatures only reports once tiles are built, so sample shortly after —
    // and only once the edits stop, or a drag would queue one probe per frame.
    const bandCount = data.bands.features.length;
    if (statsTimer.current !== null) window.clearTimeout(statsTimer.current);
    statsTimer.current = window.setTimeout(() => {
      let rendered = -1;
      try { rendered = map.queryRenderedFeatures({ layers: ['band-fill'] }).length; } catch { rendered = -2; }
      let sourceLoaded = 'n/a';
      try {
        sourceLoaded = String(map.isSourceLoaded('bands'));
      } catch {
        sourceLoaded = 'err';
      }
      const layerCount = map.getStyle().layers.length;
      latest.current.onRenderStats?.({
        bands: bandCount,
        drawn: Boolean(map.getLayer('band-fill') && map.getSource('bands')),
        rendered,
        sourceLoaded,
        layerCount,
      });
    }, 600);
  }, []);

  // Stable handle so the idle retry above can call the latest refresh without making
  // refresh depend on itself.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  /**
   * Coalesce refreshes to one per frame.
   *
   * Dragging a vertex writes to the store on every pointer move, and each write can reach
   * here from two directions at once — the React effect below and the map's own `move`
   * handler. Rebuilding the bands twice in a frame costs two full passes of offsetting
   * and polygon cleanup for a picture the compositor draws once.
   */
  const scheduleRefresh = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      refreshRef.current();
    });
  }, []);

  // ---- create once
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: buildStyle(basemapId, sourceOptions),
      center,
      zoom,
      maxZoom: 22,
      attributionControl: false,
      // North-up only. See the note at the top of this file.
      dragRotate: false,
      pitchWithRotate: false,
      touchZoomRotate: true,
    });

    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();

    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');

    const scale = new ScaleControl({ maxWidth: 110, unit: units === 'ft' ? 'imperial' : 'metric' });
    scaleRef.current = scale;
    map.addControl(scale, 'bottom-left');

    const report = () => {
      const c = map.getCenter();
      latest.current.onViewChange?.({ lng: c.lng, lat: c.lat, zoom: map.getZoom() });
    };

    map.on('move', () => {
      report();
      // The swipe boundary is a screen position, so it moves with the map.
      if (latest.current.swipe !== null) scheduleRefresh();
    });

    map.on('load', () => {
      addDesignLayers(map);
      setReady(true);
      report();
      refresh();
    });

    // MapLibre routes tile, source and style failures here and swallows them otherwise —
    // without this a broken imagery source is indistinguishable from a dark one.
    map.on('error', (e) => {
      console.error('[GeoStripe] MapLibre error:', e.error?.message ?? e, e);
    });

    // ------------------------------------------------------------------ pointer input

    /**
     * Where the next drawn point should land.
     *
     * Alt suppresses snapping entirely, which is the escape hatch for tracing something
     * that genuinely runs a metre off an existing line. Shift adds angle snapping, which
     * is opt-in because tracing imagery wants the cursor free.
     */
    const snapFor = (event: MapMouseEvent, from: LngLat | null): SnapResult => {
      const here: LngLat = [event.lngLat.lng, event.lngLat.lat];
      const original = event.originalEvent as MouseEvent | undefined;
      if (original?.altKey) return { point: here, kind: 'none', label: '' };

      // Screen pixels to ground metres, taken from the map rather than assumed: the same
      // fourteen pixels is a metre at one zoom and thirty at another.
      const a = map.unproject([event.point.x, event.point.y]);
      const b = map.unproject([event.point.x + SNAP_DRAW_PX, event.point.y]);
      const toleranceMeters = Math.max(0.25, distanceMeters([a.lng, a.lat], [b.lng, b.lat]));

      return snapPoint({
        cursor: here,
        streets: latest.current.streets,
        areas: latest.current.areas ?? [],
        from,
        toleranceMeters,
        angleStepDegrees: original?.shiftKey ? SNAP_ANGLE_DEGREES : 0,
      });
    };

    const showSnap = (result: SnapResult) => {
      if (!map.getSource('snap')) return;
      setData(
        map,
        'snap',
        result.kind === 'none'
          ? EMPTY
          : {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  properties: { kind: result.kind },
                  geometry: { type: 'Point', coordinates: result.point },
                },
              ],
            },
      );
    };

    const near = (event: MapMouseEvent, point: LngLat | undefined) => {
      if (!point) return false;
      const a = map.project(point);
      return Math.hypot(a.x - event.point.x, a.y - event.point.y) <= SNAP_PX;
    };

    map.on('click', (event) => {
      const active = latest.current.tool;

      // A node under the cursor wins in every tool: it is the smallest target on the map
      // and the only way to reach the intersection you placed.
      const nodeUnder = (): string | null => {
        try {
          const hits = map.queryRenderedFeatures(
            [
              [event.point.x - SNAP_PX, event.point.y - SNAP_PX],
              [event.point.x + SNAP_PX, event.point.y + SNAP_PX],
            ],
            { layers: ['node-point'] },
          );
          const id = hits[0]?.properties?.['nodeId'];
          return typeof id === 'string' ? id : null;
        } catch {
          return null;
        }
      };

      if (active === 'node') {
        const existing = nodeUnder();
        if (existing) latest.current.onSelectNode?.(existing);
        // Snapped, so a node placed on a crossing lands ON both centerlines rather than
        // a metre off one of them — which is the difference between a junction and none.
        else latest.current.onPlaceNode?.(snapFor(event, null).point);
        return;
      }

      if (active === 'select') {
        const existing = nodeUnder();
        if (existing) {
          latest.current.onSelectNode?.(existing);
          return;
        }
      }

      if (active === 'draw' || active === 'area') {
        const draft = draftRef.current;
        // Clicking the last point again — which is also what the second half of a
        // double-click looks like — ends the line rather than stacking a duplicate.
        if (draft.length >= 2 && (near(event, draft[draft.length - 1]) || near(event, draft[0]))) {
          finishDraw();
          return;
        }
        // The committed point is the SNAPPED one. Junctions are derived from where
        // centerlines really meet, so a vertex that lands where it was aimed is the
        // difference between a junction at the crossing and one at a near miss.
        const snapped = snapFor(event, draft[draft.length - 1] ?? null).point;
        // A point placed in straight mode is pinned as a hard corner, so the arc does not
        // round off a junction you meant to be square.
        if ((latest.current.segmentMode ?? 'straight') === 'straight') {
          draftSharpRef.current = [...draftSharpRef.current, draft.length];
        }
        draftRef.current = [...draft, snapped];
        drawDraft();
        reportDraft();
        return;
      }

      if (active === 'measure') {
        // Measuring snaps too: measuring kerb to kerb is the commonest thing anyone does
        // with it, and both kerbs are on lines already drawn.
        const snapped = snapFor(event, measureRef.current[0] ?? null).point;
        // A third click starts a fresh measurement rather than extending a two-point one.
        measureRef.current =
          measureRef.current.length >= 2 ? [snapped] : [...measureRef.current, snapped];
        drawMeasure();
        return;
      }

      // Select. A click on bare imagery is deliberately NOT a deselect — losing the
      // inspector every time you miss a band by two pixels is maddening.
      //
      // Wrapped because queryRenderedFeatures throws if the layer is not in the style yet,
      // which is a real window right after a basemap switch.
      try {
        // The junction marker wins over the pavement beneath it: it is small, deliberate,
        // and the only way to reach the intersection inspector.
        const marker = map.queryRenderedFeatures(
          [
            [event.point.x - SNAP_PX, event.point.y - SNAP_PX],
            [event.point.x + SNAP_PX, event.point.y + SNAP_PX],
          ],
          { layers: ['junction-point'] },
        );
        const junctionKey = marker[0]?.properties?.['junctionKey'];
        if (typeof junctionKey === 'string') {
          latest.current.onSelectJunction?.(junctionKey);
          return;
        }

        const hits = map.queryRenderedFeatures(event.point, { layers: ['band-fill'] });
        const streetId = hits[0]?.properties?.['streetId'];
        if (typeof streetId === 'string') {
          latest.current.onSelectStreet?.(streetId);
          return;
        }

        // Land cover sits under the streets, so it is only reachable where none is drawn.
        const ground = map.queryRenderedFeatures(event.point, { layers: ['area-fill'] });
        const areaId = ground[0]?.properties?.['areaId'];
        if (typeof areaId === 'string') {
          latest.current.onSelectArea?.(areaId);
          return;
        }

        // Nothing under the cursor. This used to hold the selection, on the grounds that
        // losing the inspector by missing a band by two pixels is maddening — but the
        // reverse turned out worse: with no other way to deselect, the panel could not be
        // put down at all. Escape does the same thing without moving the mouse.
        latest.current.onClearSelection?.();
      } catch {
        // No design layers yet; nothing to select.
      }
    });

    map.on('mousemove', (event) => {
      const active = latest.current.tool;

      if (active === 'draw' || active === 'area') {
        const draft = draftRef.current;
        const result = snapFor(event, draft[draft.length - 1] ?? null);
        showSnap(result);
        if (draft.length > 0) {
          hoverRef.current = result.point;
          drawDraft();
        }
        return;
      }

      if (active === 'measure') {
        const result = snapFor(event, measureRef.current[0] ?? null);
        showSnap(result);
        if (measureRef.current.length === 1) {
          hoverRef.current = result.point;
          drawMeasure();
        }
        return;
      }

      showSnap({ point: [0, 0], kind: 'none', label: '' });
    });

    map.on('dblclick', (event) => {
      if (latest.current.tool !== 'draw' && latest.current.tool !== 'area') return;
      // The two clicks that make up the double-click already committed their vertices;
      // this just closes the line out.
      event.preventDefault();
      finishDraw();
    });

    // ---- vertex dragging
    //
    // preventDefault on the mousedown is what stops MapLibre panning the map out from
    // under the handle. The move/up listeners go on the map rather than the window
    // because MapLibre already normalises its own event coordinates.
    const onNodeDragMove = (event: MapMouseEvent) => {
      const id = nodeDragRef.current;
      if (!id) return;
      latest.current.onMoveNode?.(id, [event.lngLat.lng, event.lngLat.lat]);
    };

    const onNodeDragEnd = () => {
      if (!nodeDragRef.current) return;
      nodeDragRef.current = null;
      map.off('mousemove', onNodeDragMove);
      map.off('mouseup', onNodeDragEnd);
      map.dragPan.enable();
      latest.current.onGestureEnd?.();
    };

    map.on('mousedown', 'node-point', (event) => {
      const active = latest.current.tool;
      if (active !== 'select' && active !== 'node') return;
      const id = event.features?.[0]?.properties?.['nodeId'];
      if (typeof id !== 'string') return;

      event.preventDefault();
      nodeDragRef.current = id;
      latest.current.onSelectNode?.(id);
      // One undo step for the whole drag, like every other gesture here.
      latest.current.onGestureStart?.();
      map.dragPan.disable();
      map.on('mousemove', onNodeDragMove);
      map.on('mouseup', onNodeDragEnd);
    });

    const onDragMove = (event: MapMouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      latest.current.onVertexMove?.(drag.kind, drag.streetId, drag.index, [
        event.lngLat.lng,
        event.lngLat.lat,
      ]);
    };

    const onDragEnd = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      map.off('mousemove', onDragMove);
      window.removeEventListener('mouseup', onDragEnd);
      map.getCanvas().style.cursor = '';
      map.dragPan.enable();
      latest.current.onGestureEnd?.();
    };

    const beginDrag = (kind: EntityKind, streetId: string, index: number) => {
      dragRef.current = { kind, streetId, index };
      map.dragPan.disable();
      map.getCanvas().style.cursor = 'grabbing';
      map.on('mousemove', onDragMove);
      // On the window, not the map: releasing the button outside the canvas — over a rail,
      // or off the browser entirely — must still close the gesture. A map-only listener
      // leaves the vertex stuck to the cursor and beginGesture unmatched forever.
      window.addEventListener('mouseup', onDragEnd);
    };

    map.on('mousedown', 'vertex-point', (event) => {
      if (latest.current.tool !== 'select') return;
      const props = event.features?.[0]?.properties;
      const streetId = props?.['streetId'];
      const index = props?.['index'];
      const kind: EntityKind = props?.['kind'] === 'area' ? 'area' : 'street';
      if (typeof streetId !== 'string' || typeof index !== 'number') return;

      event.preventDefault();

      // Alt-click removes, shift-click pins the corner. Both held rather than separate
      // modes, because each is a one-off correction, not somewhere you stay.
      if (event.originalEvent.altKey) {
        latest.current.onVertexDelete?.(kind, streetId, index);
        return;
      }
      if (event.originalEvent.shiftKey) {
        latest.current.onVertexSharp?.(kind, streetId, index);
        return;
      }

      latest.current.onGestureStart?.();
      beginDrag(kind, streetId, index);
    });

    // Grabbing a midpoint inserts a real vertex there and drags it in the same motion, so
    // "bend the street here" is one gesture and one undo step.
    map.on('mousedown', 'midpoint-point', (event) => {
      if (latest.current.tool !== 'select') return;
      const props = event.features?.[0]?.properties;
      const streetId = props?.['streetId'];
      const index = props?.['index'];
      const kind: EntityKind = props?.['kind'] === 'area' ? 'area' : 'street';
      if (typeof streetId !== 'string' || typeof index !== 'number') return;

      event.preventDefault();
      latest.current.onGestureStart?.();
      latest.current.onVertexInsert?.(kind, streetId, index, [
        event.lngLat.lng,
        event.lngLat.lat,
      ]);
      beginDrag(kind, streetId, index + 1);
    });

    const setCursor = (value: string) => () => {
      if (latest.current.tool === 'select' && !dragRef.current) {
        map.getCanvas().style.cursor = value;
      }
    };
    map.on('mouseenter', 'vertex-point', setCursor('grab'));
    map.on('mouseleave', 'vertex-point', setCursor(''));
    map.on('mouseenter', 'midpoint-point', setCursor('copy'));
    map.on('mouseleave', 'midpoint-point', setCursor(''));
    map.on('mouseenter', 'band-fill', setCursor('pointer'));
    map.on('mouseleave', 'band-fill', setCursor(''));

    return () => {
      window.removeEventListener('mouseup', onDragEnd);
      if (statsTimer.current !== null) window.clearTimeout(statsTimer.current);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      map.remove();
      mapRef.current = null;
      scaleRef.current = null;
      setReady(false);
    };
    // Created once; every prop change below is applied to the live map instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- keyboard, while drawing or measuring
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      // Escape and Delete work in every tool, because "put this down" and "get rid of
      // this" are the two things you need most and should never have to hunt for.
      if (tool === 'select' || tool === 'node') {
        if (event.key === 'Escape') {
          event.preventDefault();
          latest.current.onClearSelection?.();
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          latest.current.onDeleteSelection?.();
        }
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        if (tool === 'draw' || tool === 'area') cancelDraw();
        else clearMeasure();
      } else if ((tool === 'draw' || tool === 'area') && event.key === 'Enter') {
        event.preventDefault();
        finishDraw();
      } else if (
        (tool === 'draw' || tool === 'area') &&
        (event.key === 'Backspace' || event.key === 'Delete')
      ) {
        event.preventDefault();
        undoDraftPoint();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, cancelDraw, clearMeasure, finishDraw, undoDraftPoint]);

  // ---- tool changes: cursor, double-click zoom, and clearing whatever was in flight
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const drawing = tool !== 'select';
    map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
    // Double-click means "finish the line" while drawing, so it must not also zoom.
    if (drawing) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();

    if (tool !== 'draw' && tool !== 'area') cancelDraw();
    if (tool !== 'measure') clearMeasure();
  }, [tool, cancelDraw, clearMeasure]);

  // ---- basemap switching
  //
  // Seeded with the mount-time basemap so this does not fire a redundant setStyle the
  // instant `ready` flips — that would tear down the design layers the load handler had
  // only just added, for no reason.
  const appliedRef = useRef<string>(JSON.stringify([basemapId, sourceOptions]));
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const key = JSON.stringify([basemapId, sourceOptions]);
    if (appliedRef.current === key) return;
    appliedRef.current = key;

    // setStyle drops every layer, so the design has to be re-added once it settles.
    map.setStyle(buildStyle(basemapId, sourceOptions));
    map.once('idle', () => {
      addDesignLayers(map);
      refreshRef.current();
    });
  }, [basemapId, sourceOptions, ready]);

  // ---- design data
  useEffect(() => {
    if (ready) scheduleRefresh();
  }, [
    streets,
    areas,
    selectedAreaId,
    selectedStreetId,
    swipe,
    ready,
    scheduleRefresh,
    junctionOverrides,
    defaultCornerRadiusMeters,
    trimAtJunctions,
    junctionMergeSlackMeters,
    mergeBelowDegrees,
    nodes,
    junctionMode,
    selectedNodeId,
    onSelectNode,
    onPlaceNode,
    onMoveNode,
    onClearSelection,
    onDeleteSelection,
    selectedJunctionKey,
    showAllCenterlines,
    layerVisibility,
    imageryOpacity,
  ]);

  // ---- scale bar unit follows the app
  useEffect(() => {
    scaleRef.current?.setUnit(units === 'ft' ? 'imperial' : 'metric');
  }, [units]);

  const blocked = unconfiguredReason(basemapId, sourceOptions);

  return (
    <div className="map-host">
      <div ref={containerRef} className="map-canvas" />
      {blocked && (
        <div className="map-empty">
          <p>{blocked}</p>
        </div>
      )}
    </div>
  );
});

export default MapCanvas;

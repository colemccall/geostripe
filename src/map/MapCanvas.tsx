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
import type { DesignData } from './designLayers';
import type { JunctionOverride } from '../geo/derived';
import { lineLengthMeters } from '../geo/measure';
import type { Street } from '../model/types';
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
  onSelectJunction?: (key: string) => void;
  onWarnings?: (warnings: DesignData['warnings']) => void;
  onJunctions?: (junctions: DesignData['junctions'], warnings: string[]) => void;

  // ---- junctions
  junctionOverrides?: Readonly<Record<string, JunctionOverride>>;
  defaultCornerRadiusMeters?: number;
  trimAtJunctions?: boolean;
  selectedJunctionKey?: string | null;

  // ---- drawing
  /** Committed draft vertices and their running length, for the toolbar readout. */
  onDraftChange?: (points: LngLat[], metres: number) => void;
  onDrawComplete?: (points: LngLat[]) => void;

  // ---- centerline editing
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onVertexMove?: (streetId: string, index: number, point: LngLat) => void;
  onVertexInsert?: (streetId: string, afterIndex: number, point: LngLat) => void;
  onVertexDelete?: (streetId: string, index: number) => void;

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

const DESIGN_SOURCES = [
  'junction-footprint',
  'junction-paved',
  'junction-points',
  'crossings',
  'stop-lines',
  'bands',
  'markings',
  'centerlines',
  'midpoints',
  'vertices',
  'draft',
  'draft-points',
  'measure',
  'measure-points',
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
      'fill-opacity': 0.82,
    },
  });

  addLayerSafely(map, {
    id: 'band-outline',
    type: 'line',
    source: 'bands',
    paint: { 'line-color': 'rgba(0,0,0,0.55)', 'line-width': 0.6 },
  });

  // Two layers rather than one with an expression: `line-dasharray` is not a data-driven
  // property in MapLibre, and feeding it a `case` expression makes addLayer throw — which
  // aborts the rest of this function and leaves the whole design layer empty.
  // Yellow separates opposing directions, dashed white separates same-direction lanes.
  addLayerSafely(map, {
    id: 'marking-opposing',
    type: 'line',
    source: 'markings',
    filter: ['==', ['get', 'opposing'], true],
    paint: { 'line-color': '#E8C45A', 'line-width': 1.4, 'line-opacity': 0.9 },
  });

  addLayerSafely(map, {
    id: 'marking-same',
    type: 'line',
    source: 'markings',
    filter: ['!=', ['get', 'opposing'], true],
    paint: {
      'line-color': '#EDE9DC',
      'line-width': 1.2,
      'line-opacity': 0.8,
      'line-dasharray': [3, 2.5],
    },
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
      'circle-radius': 4.5,
      'circle-color': '#F2C14E',
      'circle-stroke-color': '#14181A',
      'circle-stroke-width': 1.6,
    },
  });

  addLayerSafely(map, {
    id: 'stop-line',
    type: 'line',
    source: 'stop-lines',
    paint: { 'line-color': '#F5F2E8', 'line-width': 2.4, 'line-opacity': 0.9 },
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
    onSelectJunction,
    onWarnings,
    onJunctions,
    junctionOverrides,
    defaultCornerRadiusMeters,
    trimAtJunctions,
    selectedJunctionKey,
    onDraftChange,
    onDrawComplete,
    onGestureStart,
    onGestureEnd,
    onVertexMove,
    onVertexInsert,
    onVertexDelete,
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
    onSelectJunction,
    onWarnings,
    onJunctions,
    junctionOverrides,
    defaultCornerRadiusMeters,
    trimAtJunctions,
    selectedJunctionKey,
    onDraftChange,
    onDrawComplete,
    onGestureStart,
    onGestureEnd,
    onVertexMove,
    onVertexInsert,
    onVertexDelete,
    onMeasureChange,
    onRenderStats,
  };
  const latest = useRef(handlers);
  latest.current = handlers;

  // ---- gesture state. Refs, not state: these change once per animation frame.
  const draftRef = useRef<LngLat[]>([]);
  const hoverRef = useRef<LngLat | null>(null);
  const measureRef = useRef<LngLat[]>([]);
  const dragRef = useRef<{ streetId: string; index: number } | null>(null);
  const statsTimer = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const measureReportedAt = useRef(0);

  const drawDraft = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('draft')) return;
    const committed = draftRef.current;
    const hover = hoverRef.current;
    const rubber = hover && committed.length > 0 ? [...committed, hover] : committed;
    setData(map, 'draft', lineFC(rubber));
    setData(map, 'draft-points', pointsFC(committed));
  }, []);

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
    draftRef.current = [];
    hoverRef.current = null;
    drawDraft();
    reportDraft();
    // Two points is the minimum that describes a direction to offset from; anything less
    // is a stray click, not a street.
    if (points.length >= 2) latest.current.onDrawComplete?.(points);
  }, [drawDraft, reportDraft]);

  const cancelDraw = useCallback(() => {
    draftRef.current = [];
    hoverRef.current = null;
    drawDraft();
    reportDraft();
  }, [drawDraft, reportDraft]);

  const undoDraftPoint = useCallback(() => {
    draftRef.current = draftRef.current.slice(0, -1);
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
      overrides: latest.current.junctionOverrides,
      defaultCornerRadiusMeters: latest.current.defaultCornerRadiusMeters,
      trimAtJunctions: latest.current.trimAtJunctions,
      selectedJunctionKey: latest.current.selectedJunctionKey,
    });
    warn?.(data.warnings);
    reportJunctions?.(data.junctions, data.junctionWarnings);

    if (sw === null) {
      setData(map, 'bands', data.bands);
      setData(map, 'markings', data.markings);
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
      setData(map, 'centerlines', clipLinesEastOf(data.centerlines, minLng));
      setData(map, 'junction-paved', clipEastOf(data.junctionPaved, minLng));
      setData(map, 'junction-footprint', clipEastOf(data.junctionFootprint, minLng));
      setData(map, 'crossings', clipEastOf(data.crossings, minLng));
    }

    // Editing handles are never clipped: they are UI, not design, and a handle that
    // disappears behind the swipe divider is a handle you cannot grab.
    setData(map, 'vertices', data.vertices);
    setData(map, 'midpoints', data.midpoints);
    setData(map, 'junction-points', data.junctionPoints);
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

    const near = (event: MapMouseEvent, point: LngLat | undefined) => {
      if (!point) return false;
      const a = map.project(point);
      return Math.hypot(a.x - event.point.x, a.y - event.point.y) <= SNAP_PX;
    };

    map.on('click', (event) => {
      const active = latest.current.tool;
      const here: LngLat = [event.lngLat.lng, event.lngLat.lat];

      if (active === 'draw') {
        const draft = draftRef.current;
        // Clicking the last point again — which is also what the second half of a
        // double-click looks like — ends the line rather than stacking a duplicate.
        if (draft.length >= 2 && (near(event, draft[draft.length - 1]) || near(event, draft[0]))) {
          finishDraw();
          return;
        }
        draftRef.current = [...draft, here];
        drawDraft();
        reportDraft();
        return;
      }

      if (active === 'measure') {
        // A third click starts a fresh measurement rather than extending a two-point one.
        measureRef.current =
          measureRef.current.length >= 2 ? [here] : [...measureRef.current, here];
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
        if (typeof streetId === 'string') latest.current.onSelectStreet?.(streetId);
      } catch {
        // No design layers yet; nothing to select.
      }
    });

    map.on('mousemove', (event) => {
      const active = latest.current.tool;
      if (active === 'draw' && draftRef.current.length > 0) {
        hoverRef.current = [event.lngLat.lng, event.lngLat.lat];
        drawDraft();
      } else if (active === 'measure' && measureRef.current.length === 1) {
        hoverRef.current = [event.lngLat.lng, event.lngLat.lat];
        drawMeasure();
      }
    });

    map.on('dblclick', (event) => {
      if (latest.current.tool !== 'draw') return;
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
    const onDragMove = (event: MapMouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      latest.current.onVertexMove?.(drag.streetId, drag.index, [
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

    const beginDrag = (streetId: string, index: number) => {
      dragRef.current = { streetId, index };
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
      if (typeof streetId !== 'string' || typeof index !== 'number') return;

      event.preventDefault();

      // Alt-click removes. Held rather than a separate mode, because deleting a vertex is
      // a one-off correction, not somewhere you stay.
      if (event.originalEvent.altKey) {
        latest.current.onVertexDelete?.(streetId, index);
        return;
      }

      latest.current.onGestureStart?.();
      beginDrag(streetId, index);
    });

    // Grabbing a midpoint inserts a real vertex there and drags it in the same motion, so
    // "bend the street here" is one gesture and one undo step.
    map.on('mousedown', 'midpoint-point', (event) => {
      if (latest.current.tool !== 'select') return;
      const props = event.features?.[0]?.properties;
      const streetId = props?.['streetId'];
      const index = props?.['index'];
      if (typeof streetId !== 'string' || typeof index !== 'number') return;

      event.preventDefault();
      latest.current.onGestureStart?.();
      latest.current.onVertexInsert?.(streetId, index, [event.lngLat.lng, event.lngLat.lat]);
      beginDrag(streetId, index + 1);
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
    if (tool === 'select') return;

    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        if (tool === 'draw') cancelDraw();
        else clearMeasure();
      } else if (tool === 'draw' && event.key === 'Enter') {
        event.preventDefault();
        finishDraw();
      } else if (tool === 'draw' && (event.key === 'Backspace' || event.key === 'Delete')) {
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

    if (tool !== 'draw') cancelDraw();
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
    selectedStreetId,
    swipe,
    ready,
    scheduleRefresh,
    junctionOverrides,
    defaultCornerRadiusMeters,
    trimAtJunctions,
    selectedJunctionKey,
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

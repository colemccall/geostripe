import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl';
import type { MapOptions } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';

import { basemapById, tileUrlsFor, unconfiguredReason } from './basemaps';
import type { BasemapId, TileSourceOptions } from './basemaps';
import { buildDesignData, clipEastOf, clipLinesEastOf } from './designLayers';
import type { DesignData } from './designLayers';
import type { Street } from '../model/types';
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
 */

/** MapLibre 6 removed the default export and no longer re-exports StyleSpecification. */
type MapStyle = NonNullable<MapOptions['style']>;

export interface MapView {
  lng: number;
  lat: number;
  zoom: number;
}

interface Props {
  basemapId: BasemapId;
  sourceOptions: TileSourceOptions;
  units: DisplayUnits;
  streets: readonly Street[];
  selectedStreetId: string | null;
  /** 0..1 across the viewport; null hides the divider and shows the full design. */
  swipe: number | null;
  center: [number, number];
  zoom: number;
  onViewChange?: (view: MapView) => void;
  onSelectStreet?: (streetId: string) => void;
  onWarnings?: (warnings: DesignData['warnings']) => void;
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

const DESIGN_SOURCES = ['bands', 'markings', 'centerlines', 'vertices'] as const;

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
}

function setData(map: MapLibreMap, id: string, data: FeatureCollection) {
  const source = map.getSource(id);
  if (source && 'setData' in source) (source as { setData: (d: FeatureCollection) => void }).setData(data);
}

export default function MapCanvas({
  basemapId,
  sourceOptions,
  units,
  streets,
  selectedStreetId,
  swipe,
  center,
  zoom,
  onViewChange,
  onSelectStreet,
  onWarnings,
  onRenderStats,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const scaleRef = useRef<ScaleControl | null>(null);
  const [ready, setReady] = useState(false);

  // Latest values without making them effect dependencies, so the map is never rebuilt.
  const latest = useRef({ streets, selectedStreetId, swipe, onViewChange, onSelectStreet, onWarnings, onRenderStats });
  latest.current = { streets, selectedStreetId, swipe, onViewChange, onSelectStreet, onWarnings, onRenderStats };

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

    const { streets: s, selectedStreetId: sel, swipe: sw, onWarnings: warn } = latest.current;
    const data = buildDesignData(s, sel);
    warn?.(data.warnings);

    if (sw === null) {
      setData(map, 'bands', data.bands);
      setData(map, 'markings', data.markings);
      setData(map, 'centerlines', data.centerlines);
    } else {
      // Screen x -> longitude. Exact while the map is north-up, which it always is here.
      const x = map.getContainer().clientWidth * sw;
      const minLng = map.unproject([x, map.getContainer().clientHeight / 2]).lng;
      setData(map, 'bands', clipEastOf(data.bands, minLng));
      setData(map, 'markings', clipLinesEastOf(data.markings, minLng));
      setData(map, 'centerlines', clipLinesEastOf(data.centerlines, minLng));
    }

    setData(map, 'vertices', data.vertices);

    // queryRenderedFeatures only reports once tiles are built, so sample shortly after.
    const bandCount = data.bands.features.length;
    window.setTimeout(() => {
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
      if (latest.current.swipe !== null) refresh();
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

    map.on('click', 'band-fill', (e) => {
      const streetId = e.features?.[0]?.properties?.['streetId'];
      if (typeof streetId === 'string') latest.current.onSelectStreet?.(streetId);
    });
    map.on('mouseenter', 'band-fill', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'band-fill', () => {
      map.getCanvas().style.cursor = '';
    });

    return () => {
      map.remove();
      mapRef.current = null;
      scaleRef.current = null;
      setReady(false);
    };
    // Created once; every prop change below is applied to the live map instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (ready) refresh();
  }, [streets, selectedStreetId, swipe, ready, refresh]);

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
}

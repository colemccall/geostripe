import { useEffect, useRef, useState } from 'react';
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl';
import type { MapOptions } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// eslint-disable-next-line import/no-unresolved -- Vite virtual module
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

/**
 * Tell MapLibre where its worker actually is.
 *
 * Left alone, MapLibre locates the worker itself with
 * `new URL('./maplibre-gl-worker.mjs', import.meta.url)` — resolved relative to whatever
 * file it happens to be running from. That is wrong in both of our environments:
 *
 *   dev    Vite pre-bundles the entry into node_modules/.vite/deps/ without copying the
 *          sibling worker (also handled by optimizeDeps.exclude in vite.config.ts).
 *   build  import.meta.url is the hashed chunk in /assets/, so it resolves to
 *          /assets/maplibre-gl-worker.mjs — a file Rollup never emits. The map then
 *          silently fails to start: no tiles, no pan, no zoom.
 *
 * `?worker&url` makes Vite bundle the worker *with* its own dependency on
 * maplibre-gl-shared.mjs and hand back a URL that already accounts for the deploy base
 * path, so this works identically at /geostripe/ and at a custom domain root.
 */
setWorkerUrl(maplibreWorkerUrl);

import { basemapById, isUnconfigured, tileUrlsFor } from './basemaps';
import type { BasemapId } from './basemaps';
import type { DisplayUnits } from '../lib/units';

/**
 * MapLibre 6 removed the default export and no longer re-exports StyleSpecification.
 * Deriving the style type from MapOptions keeps us off `@maplibre/maplibre-gl-style-spec`,
 * which is only present transitively and could vanish on a minor bump.
 */
type MapStyle = NonNullable<MapOptions['style']>;

/**
 * MapLibre wrapper.
 *
 * The map instance is deliberately kept out of React state — it is a mutable, imperative
 * object with its own lifecycle, and letting React re-render it causes tile thrash. React
 * owns the container element; MapLibre owns everything inside it. The only bridge back is
 * a `view` readout, throttled to the map's own move events.
 *
 * Mercator projection is MapLibre's default and is what we want; globe would make the
 * planar geometry work that comes next meaningless at street scale.
 */

export interface MapView {
  lng: number;
  lat: number;
  zoom: number;
}

interface Props {
  basemapId: BasemapId;
  customTileUrl: string;
  units: DisplayUnits;
  /** Hides the imagery layer to reveal what is underneath — the before/after toggle. */
  showImagery?: boolean;
  onViewChange?: (view: MapView) => void;
}

/** Cincinnati — a real stroad to trace, and the spec's worked example. */
const INITIAL_CENTER: [number, number] = [-84.51338, 39.10814];
const INITIAL_ZOOM = 17.2;

function buildStyle(basemapId: BasemapId, customTileUrl: string): MapStyle {
  const basemap = basemapById(basemapId);
  const tiles = tileUrlsFor(basemapId, customTileUrl);

  return {
    version: 8,
    // No symbol layers yet, so no glyph server is needed. Add one before the first
    // text-bearing layer or labels will silently fail to render.
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
      ? [{ id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-opacity': 1 } }]
      : [],
  };
}

export default function MapCanvas({
  basemapId,
  customTileUrl,
  units,
  showImagery = true,
  onViewChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const scaleRef = useRef<ScaleControl | null>(null);
  const [ready, setReady] = useState(false);

  // Keep the latest callback without making it an effect dependency, so changing the
  // handler never tears down and rebuilds the map.
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  // ---- create once
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: buildStyle(basemapId, customTileUrl),
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      maxZoom: 22,
      // Added explicitly below in compact form; the default control is not compact.
      attributionControl: false,
    });

    mapRef.current = map;

    map.addControl(new NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');

    const scale = new ScaleControl({
      maxWidth: 110,
      unit: units === 'ft' ? 'imperial' : 'metric',
    });
    scaleRef.current = scale;
    map.addControl(scale, 'bottom-left');

    const report = () => {
      const c = map.getCenter();
      onViewChangeRef.current?.({ lng: c.lng, lat: c.lat, zoom: map.getZoom() });
    };
    map.on('move', report);
    map.on('load', () => {
      setReady(true);
      report();
    });

    // MapLibre routes tile, source and style failures to this event and swallows them
    // otherwise — without it a broken imagery source is indistinguishable from a working
    // one that happens to be dark, which is exactly how a blank map hides its cause.
    map.on('error', (e) => {
      console.error('[GeoStripe] MapLibre error:', e.error?.message ?? e, e);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      scaleRef.current = null;
      setReady(false);
    };
    // Created once on mount. Basemap and unit changes are handled by the effects below,
    // which mutate the live map rather than recreating it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- basemap switching
  //
  // `ready` has to be a dependency (the map must exist before setStyle), but that means
  // this fires the instant load completes — re-setting the style the map just finished
  // building and refetching every tile. The ref skips that first run so only a genuine
  // basemap change reaches setStyle.
  const appliedBasemapRef = useRef(`${basemapId}|${customTileUrl}`);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const key = `${basemapId}|${customTileUrl}`;
    if (appliedBasemapRef.current === key) return;
    appliedBasemapRef.current = key;
    map.setStyle(buildStyle(basemapId, customTileUrl));
  }, [basemapId, customTileUrl, ready]);

  // ---- scale bar unit follows the app's display unit
  useEffect(() => {
    scaleRef.current?.setUnit(units === 'ft' ? 'imperial' : 'metric');
  }, [units]);

  // ---- before/after: hide imagery without tearing the style down
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!map.getLayer('basemap')) return;
    map.setLayoutProperty('basemap', 'visibility', showImagery ? 'visible' : 'none');
  }, [showImagery, ready]);

  const unconfigured = isUnconfigured(basemapId, customTileUrl);

  return (
    <div className="map-host">
      <div ref={containerRef} className="map-canvas" />
      {unconfigured && (
        <div className="map-empty">
          <p>
            <strong>No tile URL set.</strong> Paste an XYZ template containing{' '}
            <code>{'{z}/{x}/{y}'}</code> to use a custom imagery source.
          </p>
        </div>
      )}
    </div>
  );
}

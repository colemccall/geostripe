/**
 * Satellite imagery sources.
 *
 * Verified against the live services rather than taken from documentation, because the
 * documented answer and the real one differ in a way that matters:
 *
 *   Esri World Imagery      serves z20 in urban areas (~0.15–0.3 m/px), global, no key.
 *                           Licensing is a grey area — Esri's blanket permission is
 *                           scoped to OpenStreetMap editing, not arbitrary apps.
 *
 *   USGS NAIP               unambiguously public domain and needs no key, but only the
 *                           *dynamic* ImageServer is usable. The tile cache at
 *                           basemap.nationalmap.gov stops dead at z16 (~1.9 m/px, where
 *                           a 3 m lane is under two pixels), which is useless for
 *                           tracing. exportImage renders at request resolution instead.
 *                           US only, ~0.6 m/px, slightly softer than Esri.
 *
 * Esri is the default for sharpness and coverage; NAIP is the clean-licence option. The
 * whole thing is a swappable config, so revisiting this later costs nothing.
 */

export type BasemapId = 'esri' | 'usgsNaip' | 'custom';

export interface Basemap {
  readonly id: BasemapId;
  readonly label: string;
  readonly licence: string;
  readonly attribution: string;
  readonly tileSize: number;
  /** Highest zoom with real tiles; MapLibre upscales beyond this rather than blanking. */
  readonly maxzoom: number;
  readonly coverage: string;
}

export const BASEMAPS: readonly Basemap[] = [
  {
    id: 'esri',
    label: 'Esri World Imagery',
    licence: 'No key · see licensing note',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    tileSize: 256,
    maxzoom: 20,
    coverage: 'Global',
  },
  {
    id: 'usgsNaip',
    label: 'USGS NAIP',
    licence: 'Public domain · no key',
    attribution: 'Imagery courtesy USGS / USDA NAIP — public domain',
    tileSize: 256,
    maxzoom: 19,
    coverage: 'United States',
  },
  {
    id: 'custom',
    label: 'Custom XYZ…',
    licence: 'Per your source',
    attribution: 'Custom tile source',
    tileSize: 256,
    maxzoom: 22,
    coverage: 'Per your source',
  },
];

export function basemapById(id: BasemapId): Basemap {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0]!;
}

/**
 * Tile URL templates for a source.
 *
 * NAIP is an ArcGIS ImageServer, not a tile cache, so it is addressed by bounding box.
 * MapLibre substitutes `{bbox-epsg-3857}` per tile, which turns a dynamic image service
 * into something a raster source can consume.
 */
export function tileUrlsFor(id: BasemapId, customUrl: string): string[] {
  switch (id) {
    case 'esri':
      return [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ];
    case 'usgsNaip':
      return [
        'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage' +
          '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256' +
          '&format=jpg&transparent=false&f=image',
      ];
    case 'custom':
      return customUrl.trim() ? [customUrl.trim()] : [];
  }
}

/** True when the chosen source cannot render — used to show a helpful empty state. */
export function isUnconfigured(id: BasemapId, customUrl: string): boolean {
  return id === 'custom' && !customUrl.trim();
}

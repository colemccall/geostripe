/**
 * Satellite imagery sources.
 *
 * Every claim here was verified against the live services, because the documented answer
 * and the real one differ in ways that matter:
 *
 *   Esri World Imagery (free)  Over Cincinnati the source is a WorldView-2 *satellite*
 *                             pass from 2021-11-29 (0.5 m native, resampled to 0.3 m).
 *                             Late November at 39N means no canopy and very long shadows.
 *                             Esri's own metadata service confirms it, and every Wayback
 *                             release since 2022 still points at that same photo. No
 *                             higher-resolution aerial is indexed there at all.
 *
 *   Esri (current, keyed)     ArcGIS Pro looks better because it authenticates against
 *                             ibasemaps-api.arcgis.com, which answers an unauthenticated
 *                             request with {"error":{"code":499,"message":"Token
 *                             Required."}}. A free ArcGIS developer key unlocks it.
 *
 *   Esri Wayback              196 published versions of World Imagery. Where a location
 *                             has been recaptured, older releases can be dramatically
 *                             better — around Cincinnati the 2017 and 2019 captures are
 *                             leaf-on with short shadows.
 *
 *   USGS NAIP                 Flown during the agricultural growing season, near-nadir,
 *                             so it is bright, leaf-on and almost shadow-free. Softer
 *                             (0.6-1 m, and resolution genuinely varies by state and
 *                             year) but for tracing a street it beats a low-sun winter
 *                             satellite pass. Public domain, no key, US only.
 *
 * Hence the default: NAIP. Sharpest is not the same as most useful.
 */

export type BasemapId = 'usgsNaip' | 'esri' | 'esriClarity' | 'esriWayback' | 'esriCurrent' | 'custom';

export interface Basemap {
  readonly id: BasemapId;
  readonly label: string;
  readonly detail: string;
  readonly attribution: string;
  readonly tileSize: number;
  readonly maxzoom: number;
  /** Needs an ArcGIS API key before it can be selected. */
  readonly requiresKey?: boolean;
  /** Offers the Wayback vintage dropdown. */
  readonly hasVintage?: boolean;
}

export const BASEMAPS: readonly Basemap[] = [
  {
    id: 'usgsNaip',
    label: 'USGS NAIP',
    detail: 'Growing-season aerial · public domain · US only',
    attribution: 'Imagery courtesy USGS / USDA NAIP — public domain',
    tileSize: 256,
    maxzoom: 19,
  },
  {
    id: 'esri',
    label: 'Esri World Imagery',
    detail: 'Global · no key · vintage varies by area',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    tileSize: 256,
    maxzoom: 20,
  },
  {
    id: 'esriWayback',
    label: 'Esri Wayback',
    detail: 'Pick a capture date — often better than the current one',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics (Wayback)',
    tileSize: 256,
    maxzoom: 20,
    hasVintage: true,
  },
  {
    id: 'esriClarity',
    label: 'Esri Clarity',
    detail: 'Alternative Esri service · sometimes a different capture',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics (Clarity)',
    tileSize: 256,
    maxzoom: 20,
  },
  {
    id: 'esriCurrent',
    label: 'Esri current (API key)',
    detail: 'The freshest Esri imagery — same service ArcGIS Pro uses',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    tileSize: 256,
    maxzoom: 22,
    requiresKey: true,
  },
  {
    id: 'custom',
    label: 'Custom XYZ…',
    detail: 'Any tile service, including a local authority orthophoto',
    attribution: 'Custom tile source',
    tileSize: 256,
    maxzoom: 22,
  },
];

/**
 * Wayback vintages: a spread across the archive, one per year or so.
 *
 * Wayback deduplicates — if a location was not recaptured between two releases, the
 * older one redirects to the newer. So picking a date that predates the imagery you want
 * is harmless; you simply get the capture that was current then.
 */
export interface Vintage {
  readonly release: string;
  readonly label: string;
  readonly note?: string;
}

export const WAYBACK_VINTAGES: readonly Vintage[] = [
  { release: '49059', label: '2026-04' },
  { release: '52304', label: '2025-09' },
  { release: '13968', label: '2024-03' },
  { release: '17632', label: '2023-08' },
  { release: '44710', label: '2022-06', note: 'current capture in many US cities' },
  { release: '13534', label: '2021-06' },
  { release: '11135', label: '2020-06' },
  { release: '12576', label: '2019-06', note: 'leaf-on around Cincinnati' },
  { release: '11334', label: '2018-06' },
  { release: '14035', label: '2017-08', note: 'leaf-on, short shadows' },
  { release: '11509', label: '2016-06' },
  { release: '28219', label: '2015-08' },
  { release: '10', label: '2014-02' },
];

export const DEFAULT_VINTAGE = '14035';

export function basemapById(id: BasemapId): Basemap {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0]!;
}

export interface TileSourceOptions {
  customUrl?: string;
  waybackRelease?: string;
  arcgisApiKey?: string;
}

/**
 * Tile URL templates for a source.
 *
 * NAIP is an ArcGIS ImageServer rather than a tile cache, so it is addressed by bounding
 * box; MapLibre substitutes {bbox-epsg-3857} per tile, which turns a dynamic image
 * service into something a raster source can consume. Note the tile cache at
 * basemap.nationalmap.gov is NOT used — it stops at zoom 16 (~1.9 m/px), where a 3 m lane
 * is under two pixels wide.
 */
export function tileUrlsFor(id: BasemapId, options: TileSourceOptions = {}): string[] {
  const { customUrl = '', waybackRelease = DEFAULT_VINTAGE, arcgisApiKey = '' } = options;

  switch (id) {
    case 'usgsNaip':
      return [
        'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage' +
          '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256' +
          '&format=jpg&transparent=false&f=image',
      ];
    case 'esri':
      return [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ];
    case 'esriClarity':
      return [
        'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ];
    case 'esriWayback':
      return [
        'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/' +
          `default028mm/MapServer/tile/${waybackRelease}/{z}/{y}/{x}`,
      ];
    case 'esriCurrent':
      return arcgisApiKey.trim()
        ? [
            'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' +
              `?token=${encodeURIComponent(arcgisApiKey.trim())}`,
          ]
        : [];
    case 'custom':
      return customUrl.trim() ? [customUrl.trim()] : [];
  }
}

/** Why a source cannot render right now, or null if it can. */
export function unconfiguredReason(id: BasemapId, options: TileSourceOptions = {}): string | null {
  if (id === 'custom' && !options.customUrl?.trim()) {
    return 'Paste an XYZ tile URL containing {z}/{x}/{y} to use a custom source.';
  }
  if (id === 'esriCurrent' && !options.arcgisApiKey?.trim()) {
    return 'Add a free ArcGIS developer API key to use Esri’s current imagery — the same service ArcGIS Pro uses.';
  }
  return null;
}

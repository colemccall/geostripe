import { z } from 'zod';
import type { Feature, FeatureCollection } from 'geojson';
import { ASSET_FAMILIES } from './asset';
import type { Asset, AssetFamily } from './asset';
import { componentSchema } from './schema';
import { emptyDoc, newAreaId, newBuildingId, newDistrictId, newNodeId, newSegmentId, newZoneId } from './doc';
import type { AreaShape, Building, District, Doc, Node, Segment, Zone } from './doc';
import { isLandUseId } from '../library/landuse';
import { isBuildingTypeId } from '../library/buildingTypes';
import { newId } from './types';
import type { SectionComponent } from './types';
import { bandsForSegment } from '../geo/bands';
import { closeRing, resolveCenterline, resolveRing } from '../geo/curve';
import { builtInAssets } from '../library/assets';
import { LANDCOVER_TYPES } from '../library/landcover';
import { PRIMITIVES } from '../library/primitives';
import { EDITOR_VERSION } from '../lib/version';
import type { LngLat } from '../geo/crs';

/**
 * The project file: plain GeoJSON, readable by QGIS, editable by hand.
 *
 * Three kinds of feature share one collection, and which of them is read back is the whole
 * design:
 *
 *   node      a Point. Read back. The places roads meet.
 *   segment   a LineString of CONTROL points. Read back. The roads themselves.
 *   area      a Polygon of control points. Read back.
 *   band      the derived polygons. Written, never read back.
 *
 * The bands are generated here, once, at save. That is the only place polygons are built
 * in the whole editor now — the map draws roads as offset lines and computes none — and
 * writing them anyway is what keeps the file useful to something that is not this program.
 * Discarding them on load is what keeps a reopened project parametric instead of frozen: a
 * width you can still change, rather than a picture of one.
 *
 * The palette rides along in a foreign member on the collection. GeoJSON permits members it
 * does not define and readers ignore them, so a file stays valid GeoJSON while carrying the
 * asset definitions its segments refer to. Without them a project opened elsewhere would be
 * a set of roads that know their type by name and nothing about what that type is.
 */

/**
 * File format version.
 *
 *   2   nodes, segments, areas.
 *   3   adds zones, buildings and districts. A version 2 file has none of them and reads as
 *       a version 3 file with those lists empty, so no rewriting is needed to migrate it.
 *
 * A file from a NEWER version is read as far as it can be and says what was left out; it is
 * never refused outright, because a planner's file should open.
 */
export const PROJECT_VERSION = 3;

/** Largest project file read, in bytes. A guard against opening something that is not one. */
export const MAX_PROJECT_BYTES = 80 * 1024 * 1024;

/** Elevation is authored freely but drawn on three decks; this is the range the UI offers. */
const ELEVATION_RANGE = [-2, 2] as const;
const RADIUS_RANGE = [0, 200] as const;

const clamp = (value: number, [min, max]: readonly [number, number]) =>
  Math.min(max, Math.max(min, value));

const positionSchema = z
  .array(z.number().finite())
  .min(2)
  .refine((p) => Math.abs(p[0]!) <= 180 && Math.abs(p[1]!) <= 90, {
    message: 'coordinates must be [longitude, latitude] in degrees',
  });

const curveSchema = z.object({
  mode: z.enum(['straight', 'rounded', 'smooth']),
  radiusMeters: z.number().finite().min(0).max(2000),
  sharpVertices: z.array(z.number().int().min(0).max(9999)).max(4096).optional(),
});

const lineAssetSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  kind: z.literal('line'),
  family: z.enum(ASSET_FAMILIES),
  components: z.array(componentSchema).min(1).max(64),
  anchorOffsetMeters: z.number().finite().nullable(),
  cornerRadiusMeters: z.number().finite().min(0).max(200).optional(),
  builtIn: z.boolean().optional(),
});

const areaAssetSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  kind: z.literal('area'),
  family: z.literal('area'),
  material: z.enum(LANDCOVER_TYPES),
  builtIn: z.boolean().optional(),
});

const assetSchema = z.discriminatedUnion('kind', [lineAssetSchema, areaAssetSchema]);

const paletteSchema = z.object({
  version: z.number().int().optional(),
  name: z.string().max(200).optional(),
  editor: z.string().max(60).optional(),
  assets: z.array(assetSchema).max(2000).optional(),
});

// ------------------------------------------------------------------------- writing

export interface ProjectMeta {
  name: string;
  /** Include the derived band polygons. Off makes a much smaller file for round-tripping. */
  includeBands?: boolean;
}

/**
 * Build the file.
 *
 * Segment geometry is the CONTROL line — node, shape points, node — not the tessellated
 * curve. Writing the tessellation would round-trip a curve into a hundred-point polyline
 * that can no longer be re-curved, which is the same mistake as writing the bands and
 * reading them back.
 */
export function toProjectGeoJSON(
  doc: Doc,
  assets: readonly Asset[],
  meta: ProjectMeta,
): FeatureCollection {
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const features: Feature[] = [];

  for (const node of doc.nodes) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: node.position },
      properties: {
        streetcity: 'node',
        id: node.id,
        name: node.name,
        elevation: node.elevation,
        radiusMeters: node.radiusMeters,
      },
    });
  }

  for (const segment of doc.segments) {
    const from = nodes.get(segment.fromNodeId);
    const to = nodes.get(segment.toNodeId);
    if (!from || !to) continue;
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [from.position, ...segment.shape, to.position],
      },
      properties: {
        streetcity: 'segment',
        id: segment.id,
        name: segment.name,
        assetId: segment.assetId,
        fromNodeId: segment.fromNodeId,
        toNodeId: segment.toNodeId,
        reversed: segment.reversed,
        curve: segment.curve,
        visible: segment.visible,
      },
    });
  }

  for (const area of doc.areas) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [closeRing(resolveRing(area))] },
      properties: {
        streetcity: 'area',
        id: area.id,
        name: area.name,
        assetId: area.assetId,
        // The control ring, so a curved boundary reopens curved. The geometry above is the
        // resolved one, which is what a reader that is not this program should see.
        ring: area.ring,
        curve: area.curve,
        visible: area.visible,
      },
    });
  }

  for (const zone of doc.zones) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: zone.rings.map(closeRing) },
      properties: {
        streetcity: 'zone',
        id: zone.id,
        landUse: zone.landUse,
        visible: zone.visible,
      },
    });
  }

  for (const building of doc.buildings) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: building.position },
      properties: {
        streetcity: 'building',
        id: building.id,
        typeId: building.typeId,
        rotation: building.rotation,
        visible: building.visible,
      },
    });
  }

  for (const district of doc.districts) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: district.rings.map(closeRing) },
      properties: {
        streetcity: 'district',
        id: district.id,
        name: district.name,
        color: district.color,
        visible: district.visible,
      },
    });
  }

  if (meta.includeBands !== false) {
    for (const segment of doc.segments) {
      if (segment.visible === false) continue;
      const asset = byId.get(segment.assetId);
      if (!asset || asset.kind !== 'line') continue;
      const from = nodes.get(segment.fromNodeId);
      const to = nodes.get(segment.toNodeId);
      if (!from || !to) continue;

      const line = resolveCenterline({
        id: segment.id,
        centerline: [from.position, ...segment.shape, to.position],
        curve: segment.curve,
      });
      const bands = bandsForSegment(line, asset, {
        properties: { streetcity: 'band', segmentId: segment.id, assetName: asset.name },
      });
      for (const band of bands) features.push(band as Feature);
    }
  }

  return {
    type: 'FeatureCollection',
    features,
    // Foreign members: valid GeoJSON, ignored by readers that do not know them.
    streetcity: {
      version: PROJECT_VERSION,
      name: meta.name,
      editor: EDITOR_VERSION,
      assets: assetsToWrite(doc, assets),
    },
  } as FeatureCollection;
}

/**
 * Which assets the file has to carry.
 *
 * Not all of them. A project referring to four road types does not need the other hundred
 * and seventy-five written into it — that turned a sixteen-road file into a quarter of a
 * megabyte of palette, almost none of which the document used.
 *
 * Two things must be written, and between them they lose nothing:
 *
 *   every asset the document REFERS TO, or a reopened road would not know its own width;
 *   every asset that is not still exactly as shipped, because the reader's own copy of a
 *     built-in is only the right substitute while nobody has changed it.
 *
 * That second rule is why editing a built-in clears its `builtIn` flag in the store. The
 * flag means "still the shipped one", not "came from the shipped set", and it is the only
 * thing making this safe to leave out.
 */
function assetsToWrite(doc: Doc, assets: readonly Asset[]): Asset[] {
  const used = new Set<string>();
  for (const segment of doc.segments) used.add(segment.assetId);
  for (const area of doc.areas) used.add(area.assetId);
  return assets.filter((asset) => used.has(asset.id) || asset.builtIn !== true);
}

export function serializeProject(
  doc: Doc,
  assets: readonly Asset[],
  meta: ProjectMeta,
): string {
  return JSON.stringify(toProjectGeoJSON(doc, assets, meta), null, 2);
}

export function projectFilename(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'project'}.geojson`;
}

// ------------------------------------------------------------------------- reading

export interface ParseResult {
  doc: Doc;
  assets: Asset[];
  name: string;
  /** Version the file declared, or 1 when it declared none. */
  version: number;
  /** What was dropped and why. A file with one bad road loses that road, not the project. */
  warnings: string[];
}

/**
 * Read a project.
 *
 * Deliberately forgiving in one direction only: anything it cannot understand is dropped
 * with a reason, and nothing is guessed at. A bare LineString with no properties at all
 * imports as a road with the default asset, which is what makes it possible to drop in a
 * way traced in OSM or QGIS and build on it.
 */
export function parseProject(text: string, palette: readonly Asset[]): ParseResult {
  const warnings: string[] = [];
  let raw: unknown;

  if (text.length > MAX_PROJECT_BYTES) {
    return {
      doc: emptyDoc(),
      assets: [...palette],
      name: 'Untitled',
      version: 0,
      warnings: ['That file is too large to be a project.'],
    };
  }

  try {
    raw = JSON.parse(text);
  } catch {
    return {
      doc: emptyDoc(),
      assets: [...palette],
      name: 'Untitled',
      version: 0,
      warnings: ['That file is not valid JSON.'],
    };
  }

  const collection = raw as FeatureCollection & { streetcity?: unknown; geostripe?: unknown };
  if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    return {
      doc: emptyDoc(),
      assets: [...palette],
      name: 'Untitled',
      version: 0,
      warnings: ['That file is not a GeoJSON FeatureCollection.'],
    };
  }

  const meta = paletteSchema.safeParse(collection.streetcity ?? {});
  if (!meta.success && collection.streetcity) {
    warnings.push('The palette in that file could not be read, so built-in road types were used instead.');
  }
  const version =
    typeof (collection.streetcity as { version?: unknown } | undefined)?.version === 'number'
      ? ((collection.streetcity as { version: number }).version)
      : 1;
  if (version > PROJECT_VERSION) {
    warnings.push(
      `That file was made by a newer version (format ${version}). It was opened as far as this version understands it.`,
    );
  }
  const fileAssets = meta.success && meta.data.assets ? meta.data.assets : [];
  const name = (meta.success && meta.data.name) || 'Untitled';

  // The palette is the file's assets over the built-ins, so a project opened on a machine
  // whose library has moved on still draws the way its author saw it.
  const assets: Asset[] = [...palette];
  for (const asset of fileAssets) {
    const at = assets.findIndex((a) => a.id === asset.id);
    const materialised = materialise(asset);
    if (at >= 0) assets[at] = materialised;
    else assets.push(materialised);
  }

  // A file from the street-based editor, which this no longer reads. Said plainly rather
  // than half-read: those files have no nodes in them at all, so anything produced from one
  // would be an invention rather than a conversion.
  if (collection.features.some((f) => typeof f.properties?.geostripe === 'string')) {
    return {
      doc: emptyDoc(),
      assets,
      name,
      version,
      warnings: [
        'That file is in the old street format, which this version no longer reads.',
      ],
    };
  }

  return {
    doc: readNative(collection.features, warnings, new Set(assets.map((a) => a.id))),
    assets,
    name,
    version,
    warnings,
  };
}

/** Give a parsed asset the runtime component ids the editor selects on. */
function materialise(asset: z.infer<typeof assetSchema>): Asset {
  if (asset.kind === 'area') return asset;
  return {
    ...asset,
    family: asset.family === 'area' ? 'street' : (asset.family as Exclude<AssetFamily, 'area'>),
    components: asset.components.map((c) => ({
      ...c,
      id: newId('c'),
      direction: c.direction ?? PRIMITIVES[c.componentType].defaultDirection,
    })) as SectionComponent[],
  };
}

/** A list of rings from a GeoJSON Polygon, unclosed, each with at least three valid points. */
function readRings(coordinates: unknown): LngLat[][] | null {
  if (!Array.isArray(coordinates)) return null;
  const rings: LngLat[][] = [];
  for (const ring of coordinates) {
    if (!Array.isArray(ring)) return null;
    const points: LngLat[] = [];
    for (const p of ring) {
      const parsed = positionSchema.safeParse(p);
      if (!parsed.success) return null;
      points.push([parsed.data[0]!, parsed.data[1]!]);
    }
    // GeoJSON closes rings by repeating the first point; the document does not.
    const first = points[0];
    const last = points[points.length - 1];
    if (first && last && points.length > 1 && first[0] === last[0] && first[1] === last[1]) points.pop();
    if (points.length < 3) return null;
    rings.push(points);
  }
  return rings.length > 0 ? rings : null;
}

function readNative(features: readonly Feature[], warnings: string[], assetIds: ReadonlySet<string>): Doc {
  const nodes: Node[] = [];
  const segments: Segment[] = [];
  const areas: AreaShape[] = [];
  const zones: Zone[] = [];
  const buildings: Building[] = [];
  const districts: District[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  /** True when this id was already used by an earlier feature of the same kind. */
  const duplicate = (kind: string, id: string): boolean => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) {
      duplicates++;
      return true;
    }
    seen.add(key);
    return false;
  };

  for (const feature of features) {
    const kind = feature.properties?.streetcity;

    if (kind === 'node' && feature.geometry?.type === 'Point') {
      const position = positionSchema.safeParse(feature.geometry.coordinates);
      if (!position.success) {
        warnings.push('A node had coordinates that are not [longitude, latitude].');
        continue;
      }
      const nodeId = String(feature.properties!.id ?? newNodeId());
      if (duplicate('node', nodeId)) continue;
      nodes.push({
        id: nodeId,
        name: feature.properties!.name || undefined,
        position: position.data.slice(0, 2) as LngLat,
        elevation:
          typeof feature.properties!.elevation === 'number' && Number.isFinite(feature.properties!.elevation)
            ? Math.round(clamp(feature.properties!.elevation, ELEVATION_RANGE))
            : undefined,
        radiusMeters:
          typeof feature.properties!.radiusMeters === 'number' && Number.isFinite(feature.properties!.radiusMeters)
            ? clamp(feature.properties!.radiusMeters, RADIUS_RANGE)
            : undefined,
      });
      continue;
    }

    if (kind === 'segment' && feature.geometry?.type === 'LineString') {
      const props = feature.properties!;
      const coordinates = feature.geometry.coordinates as LngLat[];
      if (coordinates.length < 2) {
        warnings.push('A road had fewer than two points and was dropped.');
        continue;
      }
      const curve = props.curve ? curveSchema.safeParse(props.curve) : null;
      const shape = coordinates.slice(1, -1).map((p) => positionSchema.safeParse(p));
      if (shape.some((p) => !p.success)) {
        warnings.push('A road had a bend with coordinates that are not [longitude, latitude] and was dropped.');
        continue;
      }
      const segmentId = String(props.id ?? newSegmentId());
      if (duplicate('segment', segmentId)) continue;
      segments.push({
        id: segmentId,
        name: props.name || undefined,
        assetId: String(props.assetId ?? ''),
        fromNodeId: String(props.fromNodeId ?? ''),
        toNodeId: String(props.toNodeId ?? ''),
        // The two ends are the nodes and are not stored on the segment.
        shape: shape.map((p) => [p.data![0]!, p.data![1]!] as LngLat),
        curve: curve?.success ? curve.data : undefined,
        reversed: props.reversed === true ? true : undefined,
        visible: props.visible !== false,
      });
      continue;
    }

    if (kind === 'area' && feature.geometry?.type === 'Polygon') {
      const props = feature.properties!;
      const stored = Array.isArray(props.ring) ? (props.ring as LngLat[]) : null;
      const ring = stored ?? (feature.geometry.coordinates[0] as LngLat[]).slice(0, -1);
      if (!ring || ring.length < 3) {
        warnings.push('An area had fewer than three points and was dropped.');
        continue;
      }
      if (ring.some((p) => !positionSchema.safeParse(p).success)) {
        warnings.push('An area had coordinates that are not [longitude, latitude] and was dropped.');
        continue;
      }
      const curve = props.curve ? curveSchema.safeParse(props.curve) : null;
      const areaId = String(props.id ?? newAreaId());
      if (duplicate('area', areaId)) continue;
      areas.push({
        id: areaId,
        name: props.name || undefined,
        assetId: String(props.assetId ?? ''),
        ring: ring.map((p) => [p[0], p[1]] as LngLat),
        curve: curve?.success ? curve.data : undefined,
        visible: props.visible !== false,
      });
      continue;
    }

    if (kind === 'zone' && feature.geometry?.type === 'Polygon') {
      const props = feature.properties!;
      const rings = readRings(feature.geometry.coordinates);
      if (!rings || !isLandUseId(props.landUse)) {
        warnings.push('A zone had a land use or an outline this version does not understand and was dropped.');
        continue;
      }
      const zoneId = String(props.id ?? newZoneId());
      if (duplicate('zone', zoneId)) continue;
      zones.push({ id: zoneId, landUse: props.landUse, rings, visible: props.visible !== false });
      continue;
    }

    if (kind === 'building' && feature.geometry?.type === 'Point') {
      const props = feature.properties!;
      const position = positionSchema.safeParse(feature.geometry.coordinates);
      if (!position.success || !isBuildingTypeId(props.typeId)) {
        warnings.push('A building had a type or a position this version does not understand and was dropped.');
        continue;
      }
      const buildingId = String(props.id ?? newBuildingId());
      if (duplicate('building', buildingId)) continue;
      buildings.push({
        id: buildingId,
        typeId: props.typeId,
        position: [position.data[0]!, position.data[1]!],
        rotation: typeof props.rotation === 'number' && Number.isFinite(props.rotation) ? props.rotation : 0,
        visible: props.visible !== false,
      });
      continue;
    }

    if (kind === 'district' && feature.geometry?.type === 'Polygon') {
      const props = feature.properties!;
      const rings = readRings(feature.geometry.coordinates);
      if (!rings) {
        warnings.push('A district had an outline this version does not understand and was dropped.');
        continue;
      }
      const districtId = String(props.id ?? newDistrictId());
      if (duplicate('district', districtId)) continue;
      districts.push({
        id: districtId,
        name: typeof props.name === 'string' && props.name ? props.name : 'District',
        color: typeof props.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(props.color) ? props.color : '#4DA3FF',
        rings,
        visible: props.visible !== false,
      });
    }
  }

  if (duplicates > 0) warnings.push(`${duplicates} feature(s) repeated an id already used and were dropped.`);

  // Roads and shapes that name an asset the palette does not have cannot be drawn and
  // cannot be repaired from the UI, so they are dropped with a count.
  const knownSegments = segments.filter((s) => assetIds.has(s.assetId));
  const knownAreas = areas.filter((a) => assetIds.has(a.assetId));
  const unknown = segments.length - knownSegments.length + (areas.length - knownAreas.length);
  if (unknown > 0) warnings.push(`${unknown} road(s) or shape(s) used a type that is not in the file's palette and were dropped.`);
  segments.length = 0;
  segments.push(...knownSegments);
  areas.length = 0;
  areas.push(...knownAreas);

  // Drop roads whose nodes did not survive, rather than leaving the document referring to
  // places that are not there.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const kept = segments.filter((s) => nodeIds.has(s.fromNodeId) && nodeIds.has(s.toNodeId));
  if (kept.length !== segments.length) {
    warnings.push(`${segments.length - kept.length} road(s) referred to missing nodes.`);
  }

  return { nodes, segments: kept, areas, zones, buildings, districts };
}

/** A palette for a file that brought none: the built-ins, exactly as a new project gets. */
export const defaultPalette = builtInAssets;

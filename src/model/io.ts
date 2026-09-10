import { z } from 'zod';
import type { Feature, FeatureCollection } from 'geojson';
import { ASSET_FAMILIES } from './asset';
import type { Asset, AssetFamily } from './asset';
import { componentSchema } from './schema';
import { emptyDoc, newAreaId, newNodeId, newSegmentId } from './doc';
import type { AreaShape, Doc, Node, Segment } from './doc';
import { newId } from './types';
import type { SectionComponent } from './types';
import { bandsForSegment } from '../geo/bands';
import { closeRing, resolveCenterline, resolveRing } from '../geo/curve';
import { distanceMeters } from '../geo/measure';
import { builtInAssets } from '../library/assets';
import { LANDCOVER_TYPES } from '../library/landcover';
import { PRIMITIVES } from '../library/primitives';
import { EDITOR_VERSION } from '../lib/version';
import type { LngLat } from '../geo/projection';

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

export const PROJECT_VERSION = 2;

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
  /** What was dropped and why. A file with one bad road loses that road, not the project. */
  warnings: string[];
  /** Set when the file was written by the old street-based editor and had to be converted. */
  converted: boolean;
}

/** Two ends this close were meant to be the same place. */
const WELD_METRES = 1.5;

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

  try {
    raw = JSON.parse(text);
  } catch {
    return {
      doc: emptyDoc(),
      assets: [...palette],
      name: 'Untitled',
      warnings: ['That file is not valid JSON.'],
      converted: false,
    };
  }

  const collection = raw as FeatureCollection & { streetcity?: unknown; geostripe?: unknown };
  if (!collection || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    return {
      doc: emptyDoc(),
      assets: [...palette],
      name: 'Untitled',
      warnings: ['That file is not a GeoJSON FeatureCollection.'],
      converted: false,
    };
  }

  const meta = paletteSchema.safeParse(collection.streetcity ?? {});
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

  const isLegacy = collection.features.some(
    (f) => typeof f.properties?.geostripe === 'string',
  );

  const doc = isLegacy
    ? convertLegacy(collection.features, assets, warnings)
    : readNative(collection.features, warnings);

  return { doc, assets, name, warnings, converted: isLegacy };
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

function readNative(features: readonly Feature[], warnings: string[]): Doc {
  const nodes: Node[] = [];
  const segments: Segment[] = [];
  const areas: AreaShape[] = [];

  for (const feature of features) {
    const kind = feature.properties?.streetcity;

    if (kind === 'node' && feature.geometry?.type === 'Point') {
      const position = positionSchema.safeParse(feature.geometry.coordinates);
      if (!position.success) {
        warnings.push('A node had coordinates that are not [longitude, latitude].');
        continue;
      }
      nodes.push({
        id: String(feature.properties!.id ?? newNodeId()),
        name: feature.properties!.name || undefined,
        position: position.data.slice(0, 2) as LngLat,
        elevation:
          typeof feature.properties!.elevation === 'number'
            ? feature.properties!.elevation
            : undefined,
        radiusMeters:
          typeof feature.properties!.radiusMeters === 'number'
            ? feature.properties!.radiusMeters
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
      segments.push({
        id: String(props.id ?? newSegmentId()),
        name: props.name || undefined,
        assetId: String(props.assetId ?? ''),
        fromNodeId: String(props.fromNodeId ?? ''),
        toNodeId: String(props.toNodeId ?? ''),
        // The two ends are the nodes and are not stored on the segment.
        shape: coordinates.slice(1, -1).map((p) => [p[0], p[1]] as LngLat),
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
      const curve = props.curve ? curveSchema.safeParse(props.curve) : null;
      areas.push({
        id: String(props.id ?? newAreaId()),
        name: props.name || undefined,
        assetId: String(props.assetId ?? ''),
        ring: ring.map((p) => [p[0], p[1]] as LngLat),
        curve: curve?.success ? curve.data : undefined,
        visible: props.visible !== false,
      });
    }
  }

  // A file written before height moved onto the node says it per road. Lift it: the node
  // takes the height of the highest road that meets there, which is the only reading that
  // does not lower a bridge onto the ground beneath it.
  liftLevelsOntoNodes(features, nodes);

  // Drop roads whose nodes did not survive, rather than leaving the document referring to
  // places that are not there.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const kept = segments.filter((s) => nodeIds.has(s.fromNodeId) && nodeIds.has(s.toNodeId));
  if (kept.length !== segments.length) {
    warnings.push(`${segments.length - kept.length} road(s) referred to missing nodes.`);
  }

  return { nodes, segments: kept, areas };
}

/**
 * Move a per-road height onto the places the road meets.
 *
 * Both the old street model and the first version of this one put height on the road, which
 * lets a document say that one point is at two heights at once. Reading it back onto the
 * nodes is lossy in exactly one case — a road that climbs from ground to a bridge becomes a
 * road whose two ends differ, which is a ramp, which is what it was.
 */
function liftLevelsOntoNodes(features: readonly Feature[], nodes: Node[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const feature of features) {
    const props = feature.properties;
    if (props?.streetcity !== 'segment' || typeof props.level !== 'number' || props.level === 0) {
      continue;
    }
    for (const key of ['fromNodeId', 'toNodeId'] as const) {
      const node = byId.get(String(props[key]));
      if (!node) continue;
      if (Math.abs(props.level) > Math.abs(node.elevation ?? 0)) node.elevation = props.level;
    }
  }
}

// -------------------------------------------------------------------- legacy import

/**
 * Convert a project written by the street-based editor.
 *
 * The old model had no nodes at all: a street was a long polyline, and whether two of them
 * met was decided by a detector every time the file was opened. So the conversion has to
 * invent the thing the file never recorded, and the honest rule is a strict one — two ends
 * are the same place if they are within a metre and a half of each other, which is a
 * tracing slip, and otherwise they are two places.
 *
 * That is deliberately much stricter than the old detector, which scaled its tolerance to
 * the width of the widest street involved and would call ends seventeen metres apart joined.
 * Roads that were only ever joined by that guess come in unjoined, which is the truth about
 * what was drawn, and joining them is one click each.
 *
 * A street's cross-section becomes an asset. Two streets that carried identical sections
 * get one asset between them, which is usually what was meant — and is the thing the old
 * model could not express at all.
 */
/** Where two edges properly cross, as parameters along each, or null. */
function crossingOf(
  a0: LngLat,
  a1: LngLat,
  b0: LngLat,
  b1: LngLat,
  scale: number,
): { t: number; u: number } | null {
  const rx = (a1[0] - a0[0]) * scale;
  const ry = a1[1] - a0[1];
  const sx = (b1[0] - b0[0]) * scale;
  const sy = b1[1] - b0[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-15) return null;
  const qpx = (b0[0] - a0[0]) * scale;
  const qpy = b0[1] - a0[1];
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** One street on its way in: the line, and what it will need to become a road. */
interface Track {
  points: LngLat[];
  assetId: string;
  name?: string;
  level?: number;
  curve?: Segment['curve'];
  /** Where this line has to be cut, as (edge index, fraction along that edge). */
  cuts: { edge: number; t: number; point: LngLat; nodeId: string }[];
}

/**
 * Cut every track where it genuinely crosses another, and share a node at the crossing.
 *
 * This is the one place the conversion is allowed to infer something, and it is inference
 * of a very specific kind: the crossing point is computed, not guessed, and by construction
 * it lies exactly on both lines. Two streets that cross on the map crossed in the drawing,
 * and there was never any other way for the old model to say they met.
 *
 * What it will NOT do is join two ends that are near each other — that stays the strict
 * weld, because "near" was exactly the judgement the old detector got wrong. And crossings
 * between streets at different levels are skipped, which is what keeps a freeway flying over
 * a road rather than landing on it.
 */
function splitAtCrossings(tracks: Track[], nodeAt: (p: LngLat, elevation?: number) => string): void {
  if (tracks.length < 2) return;
  const scale = Math.cos(((tracks[0]!.points[0]?.[1] ?? 0) * Math.PI) / 180);

  for (let i = 0; i < tracks.length; i++) {
    for (let j = i + 1; j < tracks.length; j++) {
      const a = tracks[i]!;
      const b = tracks[j]!;
      if ((a.level ?? 0) !== (b.level ?? 0)) continue;

      for (let ai = 0; ai < a.points.length - 1; ai++) {
        for (let bi = 0; bi < b.points.length - 1; bi++) {
          const hit = crossingOf(
            a.points[ai]!,
            a.points[ai + 1]!,
            b.points[bi]!,
            b.points[bi + 1]!,
            scale,
          );
          if (!hit) continue;

          const p0 = a.points[ai]!;
          const p1 = a.points[ai + 1]!;
          const point: LngLat = [
            p0[0] + hit.t * (p1[0] - p0[0]),
            p0[1] + hit.t * (p1[1] - p0[1]),
          ];
          // One node, shared: this is the same place on both roads, which is the entire
          // reason to do this at import rather than leaving them overlapping.
          const nodeId = nodeAt(point, a.level ?? 0);
          a.cuts.push({ edge: ai, t: hit.t, point, nodeId });
          b.cuts.push({ edge: bi, t: hit.u, point, nodeId });
        }
      }
    }
  }
}

/** A piece shorter than this is a tracing artefact at a crossing, not a road. */
const MIN_PIECE_METRES = 2;

/**
 * Cut one street into the roads it is really made of.
 *
 * The pieces between consecutive crossings become segments, and the crossing points become
 * the nodes they share. A street that crosses nothing comes through as a single road from
 * one end to the other, which is what it was.
 *
 * Cuts landing within a couple of metres of each other, or of an end, collapse into one.
 * Two streets crossing at a shallow angle can produce a pair of crossings a few centimetres
 * apart, and a road between them would be a sliver nobody could select or delete.
 */
function cutTrack(track: Track, nodeAt: (p: LngLat, elevation?: number) => string): Segment[] {
  const ordered = [...track.cuts].sort((a, b) => a.edge - b.edge || a.t - b.t);
  const out: Segment[] = [];

  // Each boundary is a node plus the index of the point that follows it on the line.
  const boundaries: { nodeId: string; point: LngLat; after: number }[] = [
    { nodeId: nodeAt(track.points[0]!, track.level ?? 0), point: track.points[0]!, after: 1 },
  ];

  for (const cut of ordered) {
    const previous = boundaries[boundaries.length - 1]!;
    if (distanceMeters(previous.point, cut.point) < MIN_PIECE_METRES) continue;
    boundaries.push({ nodeId: cut.nodeId, point: cut.point, after: cut.edge + 1 });
  }

  const lastPoint = track.points[track.points.length - 1]!;
  const previous = boundaries[boundaries.length - 1]!;
  if (distanceMeters(previous.point, lastPoint) >= MIN_PIECE_METRES) {
    boundaries.push({
      nodeId: nodeAt(lastPoint, track.level ?? 0),
      point: lastPoint,
      after: track.points.length,
    });
  }

  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = boundaries[i]!;
    const to = boundaries[i + 1]!;
    if (from.nodeId === to.nodeId) continue;

    // The interior points between the two cuts. The ends are the nodes and are not repeated,
    // which is the invariant the whole model rests on.
    const shape = track.points.slice(from.after, to.after - 1).map((p) => [p[0], p[1]] as LngLat);

    out.push({
      id: newSegmentId(),
      name: track.name,
      assetId: track.assetId,
      fromNodeId: from.nodeId,
      toNodeId: to.nodeId,
      shape,
      curve: track.curve,
      visible: true,
    });
  }

  return out;
}

function convertLegacy(
  features: readonly Feature[],
  assets: Asset[],
  warnings: string[],
): Doc {
  const nodes: Node[] = [];
  const segments: Segment[] = [];
  const areas: AreaShape[] = [];
  const tracks: Track[] = [];

  /**
   * Reuse a node when an end lands on one already placed.
   *
   * Height comes in per street and belongs to the place, so a node takes the highest of
   * whatever meets there — the only reading that does not lower a bridge onto the ground
   * running underneath it.
   */
  const nodeAt = (position: LngLat, elevation = 0): string => {
    for (const node of nodes) {
      if (distanceMeters(node.position, position) <= WELD_METRES) {
        if (Math.abs(elevation) > Math.abs(node.elevation ?? 0)) node.elevation = elevation;
        return node.id;
      }
    }
    const id = newNodeId();
    nodes.push(elevation ? { id, position, elevation } : { id, position });
    return id;
  };

  /** One asset per distinct section, keyed on what the section actually is. */
  const assetByShape = new Map<string, string>();
  const assetFor = (props: Record<string, unknown>, label: string): string => {
    const parsed = z.array(componentSchema).min(1).safeParse(props.components);
    if (!parsed.success) return assets.find((a) => a.kind === 'line')?.id ?? '';

    const components = parsed.data.map((c) => ({
      ...c,
      id: newId('c'),
      direction: c.direction ?? PRIMITIVES[c.componentType].defaultDirection,
    })) as SectionComponent[];

    const anchor =
      typeof props.anchorOffsetMeters === 'number' ? props.anchorOffsetMeters : null;
    const key = JSON.stringify([
      anchor,
      components.map((c) => [c.componentType, c.widthMeters, c.direction, c.glyph, c.stripeLeft]),
    ]);

    const existing = assetByShape.get(key);
    if (existing) return existing;

    const id = `imported-${assetByShape.size + 1}`;
    assets.push({
      id,
      name: label || `Imported ${assetByShape.size + 1}`,
      kind: 'line',
      family: 'street',
      components,
      anchorOffsetMeters: anchor,
    });
    assetByShape.set(key, id);
    return id;
  };

  const fallbackArea = assets.find((a) => a.kind === 'area')?.id ?? '';

  for (const feature of features) {
    const kind = feature.properties?.geostripe;

    // Bands are a render product of the old model, exactly as they are of this one.
    if (kind === 'band' || kind === 'node') continue;

    if (feature.geometry?.type === 'LineString') {
      const coordinates = feature.geometry.coordinates as LngLat[];
      if (coordinates.length < 2) {
        warnings.push('A street had fewer than two points and was dropped.');
        continue;
      }
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      const assetId =
        kind === 'street'
          ? assetFor(props, String(props.name ?? ''))
          : assets.find((a) => a.kind === 'line')?.id ?? '';

      const curve = props.curve ? curveSchema.safeParse(props.curve) : null;

      tracks.push({
        points: coordinates.map((p) => [p[0], p[1]] as LngLat),
        assetId,
        name: typeof props.name === 'string' ? props.name : undefined,
        level: typeof props.level === 'number' ? props.level : undefined,
        curve: curve?.success ? curve.data : undefined,
        cuts: [],
      });
      continue;
    }

    if (feature.geometry?.type === 'Polygon' && (kind === 'area' || kind === 'areaShape')) {
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      const stored = Array.isArray(props.ring) ? (props.ring as LngLat[]) : null;
      const ring = stored ?? (feature.geometry.coordinates[0] as LngLat[]).slice(0, -1);
      if (ring.length < 3) continue;

      const material = String(props.landcover ?? 'grass');
      const areaAsset =
        assets.find((a) => a.kind === 'area' && a.material === material)?.id ?? fallbackArea;

      areas.push({
        id: newAreaId(),
        name: typeof props.name === 'string' ? props.name : undefined,
        assetId: areaAsset,
        ring: ring.map((p) => [p[0], p[1]] as LngLat),
        visible: true,
      });
    }
  }

  // Crossings become shared nodes before anything is cut, so both roads agree about where
  // the junction is rather than each landing on its own copy of it.
  splitAtCrossings(tracks, nodeAt);

  for (const track of tracks) {
    for (const piece of cutTrack(track, nodeAt)) segments.push(piece);
  }

  if (segments.length > 0) {
    warnings.push(
      `Converted ${segments.length} street(s) into roads between ${nodes.length} node(s). ` +
        'Ends further than 1.5 m apart were left unjoined — join them where they should meet.',
    );
  }

  return { nodes, segments, areas };
}

/** A palette for a file that brought none: the built-ins, exactly as a new project gets. */
export const defaultPalette = builtInAssets;

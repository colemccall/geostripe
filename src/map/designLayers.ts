import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { Area, JunctionNode, Street } from '../model/types';
import { deriveProject } from '../geo/derived';
import type { DerivedProject, JunctionOverride } from '../geo/derived';
import type { JunctionGeometry } from '../geo/intersection';
import { midpoint } from '../geo/measure';
import { mergeParts } from '../geo/merge';
import { closeRing, resolveCenterline, resolveRing } from '../geo/curve';
import { LANDCOVERS } from '../library/landcover';
import type { CurvatureWarning } from '../geo/curvature';
import { PRIMITIVES } from '../library/primitives';

/**
 * Turning the document into map layers.
 *
 * Bands are derived here on every render and never stored. That is the whole "parametric,
 * still alive" premise: change a width, drag a vertex, and the geometry is rebuilt from
 * the inputs rather than edited in place. The rebuild is memoised in geo/derived.ts, so
 * only what actually changed is recomputed.
 *
 * Junctions produce two fills whose stacking order does real work. The footprint goes
 * down first in footway colour; the paved area goes on top in asphalt. Streets are trimmed
 * so roadway bands stop at the paved edge and everything else stops at the footprint edge,
 * which leaves exactly the corner showing as footway. No boolean is needed to carve the
 * corner sidewalk — the z-order is the boolean.
 */

export interface JunctionSummary {
  key: string;
  position: [number, number];
  legCount: number;
  kind: string;
  /** Set when this junction is a node somebody placed. */
  nodeId?: string;
  /** How it was read: an intersection, a merge, or two streets simply continuing. */
  form: DerivedProject['junctionForms'][number];
  /** Angle at which the joining road comes in, when there is one. Degrees. */
  mergeAngleDegrees: number | null;
  corners: JunctionGeometry['corners'];
  legs: JunctionGeometry['legs'];
  warnings: string[];
}

export interface DesignData {
  /** Land cover, drawn beneath everything else in the design. */
  areas: FeatureCollection;
  bands: FeatureCollection;
  /** Longitudinal stripes — lane lines, centre lines, edge lines. */
  markings: FeatureCollection;
  /**
   * Pavement symbols: repeating lane stamps and junction approach arrows in one source.
   *
   * One collection rather than two because they are the same material drawn the same way,
   * and splitting them would mean two identical layers whose only difference is where the
   * geometry came from.
   */
  stamps: FeatureCollection;
  centerlines: FeatureCollection;
  vertices: FeatureCollection;
  /** Half-way handles on the selected centerline; dragging one inserts a vertex. */
  midpoints: FeatureCollection;
  /** Kerb-to-kerb intersection area, drawn as asphalt. */
  junctionPaved: FeatureCollection;
  /** Full intersection footprint, drawn underneath in footway colour. */
  junctionFootprint: FeatureCollection;
  /** One point per junction, for selection. */
  junctionPoints: FeatureCollection;
  /** Placed intersection nodes, drawn as their own handles. */
  nodes: FeatureCollection;
  /** Crosswalk stripes, edge lines, raised tables and stop bars. */
  crossings: FeatureCollection;
  /** Stop lines across each leg of the selected junction. */
  stopLines: FeatureCollection;
  /** Junctions close enough that their geometry interacts. */
  offsetPairs: DerivedProject['offsetPairs'];
  warnings: { streetId: string; streetName: string; warnings: CurvatureWarning[] }[];
  junctions: JunctionSummary[];
  junctionWarnings: string[];
}

const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export interface BuildOptions {
  /** The street under the cursor during a drag. See DeriveOptions.liveStreetId. */
  liveStreetId?: string | null;
  areas?: readonly Area[];
  selectedAreaId?: string | null;
  overrides?: Readonly<Record<string, JunctionOverride>>;
  defaultCornerRadiusMeters?: number;
  trimAtJunctions?: boolean;
  junctionMergeSlackMeters?: number;
  mergeBelowDegrees?: number;
  nodes?: readonly JunctionNode[];
  junctionMode?: 'auto' | 'nodes';
  selectedNodeId?: string | null;
  selectedJunctionKey?: string | null;
  /**
   * Draw every centerline, not just the selected one.
   *
   * Off by default. A centerline is an editing handle, not part of the design: once the
   * bands are drawn it is the one line on the map that does not exist on the ground, and
   * a dozen of them turn a finished design into a wiring diagram. It comes back the moment
   * a street is selected, which is the moment it means anything.
   */
  showAllCenterlines?: boolean;
}

export function buildDesignData(
  streets: readonly Street[],
  selectedStreetId: string | null,
  options: BuildOptions = {},
): DesignData {
  const areas = empty();
  const bands = empty();
  const markings = empty();
  const stamps = empty();
  const centerlines = empty();
  const vertices = empty();
  const midpoints = empty();
  const junctionPaved = empty();
  const junctionFootprint = empty();
  const junctionPoints = empty();
  const nodes = empty();
  const stopLines = empty();
  const crossings = empty();

  // Land cover first: it is the ground everything else is drawn on, and giving it its own
  // pass keeps the street pipeline unaware that areas exist at all.
  for (const area of options.areas ?? []) {
    if (!area.visible) continue;
    const ring = closeRing(resolveRing(area));
    if (ring.length < 4) continue;

    const spec = LANDCOVERS[area.landcover];
    const selected = area.id === options.selectedAreaId;

    areas.features.push({
      type: 'Feature',
      id: area.id,
      properties: {
        areaId: area.id,
        landcover: area.landcover,
        name: area.name,
        color: spec.color,
        opacity: spec.opacity,
        selected,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });

    if (selected) {
      const sharp = new Set(area.curve?.sharpVertices ?? []);
      const curved = (area.curve?.mode ?? 'straight') !== 'straight';
      area.ring.forEach((position, index) => {
        vertices.features.push({
          type: 'Feature',
          id: `${area.id}:v${index}`,
          properties: {
            kind: 'area',
            streetId: area.id,
            index,
            sharp: curved && sharp.has(index),
          },
          geometry: { type: 'Point', coordinates: position },
        });

        // Wraps: the handle after the last vertex splits the closing segment.
        const next = area.ring[(index + 1) % area.ring.length]!;
        midpoints.features.push({
          type: 'Feature',
          id: `${area.id}:m${index}`,
          properties: { kind: 'area', streetId: area.id, index },
          geometry: { type: 'Point', coordinates: midpoint(position, next) },
        });
      });
    }
  }

  const derived = deriveProject(streets, {
    overrides: options.overrides,
    defaultCornerRadiusMeters: options.defaultCornerRadiusMeters,
    trimAtJunctions: options.trimAtJunctions,
    junctionMergeSlackMeters: options.junctionMergeSlackMeters,
    mergeBelowDegrees: options.mergeBelowDegrees,
    nodes: options.nodes,
    junctionMode: options.junctionMode,
    liveStreetId: options.liveStreetId ?? null,
  });

  for (const street of streets) {
    if (!street.visible) continue;

    const geometry = derived.byStreet.get(street.id);
    if (geometry) {
      bands.features.push(...geometry.bands);
      markings.features.push(...geometry.markings);
      stamps.features.push(...geometry.stamps);
    }

    const selected = street.id === selectedStreetId;
    if (selected || options.showAllCenterlines) {
      centerlines.features.push({
        type: 'Feature',
        id: `${street.id}:center`,
        properties: { streetId: street.id, name: street.name, selected },
        // The resolved line, so the guide follows the curve the bands were built from.
        geometry: { type: 'LineString', coordinates: resolveCenterline(street) },
      });
    }

    // Vertices are drawn only for the selected street — every centerline showing its
    // handles at once turns the map into confetti.
    if (selected) {
      const sharp = new Set(street.curve?.sharpVertices ?? []);
      const curved = (street.curve?.mode ?? 'straight') !== 'straight';
      street.centerline.forEach((position, index) => {
        vertices.features.push({
          type: 'Feature',
          id: `${street.id}:v${index}`,
          // `sharp` only means anything on a curved street; on a polyline every corner
          // is already hard and flagging them would be noise.
          properties: {
            kind: 'street',
            streetId: street.id,
            index,
            sharp: curved && sharp.has(index),
          },
          geometry: { type: 'Point', coordinates: position },
        });

        // `index` names the segment this handle splits, so inserting after it is exact.
        const next = street.centerline[index + 1];
        if (!next) return;
        midpoints.features.push({
          type: 'Feature',
          id: `${street.id}:m${index}`,
          properties: { kind: 'street', streetId: street.id, index },
          geometry: { type: 'Point', coordinates: midpoint(position, next) },
        });
      });
    }
  }

  // Nodes are drawn from the document rather than from the derived junctions: a node
  // parked on one street, or disabled, makes no junction at all and still has to be
  // visible and selectable, or it would be impossible to get rid of.
  for (const node of options.nodes ?? []) {
    nodes.features.push({
      type: 'Feature',
      id: node.id,
      properties: {
        nodeId: node.id,
        name: node.name ?? '',
        disabled: node.disabled === true,
        selected: node.id === options.selectedNodeId,
      },
      geometry: { type: 'Point', coordinates: node.position },
    });
  }

  crossings.features.push(...derived.crossings);
  stamps.features.push(...derived.approachStamps);
  // Turn pockets are bands: they are roadway, they carry a component type, and they should
  // read as part of the street rather than as decoration belonging to the junction.
  bands.features.push(...derived.flares);

  const junctions: JunctionSummary[] = [];

  derived.junctionGeometry.forEach((geometry, index) => {
    const junction = derived.junctions[index]!;
    const selected = geometry.key === options.selectedJunctionKey;

    if (geometry.footprint.length > 3) {
      junctionFootprint.features.push({
        type: 'Feature',
        id: `${geometry.key}:foot`,
        properties: { junctionKey: geometry.key, color: PRIMITIVES.sidewalk.color },
        geometry: { type: 'Polygon', coordinates: [geometry.footprint] },
      });
    }

    if (geometry.paved.length > 3) {
      junctionPaved.features.push({
        type: 'Feature',
        id: `${geometry.key}:paved`,
        properties: {
          junctionKey: geometry.key,
          color: PRIMITIVES.travelLane.color,
          selected,
        },
        geometry: { type: 'Polygon', coordinates: [geometry.paved] },
      });
    }

    junctionPoints.features.push({
      type: 'Feature',
      id: `${geometry.key}:pt`,
      properties: { junctionKey: geometry.key, selected },
      geometry: { type: 'Point', coordinates: geometry.centre },
    });

    if (selected) {
      geometry.legs.forEach((leg, legIndex) => {
        stopLines.features.push({
          type: 'Feature',
          id: `${geometry.key}:stop${legIndex}`,
          properties: { junctionKey: geometry.key, legIndex },
          geometry: { type: 'LineString', coordinates: leg.stopLine },
        });
      });
    }

    junctions.push({
      key: geometry.key,
      position: geometry.centre,
      legCount: geometry.legs.length,
      kind: junction.kind,
      ...(junction.nodeId ? { nodeId: junction.nodeId } : {}),
      form: derived.junctionForms[index] ?? 'intersection',
      mergeAngleDegrees: mergeParts(junction)?.angleDegrees ?? null,
      corners: geometry.corners,
      legs: geometry.legs,
      warnings: geometry.warnings,
    });
  });

  return {
    areas,
    bands,
    markings,
    stamps,
    centerlines,
    vertices,
    midpoints,
    junctionPaved,
    junctionFootprint,
    junctionPoints,
    nodes,
    crossings,
    stopLines,
    warnings: derived.warnings,
    junctions,
    junctionWarnings: derived.junctionWarnings,
    offsetPairs: derived.offsetPairs,
  };
}

/**
 * Clip design polygons to everything east of `minLng` — the before/after swipe.
 *
 * A vertical line on screen is a line of constant longitude only while the map is
 * north-up, which is why rotation is disabled on this map. With that held, clipping in
 * degree space against a meridian is exact and needs no projection.
 *
 * This used to call a polygon-boolean library, on the reasoning that a project is a
 * handful of small polygons and the cost would be lost against a tile fetch. That was
 * wrong twice over. A real project is not a handful of polygons — the downtown baseline
 * carries four hundred pavement symbols alone — and this runs on every frame of every pan,
 * not once per fetch. Measured, it cost **1.1 seconds per pan frame**, which is the whole
 * of "the editor is terribly slow".
 *
 * A half-plane is convex, so Sutherland-Hodgman clips against it exactly in one linear
 * pass per ring: walk the edges, keep what is inside, and emit the crossing point wherever
 * an edge changes side. No intersection search, no arbitrary-precision arithmetic, no
 * allocation beyond the output ring. The same 1.1 seconds is now about a millisecond.
 */

/** Sutherland-Hodgman against the single edge x = minLng, keeping x >= minLng. */
function clipRingEastOf(ring: readonly (readonly number[])[], minLng: number): [number, number][] {
  const out: [number, number][] = [];
  if (ring.length === 0) return out;

  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i]!;
    const prev = ring[(i + ring.length - 1) % ring.length]!;
    const curIn = cur[0]! >= minLng;
    const prevIn = prev[0]! >= minLng;

    if (curIn !== prevIn) {
      // The edge crosses the meridian: emit where it does, before whichever end is kept.
      const t = (minLng - prev[0]!) / (cur[0]! - prev[0]!);
      out.push([minLng, prev[1]! + t * (cur[1]! - prev[1]!)]);
    }
    if (curIn) out.push([cur[0]!, cur[1]!]);
  }

  // A ring needs three distinct corners plus the repeat to be an area at all.
  if (out.length < 3) return [];

  // And it needs area. A cut landing exactly on an edge leaves a ring of collinear points
  // — zero area, invisible, but still tessellated by the renderer. With the divider parked
  // on a shared band boundary that is one degenerate polygon per band, every frame.
  let twiceArea = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    const b = out[(i + 1) % out.length]!;
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(twiceArea) < 1e-18) return [];

  const first = out[0]!;
  const last = out[out.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

export function clipEastOf(collection: FeatureCollection, minLng: number): FeatureCollection {
  const features: Feature[] = [];

  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') continue;

    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates as [number, number][][]]
        : (geometry.coordinates as [number, number][][][]);

    const kept: [number, number][][][] = [];
    for (const polygon of polygons) {
      const rings: [number, number][][] = [];
      for (const ring of polygon) {
        const clipped = clipRingEastOf(ring, minLng);
        // An outer ring clipped away takes its holes with it; a hole clipped away just
        // means the hole was entirely on the hidden side.
        if (clipped.length === 0) {
          if (rings.length === 0) break;
          continue;
        }
        rings.push(clipped);
      }
      if (rings.length > 0) kept.push(rings);
    }

    if (kept.length === 0) continue;

    features.push({
      ...feature,
      geometry:
        kept.length === 1
          ? ({ type: 'Polygon', coordinates: kept[0]! } as Polygon)
          : ({ type: 'MultiPolygon', coordinates: kept } as MultiPolygon),
    });
  }

  return { type: 'FeatureCollection', features };
}

export function clipLinesEastOf(collection: FeatureCollection, minLng: number): FeatureCollection {
  const features: Feature[] = [];

  for (const feature of collection.features) {
    if (feature.geometry.type !== 'LineString') continue;
    const coords = feature.geometry.coordinates as [number, number][];

    const kept: [number, number][] = [];
    for (let i = 0; i < coords.length; i++) {
      const cur = coords[i]!;
      const prev = coords[i - 1];

      if (prev) {
        const crossing =
          (prev[0] < minLng && cur[0] >= minLng) || (prev[0] >= minLng && cur[0] < minLng);
        if (crossing) {
          const t = (minLng - prev[0]) / (cur[0] - prev[0]);
          kept.push([minLng, prev[1] + t * (cur[1] - prev[1])]);
        }
      }
      if (cur[0] >= minLng) kept.push(cur);
    }

    if (kept.length >= 2) {
      features.push({ ...feature, geometry: { type: 'LineString', coordinates: kept } });
    }
  }

  return { type: 'FeatureCollection', features };
}

import * as polyclip from 'polyclip-ts';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { Street } from '../model/types';
import { deriveProject } from '../geo/derived';
import type { JunctionOverride } from '../geo/derived';
import type { JunctionGeometry } from '../geo/intersection';
import { midpoint } from '../geo/measure';
import { resolveCenterline } from '../geo/curve';
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
  corners: JunctionGeometry['corners'];
  legs: JunctionGeometry['legs'];
  warnings: string[];
}

export interface DesignData {
  bands: FeatureCollection;
  markings: FeatureCollection;
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
  /** Crosswalk stripes, edge lines, raised tables and stop bars. */
  crossings: FeatureCollection;
  /** Stop lines across each leg of the selected junction. */
  stopLines: FeatureCollection;
  warnings: { streetId: string; streetName: string; warnings: CurvatureWarning[] }[];
  junctions: JunctionSummary[];
  junctionWarnings: string[];
}

const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export interface BuildOptions {
  overrides?: Readonly<Record<string, JunctionOverride>>;
  defaultCornerRadiusMeters?: number;
  trimAtJunctions?: boolean;
  selectedJunctionKey?: string | null;
}

export function buildDesignData(
  streets: readonly Street[],
  selectedStreetId: string | null,
  options: BuildOptions = {},
): DesignData {
  const bands = empty();
  const markings = empty();
  const centerlines = empty();
  const vertices = empty();
  const midpoints = empty();
  const junctionPaved = empty();
  const junctionFootprint = empty();
  const junctionPoints = empty();
  const stopLines = empty();
  const crossings = empty();

  const derived = deriveProject(streets, {
    overrides: options.overrides,
    defaultCornerRadiusMeters: options.defaultCornerRadiusMeters,
    trimAtJunctions: options.trimAtJunctions,
  });

  for (const street of streets) {
    if (!street.visible) continue;

    const geometry = derived.byStreet.get(street.id);
    if (geometry) {
      bands.features.push(...geometry.bands);
      markings.features.push(...geometry.markings);
    }

    const selected = street.id === selectedStreetId;
    centerlines.features.push({
      type: 'Feature',
      id: `${street.id}:center`,
      properties: { streetId: street.id, name: street.name, selected },
      // The resolved line, so the guide follows the curve the bands were built from.
      geometry: { type: 'LineString', coordinates: resolveCenterline(street) },
    });

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
          properties: { streetId: street.id, index, sharp: curved && sharp.has(index) },
          geometry: { type: 'Point', coordinates: position },
        });

        // `index` names the segment this handle splits, so inserting after it is exact.
        const next = street.centerline[index + 1];
        if (!next) return;
        midpoints.features.push({
          type: 'Feature',
          id: `${street.id}:m${index}`,
          properties: { streetId: street.id, index },
          geometry: { type: 'Point', coordinates: midpoint(position, next) },
        });
      });
    }
  }

  crossings.features.push(...derived.crossings);

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
      corners: geometry.corners,
      legs: geometry.legs,
      warnings: geometry.warnings,
    });
  });

  return {
    bands,
    markings,
    centerlines,
    vertices,
    midpoints,
    junctionPaved,
    junctionFootprint,
    junctionPoints,
    crossings,
    stopLines,
    warnings: derived.warnings,
    junctions,
    junctionWarnings: derived.junctionWarnings,
  };
}

/**
 * Clip design polygons to everything east of `minLng` — the before/after swipe.
 *
 * A vertical line on screen is a line of constant longitude only while the map is
 * north-up, which is why rotation is disabled on this map. With that held, clipping in
 * degree space against a meridian is exact and needs no projection.
 *
 * Runs on every map move, but a project is a handful of small polygons, so the boolean
 * cost is negligible compared with a tile fetch.
 */
export function clipEastOf(collection: FeatureCollection, minLng: number): FeatureCollection {
  const halfPlane: [number, number][][] = [
    [
      [minLng, -89.9],
      [180, -89.9],
      [180, 89.9],
      [minLng, 89.9],
      [minLng, -89.9],
    ],
  ];

  const features: Feature[] = [];

  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') continue;

    try {
      const input =
        geometry.type === 'Polygon'
          ? (geometry.coordinates as [number, number][][])
          : (geometry.coordinates as [number, number][][][]);

      const clipped = polyclip.intersection(input, halfPlane);
      if (clipped.length === 0) continue;

      features.push({
        ...feature,
        geometry:
          clipped.length === 1
            ? ({ type: 'Polygon', coordinates: clipped[0]! } as Polygon)
            : ({ type: 'MultiPolygon', coordinates: clipped } as MultiPolygon),
      });
    } catch {
      // A degenerate polygon should not take the whole layer down; show it unclipped.
      features.push(feature);
    }
  }

  return { type: 'FeatureCollection', features };
}

/** Clip line features to everything east of `minLng`, by splitting at the meridian. */
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

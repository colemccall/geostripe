import * as polyclip from 'polyclip-ts';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { Street } from '../model/types';
import { bandsForStreet, markingsForStreet } from '../geo/banding';
import type { CurvatureWarning } from '../geo/curvature';

/**
 * Turning the document into map layers.
 *
 * Bands are derived here on every render and never stored. That is the whole "parametric,
 * still alive" premise: change a width, drag a vertex, and the geometry is rebuilt from
 * the inputs rather than edited in place.
 */

export interface DesignData {
  bands: FeatureCollection;
  markings: FeatureCollection;
  centerlines: FeatureCollection;
  vertices: FeatureCollection;
  warnings: { streetId: string; streetName: string; warnings: CurvatureWarning[] }[];
}

const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export function buildDesignData(streets: readonly Street[], selectedStreetId: string | null): DesignData {
  const bands = empty();
  const markings = empty();
  const centerlines = empty();
  const vertices = empty();
  const warnings: DesignData['warnings'] = [];

  for (const street of streets) {
    if (!street.visible) continue;

    const result = bandsForStreet(street.id, street.centerline, street.section);
    bands.features.push(...result.bands);
    if (result.warnings.length > 0) {
      warnings.push({ streetId: street.id, streetName: street.name, warnings: result.warnings });
    }

    markings.features.push(...markingsForStreet(street.id, street.centerline, street.section));

    const selected = street.id === selectedStreetId;
    centerlines.features.push({
      type: 'Feature',
      id: `${street.id}:center`,
      properties: { streetId: street.id, name: street.name, selected },
      geometry: { type: 'LineString', coordinates: street.centerline },
    });

    // Vertices are drawn only for the selected street — every centerline showing its
    // handles at once turns the map into confetti.
    if (selected) {
      street.centerline.forEach((position, index) => {
        vertices.features.push({
          type: 'Feature',
          id: `${street.id}:v${index}`,
          properties: { streetId: street.id, index },
          geometry: { type: 'Point', coordinates: position },
        });
      });
    }
  }

  return { bands, markings, centerlines, vertices, warnings };
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

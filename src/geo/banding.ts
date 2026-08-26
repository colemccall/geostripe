import * as polyclip from 'polyclip-ts';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { PRIMITIVES } from '../library/primitives';
import type { ComponentType, Direction } from '../library/primitives';
import type { CrossSection } from '../model/types';
import { boundaryOffsets } from '../model/section';
import { dedupe, localPlane, originFor } from './projection';
import type { LngLat, PlanePoint } from './projection';
import { offsetPolyline } from './offset';
import { findOverruns } from './curvature';
import type { CurvatureWarning } from './curvature';

/**
 * Offset banding — the heart of the tool.
 *
 * A cross-section is a stack of widths. `boundaryOffsets` turns that into signed
 * distances from the drawn centerline. This module offsets the centerline by each of
 * those distances and stitches consecutive offset lines into closed bands.
 *
 * The key property is that band i and band i+1 are built from the *same* offset line, so
 * they share their boundary exactly. That is what keeps neighbouring lanes free of slivers
 * and overlaps — a guarantee you lose if you buffer each band independently.
 *
 * Sign convention: `boundaryOffsets` increases left-to-right across the section, while
 * `offsetPolyline` treats positive as the left-hand side of the direction of travel. So
 * planar offset = -(section offset), and component 0 lands on the left of the drawn line.
 */

export interface BandProperties {
  featureClass: 'band';
  streetId: string;
  componentId: string;
  componentIndex: number;
  componentType: ComponentType;
  direction: Direction;
  widthMeters: number;
  color: string;
}

export type BandFeature = Feature<Polygon | MultiPolygon, BandProperties>;

export interface BandingResult {
  bands: BandFeature[];
  warnings: CurvatureWarning[];
}

export function bandColor(componentType: ComponentType, override?: string): string {
  return override ?? PRIMITIVES[componentType].color;
}

/** Close a ring if it is not already closed — polyclip and GeoJSON both expect it. */
function closeRing(ring: [number, number][]): [number, number][] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

/**
 * Stitch two offset lines into a closed ring: the inner edge forward, the outer edge
 * reversed. Cleanup happens afterwards, in planar metres.
 */
function ringBetween(inner: PlanePoint[], outer: PlanePoint[]): [number, number][] {
  const ring: [number, number][] = [];
  for (const p of inner) ring.push([p.x, p.y]);
  for (let i = outer.length - 1; i >= 0; i--) ring.push([outer[i]!.x, outer[i]!.y]);
  return closeRing(ring);
}

/**
 * Dissolve any self-intersection into the area the band actually sweeps.
 *
 * On the inside of a tight bend the stitched ring folds back through itself. A boolean
 * self-union resolves that into a simple polygon. This is a repair, not a fix — the
 * curvature warnings exist precisely because the repaired shape is plausible enough to
 * hide the underlying problem.
 */
function cleanRing(ring: [number, number][]): [number, number][][][] {
  try {
    const result = polyclip.union([ring]);
    return result.length > 0 ? result : [[ring]];
  } catch {
    // Degenerate input (zero-width band, coincident points). Fall back to the raw ring
    // rather than dropping the component silently.
    return [[ring]];
  }
}

export interface BandingOptions {
  /** Skip the boolean cleanup pass. Only used to test the raw stitched geometry. */
  skipCleanup?: boolean;
}

/**
 * Generate one polygon per component for a street.
 *
 * Returns an empty result rather than throwing for a degenerate centerline — a user
 * mid-draw has a one-point line, and that is not an error.
 */
export function bandsForStreet(
  streetId: string,
  centerline: readonly LngLat[],
  section: CrossSection,
  options: BandingOptions = {},
): BandingResult {
  const line = dedupe(centerline);
  if (line.length < 2 || section.components.length === 0) {
    return { bands: [], warnings: [] };
  }

  const plane = localPlane(originFor(line));
  const planePts = line.map((p) => plane.toPlane(p));
  const offsets = boundaryOffsets(section);

  const maxOffset = Math.max(...offsets.map(Math.abs));
  const warnings = findOverruns(planePts, maxOffset);

  // One offset line per boundary; adjacent bands reuse these, which is what makes their
  // shared edges identical rather than merely close.
  const offsetLines = offsets.map((s) => offsetPolyline(planePts, -s));

  const bands: BandFeature[] = [];

  section.components.forEach((component, index) => {
    const inner = offsetLines[index];
    const outer = offsetLines[index + 1];
    if (!inner || !outer || component.widthMeters <= 0) return;

    const ring = ringBetween(inner, outer);
    const polys = options.skipCleanup ? [[ring]] : cleanRing(ring);

    // Back to WGS84 only at the very end.
    const toLngLat = (r: [number, number][]) =>
      r.map((p) => plane.toLngLat({ x: p[0], y: p[1] }) as [number, number]);

    const coords = polys.map((poly) => poly.map(toLngLat));

    const properties: BandProperties = {
      featureClass: 'band',
      streetId,
      componentId: component.id,
      componentIndex: index,
      componentType: component.componentType,
      direction: component.direction,
      widthMeters: component.widthMeters,
      color: bandColor(component.componentType, component.colorOverride),
    };

    bands.push({
      type: 'Feature',
      id: `${streetId}:${index}`,
      properties,
      geometry:
        coords.length === 1
          ? { type: 'Polygon', coordinates: coords[0]! }
          : { type: 'MultiPolygon', coordinates: coords },
    });
  });

  return { bands, warnings };
}

import type { Feature, Polygon } from 'geojson';
import { offsetPolyline } from './offset';
import { dedupe, localPlane, originFor } from './projection';
import type { LngLat, PlanePoint } from './projection';
import { boundaryOffsets } from '../model/section';
import { PRIMITIVES } from '../library/primitives';
import type { CrossSection } from '../model/types';

/**
 * Band polygons, for export only.
 *
 * This is the only place in the editor that turns a road into polygons, and it runs once,
 * when a file is saved. The map does not use it: there, a road is its centerline drawn once
 * per band with a width and an offset, and MapLibre does the offsetting on the GPU.
 *
 * Keeping a polygon generator at all is deliberate. The file has to be useful to something
 * that is not this program — QGIS, a report, anything that reads GeoJSON — and "a line with
 * a width in its properties" is not a street to any of them. So the geometry is built at the
 * boundary, written, and thrown away.
 *
 * What is NOT here is the boolean cleanup the old pipeline needed. That existed to subtract
 * junctions out of long ribbons; a band now spans one segment between two nodes, is never
 * cut, and self-intersects only where the centerline itself doubles back on a radius tighter
 * than the road is wide. Dropping it removes the last use of polyclip.
 */

export interface BandOptions {
  /** Metadata to stamp on every band, so a reader can tell which road it came from. */
  properties?: Record<string, unknown>;
}

/**
 * One polygon per component, along one segment.
 *
 * Takes a plain cross-section rather than an asset: a band only needs the stack and the
 * anchor, and a LineAsset satisfies that shape, so the asset editor can preview a section
 * that is not placed on anything.
 *
 * Adjacent bands are built from the same offset line, so they share their boundary
 * coordinates exactly rather than merely closely — which is what stops a hairline sliver
 * appearing between two lanes when the file is drawn somewhere else.
 */
export function bandsForSegment(
  centerline: readonly LngLat[],
  asset: CrossSection,
  options: BandOptions = {},
): Feature<Polygon>[] {
  const line = dedupe(centerline);
  if (line.length < 2 || asset.components.length === 0) return [];

  const plane = localPlane(originFor(line));
  const planePts = line.map((p) => plane.toPlane(p));
  const offsets = boundaryOffsets(asset);

  // Negated because offsetPolyline takes positive to the left, while a boundary offset is
  // positive to the right — the same convention MapLibre's line-offset uses.
  const edges = offsets.map((distance) => offsetPolyline(planePts, -distance));

  const out: Feature<Polygon>[] = [];

  asset.components.forEach((component, index) => {
    const inner = edges[index];
    const outer = edges[index + 1];
    if (!inner || !outer || component.widthMeters <= 0) return;

    const ring: PlanePoint[] = [...inner, ...[...outer].reverse()];
    if (ring.length < 3) return;

    const coordinates = ring.map((p) => plane.toLngLat(p));
    coordinates.push(coordinates[0]!);

    const primitive = PRIMITIVES[component.componentType];
    out.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [coordinates] },
      properties: {
        ...options.properties,
        // Position within the section, so a reader can tell the near kerb from the far one
        // without comparing coordinates.
        componentIndex: index,
        componentType: component.componentType,
        label: primitive.label,
        widthMeters: component.widthMeters,
        direction: component.direction,
        color: component.colorOverride ?? primitive.color,
      },
    });
  });

  return out;
}

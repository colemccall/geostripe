import { localPlane, originFor } from './projection';
import type { LngLat } from './projection';

/**
 * Ground distance, in metres.
 *
 * Uses the same local tangent plane as the banding engine rather than a haversine, so a
 * measured width and a designed width are computed in the same frame and cannot disagree
 * with each other. Over the few hundred metres a street occupies the two differ by well
 * under a centimetre; over a continent they would not, but nothing here measures one.
 */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const plane = localPlane(originFor([a, b]));
  const p = plane.toPlane(a);
  const q = plane.toPlane(b);
  return Math.hypot(q.x - p.x, q.y - p.y);
}

/** Total length of a polyline on the ground, in metres. */
export function lineLengthMeters(line: readonly LngLat[]): number {
  if (line.length < 2) return 0;
  const plane = localPlane(originFor(line));
  const pts = line.map((p) => plane.toPlane(p));
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  return total;
}

/**
 * Midpoint of a segment, in the local plane rather than by averaging degrees.
 *
 * Averaging lng/lat directly is wrong by a hair at these scales and wrong by a lot near
 * the poles; going through the plane costs nothing and is right everywhere.
 */
export function midpoint(a: LngLat, b: LngLat): LngLat {
  const plane = localPlane(originFor([a, b]));
  const p = plane.toPlane(a);
  const q = plane.toPlane(b);
  return plane.toLngLat({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
}

/** Compass bearing of a segment in degrees, 0 = north, clockwise. For display only. */
export function bearingDegrees(a: LngLat, b: LngLat): number {
  const plane = localPlane(originFor([a, b]));
  const p = plane.toPlane(a);
  const q = plane.toPlane(b);
  const deg = (Math.atan2(q.x - p.x, q.y - p.y) * 180) / Math.PI;
  return (deg + 360) % 360;
}

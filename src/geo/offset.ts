import type { PlanePoint } from './projection';

/**
 * Planar polyline offsetting.
 *
 * Offsets every segment by a signed distance (positive = left of travel direction) and
 * resolves the joins. Miter joins keep adjacent bands sharing an exact vertex, which is
 * what guarantees no slivers between neighbouring lanes; but an unlimited miter shoots off
 * to infinity as a corner approaches 180 degrees, so past a limit it falls back to a bevel.
 *
 * This is deliberately not `@turf/lineOffset` — see the note in projection.ts. Input is
 * always metres in a local plane.
 */

const EPS = 1e-9;

export interface OffsetOptions {
  /**
   * Maximum miter length as a multiple of the offset distance. Beyond this the join is
   * bevelled. 4 matches the SVG/CSS default and only kicks in on corners sharper than
   * about 29 degrees — far tighter than any real street centerline.
   */
  miterLimit?: number;
}

interface Segment {
  a: PlanePoint;
  b: PlanePoint;
}

/** Intersection of two infinite lines through the given segments, or null if parallel. */
function intersect(s1: Segment, s2: Segment): PlanePoint | null {
  const d1x = s1.b.x - s1.a.x;
  const d1y = s1.b.y - s1.a.y;
  const d2x = s2.b.x - s2.a.x;
  const d2y = s2.b.y - s2.a.y;

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < EPS) return null;

  const t = ((s2.a.x - s1.a.x) * d2y - (s2.a.y - s1.a.y) * d2x) / denom;
  return { x: s1.a.x + t * d1x, y: s1.a.y + t * d1y };
}

/**
 * Offset a polyline by `distance` metres. Positive is to the left of the direction of
 * travel, negative to the right, matching the sign convention of boundary offsets.
 *
 * Returns a polyline with at least as many points as the input; bevelled joins add one.
 */
export function offsetPolyline(
  pts: readonly PlanePoint[],
  distance: number,
  { miterLimit = 4 }: OffsetOptions = {},
): PlanePoint[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  if (Math.abs(distance) < EPS) return pts.map((p) => ({ ...p }));

  // Offset each segment independently along its own normal.
  const segments: Segment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < EPS) continue;

    // Left normal of (dx, dy) is (-dy, dx).
    const nx = (-dy / len) * distance;
    const ny = (dx / len) * distance;
    segments.push({ a: { x: a.x + nx, y: a.y + ny }, b: { x: b.x + nx, y: b.y + ny } });
  }

  if (segments.length === 0) return pts.map((p) => ({ ...p }));

  const out: PlanePoint[] = [segments[0]!.a];

  for (let i = 0; i < segments.length - 1; i++) {
    const cur = segments[i]!;
    const next = segments[i + 1]!;
    const hit = intersect(cur, next);

    if (!hit) {
      // Collinear: the two offset segments already meet.
      out.push(cur.b);
      continue;
    }

    // Reject a miter that has run away on a very sharp corner.
    const miterLength = Math.hypot(hit.x - cur.b.x, hit.y - cur.b.y);
    if (miterLength > Math.abs(distance) * miterLimit) {
      out.push(cur.b, next.a); // bevel
    } else {
      out.push(hit);
    }
  }

  out.push(segments[segments.length - 1]!.b);
  return out;
}

/** Planar length of a polyline, in the plane's units. */
export function polylineLength(pts: readonly PlanePoint[]): number {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    total += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
  }
  return total;
}

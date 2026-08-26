import { localPlane, originFor } from './projection';
import type { LngLat, PlanePoint } from './projection';
import { resolveCenterline, resolveRing } from './curve';
import type { Area, Street } from '../model/types';

/**
 * Snapping, while drawing.
 *
 * Junctions in GeoStripe are derived from where centerlines actually meet, which makes
 * this more than a convenience. A centerline that stops forty centimetres short of the one
 * it was meant to join still forms a junction — the detector's tolerance is the width of
 * the street — but the junction sits at the projection of a loose endpoint rather than at
 * the point somebody meant, and every corner radius, crossing and taper is built from
 * there. Snapping puts the vertex where the user was aiming, so the geometry downstream is
 * describing the design rather than the aim.
 *
 * Three kinds, in strict order of confidence:
 *
 *   vertex  an existing control point. The strongest signal there is: somebody already
 *           decided this point matters, so landing exactly on it is almost always right.
 *   edge    anywhere along an existing centerline. What makes a T-junction land square.
 *   angle   a bearing from the previous point, in fixed increments. Deliberately opt-in:
 *           tracing a real street from imagery wants the cursor free, and a magnet that
 *           quantises every bend would fight the whole point of tracing.
 */

export type SnapKind = 'vertex' | 'edge' | 'angle' | 'none';

export interface SnapResult {
  point: LngLat;
  kind: SnapKind;
  /** The street or area snapped to, when there is one. */
  targetId?: string;
  /** Short description, for the toolbar readout. */
  label: string;
}

export interface SnapOptions {
  cursor: LngLat;
  streets: readonly Street[];
  areas?: readonly Area[];
  /** The previous committed point. Angle snapping needs something to measure from. */
  from?: LngLat | null;
  /** How close counts, in metres on the ground. Callers derive it from a pixel radius. */
  toleranceMeters: number;
  /** Increment for angle snapping, degrees. Zero or absent turns it off. */
  angleStepDegrees?: number;
  /** How near an increment the bearing has to be, degrees. */
  angleWindowDegrees?: number;
  /** Ids to ignore — the street being edited should not snap to itself. */
  exclude?: ReadonlySet<string>;
}

const DEFAULT_ANGLE_WINDOW = 5;

function distanceSq(a: PlanePoint, b: PlanePoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Closest point on a segment, as a plane point and the squared distance to it. */
function nearestOnSegment(p: PlanePoint, a: PlanePoint, b: PlanePoint): { point: PlanePoint; d2: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { point, d2: distanceSq(p, point) };
}

/**
 * Where a point being drawn should actually land.
 *
 * Returns the cursor unchanged, with kind 'none', when nothing is near enough — a snap
 * that silently moved the point when the user was nowhere near a target would be worse
 * than no snapping at all.
 */
export function snapPoint(options: SnapOptions): SnapResult {
  const {
    cursor,
    streets,
    areas = [],
    from = null,
    toleranceMeters,
    angleStepDegrees = 0,
    angleWindowDegrees = DEFAULT_ANGLE_WINDOW,
    exclude,
  } = options;

  const plane = localPlane(originFor([cursor]));
  const here = plane.toPlane(cursor);
  const tolSq = toleranceMeters * toleranceMeters;

  let bestVertex: { d2: number; point: PlanePoint; id: string } | null = null;
  let bestEdge: { d2: number; point: PlanePoint; id: string } | null = null;

  /**
   * The two inputs are deliberately different lines.
   *
   * Control points are what a person placed and dragged, so they are what "snap to a
   * vertex" should mean. The resolved line is where the geometry actually goes, so it is
   * what "snap to the centerline" should mean. On a straight street they are the same
   * list; on a curved one, treating every tessellated point as a vertex would make the
   * whole curve one long row of control points and the edge case would never fire.
   */
  const consider = (
    id: string,
    controls: readonly LngLat[],
    line: readonly LngLat[],
    closed: boolean,
  ) => {
    if (exclude?.has(id) || line.length === 0) return;

    for (const control of controls) {
      const point = plane.toPlane(control);
      const d2 = distanceSq(here, point);
      if (d2 <= tolSq && (!bestVertex || d2 < bestVertex.d2)) bestVertex = { d2, point, id };
    }

    const pts = line.map((p) => plane.toPlane(p));
    const last = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < last; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const near = nearestOnSegment(here, a, b);
      if (near.d2 <= tolSq && (!bestEdge || near.d2 < bestEdge.d2)) {
        bestEdge = { d2: near.d2, point: near.point, id };
      }
    }
  };

  for (const street of streets) {
    if (!street.visible) continue;
    consider(street.id, street.centerline, resolveCenterline(street), false);
  }
  for (const area of areas) {
    if (!area.visible) continue;
    consider(area.id, area.ring, resolveRing(area), true);
  }

  // A vertex beats an edge even when the edge is marginally nearer: an existing control
  // point is a decision somebody made, and a point on a segment is not.
  const vertex = bestVertex as { d2: number; point: PlanePoint; id: string } | null;
  const edge = bestEdge as { d2: number; point: PlanePoint; id: string } | null;

  if (vertex) {
    return {
      point: plane.toLngLat(vertex.point),
      kind: 'vertex',
      targetId: vertex.id,
      label: 'vertex',
    };
  }
  if (edge) {
    return { point: plane.toLngLat(edge.point), kind: 'edge', targetId: edge.id, label: 'centerline' };
  }

  if (from && angleStepDegrees > 0) {
    const origin = plane.toPlane(from);
    const dx = here.x - origin.x;
    const dy = here.y - origin.y;
    const length = Math.hypot(dx, dy);
    if (length > 0.5) {
      const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
      const stepped = Math.round(bearing / angleStepDegrees) * angleStepDegrees;
      let delta = Math.abs(bearing - stepped);
      if (delta > 180) delta = 360 - delta;
      if (delta <= angleWindowDegrees) {
        const radians = (stepped * Math.PI) / 180;
        return {
          point: plane.toLngLat({
            x: origin.x + Math.cos(radians) * length,
            y: origin.y + Math.sin(radians) * length,
          }),
          kind: 'angle',
          label: `${((stepped % 360) + 360) % 360}°`,
        };
      }
    }
  }

  return { point: cursor, kind: 'none', label: '' };
}

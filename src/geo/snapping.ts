import { resolveCenterline } from './curve';
import { dedupe, localPlane } from './projection';
import type { LngLat } from './projection';
import { endsAt, nodeMap, segmentControlPoints } from '../model/doc';
import type { Doc } from '../model/doc';

/**
 * Where the road you are drawing wants to go.
 *
 * A network drawn without this looks hand-drawn, and not in a good way: every road leaves
 * its junction a degree or two off straight, every corner is 88 or 93 rather than 90, and
 * the result reads as sketched rather than built. The games solve it by pulling the road
 * you are laying onto the directions that the junction already implies — carry straight on,
 * or turn square — and letting you fight free of it by moving further off.
 *
 * The guides are derived from what is actually there rather than from a global grid, which
 * matters on a real street network: a downtown grid is rarely aligned to north, so a fixed
 * 15-degree snap helps with nothing. Snapping to the road you are standing on always does.
 */

/** How close to a guide the cursor must be, in degrees, before it is pulled onto it. */
export const GUIDE_TOLERANCE_DEGREES = 6;

/** A road shorter than this at a node says nothing reliable about which way it points. */
const MIN_SAMPLE_METRES = 4;

export interface DirectionGuide {
  /** Bearing in the local plane: radians, 0 = east, counter-clockwise. */
  angle: number;
  /** What this direction means, which is what the guide line on screen is saying. */
  kind: 'continue' | 'square';
}

/**
 * The directions a junction implies.
 *
 * For each road already at the node: carrying straight on through it, and the two square
 * turns off it. Nothing else — a guide for every angle is no guide at all, and the two
 * relationships worth having are the two you can see are wrong when they are slightly off.
 */
export function directionGuidesAt(doc: Doc, nodeId: string): DirectionGuide[] {
  const nodes = nodeMap(doc);
  const node = nodes.get(nodeId);
  if (!node) return [];

  const plane = localPlane(node.position);
  const origin = plane.toPlane(node.position);
  const out: DirectionGuide[] = [];

  for (const { segment, end } of endsAt(nodeId, doc.segments)) {
    const controls = segmentControlPoints(segment, nodes);
    if (!controls) continue;
    const line = dedupe(
      resolveCenterline({ id: segment.id, centerline: controls, curve: segment.curve }),
    );
    if (line.length < 2) continue;

    // Looking outward from this node, so the direction is the way the road LEAVES.
    const outward = end === 'from' ? line : [...line].reverse();

    // Sampled a little way along rather than from the first vertex: a tessellated curve's
    // first edge can be under a metre, and its direction is noise.
    let dx = 0;
    let dy = 0;
    for (let i = 1; i < outward.length; i++) {
      const p = plane.toPlane(outward[i]!);
      dx = p.x - origin.x;
      dy = p.y - origin.y;
      if (Math.hypot(dx, dy) >= MIN_SAMPLE_METRES) break;
    }
    if (Math.hypot(dx, dy) < 1e-6) continue;

    const away = Math.atan2(dy, dx);
    // Carrying straight on means leaving opposite to the way this road goes.
    out.push({ angle: away + Math.PI, kind: 'continue' });
    out.push({ angle: away + Math.PI / 2, kind: 'square' });
    out.push({ angle: away - Math.PI / 2, kind: 'square' });
  }

  return out;
}

/** Smallest signed difference between two angles, in radians. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export interface SnapResult {
  point: LngLat;
  guide: DirectionGuide;
}

/**
 * Pull the cursor onto the nearest guide, keeping how far out it is.
 *
 * Distance is preserved deliberately: the guide is about direction, and a snap that also
 * moved the road's length would be deciding something the user did not ask about.
 *
 * `continue` wins ties over `square`, because carrying a road straight through a junction is
 * both the more common intent and the more obviously wrong when it is a degree off.
 */
export function snapToGuides(
  origin: LngLat,
  cursor: LngLat,
  guides: readonly DirectionGuide[],
  toleranceDegrees = GUIDE_TOLERANCE_DEGREES,
): SnapResult | null {
  if (guides.length === 0) return null;

  const plane = localPlane(origin);
  const o = plane.toPlane(origin);
  const c = plane.toPlane(cursor);
  const dx = c.x - o.x;
  const dy = c.y - o.y;
  const length = Math.hypot(dx, dy);
  if (length < MIN_SAMPLE_METRES) return null;

  const bearing = Math.atan2(dy, dx);
  const tolerance = (toleranceDegrees * Math.PI) / 180;

  let best: { guide: DirectionGuide; delta: number } | null = null;
  for (const guide of guides) {
    const delta = Math.abs(angleDelta(bearing, guide.angle));
    if (delta > tolerance) continue;
    if (
      !best ||
      delta < best.delta - 1e-9 ||
      (Math.abs(delta - best.delta) <= 1e-9 && guide.kind === 'continue')
    ) {
      best = { guide, delta };
    }
  }

  if (!best) return null;

  return {
    point: plane.toLngLat({
      x: o.x + Math.cos(best.guide.angle) * length,
      y: o.y + Math.sin(best.guide.angle) * length,
    }),
    guide: best.guide,
  };
}

/**
 * A line showing the guide the road has been pulled onto, drawn past the cursor.
 *
 * Past it on purpose: a guide that stops where the road stops is indistinguishable from the
 * road, and the point of drawing it is to say "this is a relationship, not just a line".
 */
export function guideLine(origin: LngLat, through: LngLat, overshootMetres = 60): LngLat[] {
  const plane = localPlane(origin);
  const o = plane.toPlane(origin);
  const t = plane.toPlane(through);
  const dx = t.x - o.x;
  const dy = t.y - o.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return [];

  const scale = (length + overshootMetres) / length;
  return [
    plane.toLngLat({ x: o.x - dx * (overshootMetres / length), y: o.y - dy * (overshootMetres / length) }),
    plane.toLngLat({ x: o.x + dx * scale, y: o.y + dy * scale }),
  ];
}

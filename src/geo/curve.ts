import { dedupe, localPlane, originFor } from './projection';
import type { LngLat, PlanePoint } from './projection';

/**
 * Curved centerlines.
 *
 * Streets are stored as control points — the things you drag — and resolved into a dense
 * polyline here, before anything else touches them. That seam is deliberate: offsetting,
 * banding, junction detection and trimming all already consume a polyline, so they need to
 * know nothing about curves at all. Adding a curve mode changes one function, not six.
 *
 * Two modes, because they answer different questions.
 *
 *   rounded  Tangent-arc-tangent, the way a road alignment is actually specified: straight
 *            runs joined by circular arcs of a stated radius. The radius is a real number
 *            a person can read, argue with and hold a design to, which is the whole ethos
 *            of the tool. Sharp corners are radius zero, so a polyline is just this with
 *            the radius turned off.
 *
 *   smooth   A centripetal Catmull-Rom through every control point. Far better for tracing
 *            a genuinely curving street off imagery, where you want to click eight points
 *            along a bend and have the line follow it rather than specify a radius you do
 *            not know.
 *
 * Both keep the endpoints exactly, and both honour per-vertex sharp flags, so a street can
 * curve through a bend and still turn a hard corner at a junction.
 */

export type CurveMode = 'straight' | 'rounded' | 'smooth';

export interface CurveSettings {
  mode: CurveMode;
  /** Corner radius for `rounded`, in metres. */
  radiusMeters: number;
  /** Control point indices to keep as hard corners in either curved mode. */
  sharpVertices?: number[];
}

export const DEFAULT_CURVE: CurveSettings = { mode: 'straight', radiusMeters: 12 };

/**
 * How far the drawn line may stray from the true curve, in metres.
 *
 * Tessellation used to target a fixed chord LENGTH, which asks the wrong question. A
 * 1.2 m chord on a gentle 200 m-radius bend moves the line by under a millimetre — it
 * spends three hundred vertices to change nothing you could see — while the same chord on
 * a tight kerb return is barely enough. Sampling to a deviation instead spends points
 * where the curve actually bends, and the number becomes a guarantee that can be stated:
 * the line is never more than five centimetres from the curve it represents.
 *
 * Five centimetres is an eighth of a pixel at the zoom this tool is worked at, and under
 * two pixels at maximum zoom — comfortably finer than the width of the line drawn over it.
 *
 * This matters far past looking right. Every band, marking and junction trim downstream
 * carries the centerline's vertex count into polygon offsetting and boolean clipping,
 * where cost grows faster than linearly. One over-sampled street was costing more than the
 * other nine put together.
 */
const SAGITTA_TOLERANCE_METRES = 0.05;

/** Never emit more than this many points for one corner or segment. */
const MAX_STEPS = 64;

/** Fraction of the shorter adjacent segment a corner fillet may consume. */
const CORNER_BUDGET = 0.45;

const EPS = 1e-9;

// -------------------------------------------------------------------------- vectors

const sub = (p: PlanePoint, q: PlanePoint): PlanePoint => ({ x: p.x - q.x, y: p.y - q.y });
const add = (p: PlanePoint, q: PlanePoint): PlanePoint => ({ x: p.x + q.x, y: p.y + q.y });
const scale = (p: PlanePoint, k: number): PlanePoint => ({ x: p.x * k, y: p.y * k });
const dot = (p: PlanePoint, q: PlanePoint): number => p.x * q.x + p.y * q.y;
const cross = (p: PlanePoint, q: PlanePoint): number => p.x * q.y - p.y * q.x;
const len = (p: PlanePoint): number => Math.hypot(p.x, p.y);

function unit(p: PlanePoint): PlanePoint {
  const l = len(p) || 1;
  return { x: p.x / l, y: p.y / l };
}

/**
 * How many pieces a curve needs so no piece strays further than the tolerance.
 *
 * Sagitta falls with the square of the subdivision — halve a chord and its bulge drops to
 * a quarter — so the count is the square root of the ratio. That is what makes this scale
 * properly in both directions: a bend gentle enough to be a straight line gets one
 * segment, a tight corner gets as many as it needs, and neither number is a guess.
 */
function stepsForSagitta(sagitta: number): number {
  if (!(sagitta > SAGITTA_TOLERANCE_METRES)) return 1;
  return Math.min(MAX_STEPS, Math.ceil(Math.sqrt(sagitta / SAGITTA_TOLERANCE_METRES)));
}

// -------------------------------------------------------------------------- rounded

/**
 * Round one interior corner with a circular arc.
 *
 * Returns null only when there is nothing to round — a straight-through vertex or a
 * degenerate segment — and the caller keeps the original point.
 *
 * A radius the adjacent segments cannot carry is clamped rather than refused, matching how
 * curb returns behave, because the largest curve that fits is more useful than no curve.
 * The honesty is kept elsewhere: `tightestRadius` measures the resolved line, so the UI can
 * report what the corner actually came out at rather than what was asked for.
 */
function roundCorner(
  previous: PlanePoint,
  vertex: PlanePoint,
  next: PlanePoint,
  radius: number,
): PlanePoint[] | null {
  const inVec = sub(vertex, previous);
  const outVec = sub(next, vertex);
  const inLen = len(inVec);
  const outLen = len(outVec);
  if (inLen < EPS || outLen < EPS || radius <= 0) return null;

  const a = unit(inVec);
  const b = unit(outVec);

  // Interior angle at the vertex, between the two segments as seen from it.
  const cosPhi = Math.max(-1, Math.min(1, dot(scale(a, -1), b)));
  const phi = Math.acos(cosPhi);
  if (phi > Math.PI - 1e-3 || phi < 1e-3) return null;

  const tanHalf = Math.tan(phi / 2);
  if (!Number.isFinite(tanHalf) || Math.abs(tanHalf) < EPS) return null;

  const budget = CORNER_BUDGET * Math.min(inLen, outLen);
  const tangent = Math.min(radius / tanHalf, budget);
  if (tangent < 0.05) return null;

  const applied = tangent * tanHalf;
  const tangentIn = add(vertex, scale(a, -tangent));
  const tangentOut = add(vertex, scale(b, tangent));

  // Centre lies along the bisector of the two segments, on the inside of the turn.
  const bisector = unit(add(scale(a, -1), b));
  const centre = add(vertex, scale(bisector, applied / Math.sin(phi / 2)));

  const startAngle = Math.atan2(tangentIn.y - centre.y, tangentIn.x - centre.x);
  const endAngle = Math.atan2(tangentOut.y - centre.y, tangentOut.x - centre.x);

  // Turn direction decides which way round the circle to go.
  const clockwise = cross(a, b) < 0;
  let sweep = endAngle - startAngle;
  if (clockwise) {
    while (sweep > 0) sweep -= Math.PI * 2;
    while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
  } else {
    while (sweep < 0) sweep += Math.PI * 2;
    while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
  }

  // Exact for a circle: the bulge of a chord spanning the whole sweep is R(1 - cos(θ/2)).
  const count = stepsForSagitta(applied * (1 - Math.cos(Math.abs(sweep) / 2)));
  const out: PlanePoint[] = [];
  for (let i = 0; i <= count; i++) {
    const angle = startAngle + (sweep * i) / count;
    out.push({ x: centre.x + applied * Math.cos(angle), y: centre.y + applied * Math.sin(angle) });
  }
  return out;
}

// --------------------------------------------------------------------------- smooth

/**
 * Centripetal Catmull-Rom, sampled per segment.
 *
 * Centripetal (alpha = 0.5) rather than uniform: uniform Catmull-Rom overshoots and can
 * loop when control points are unevenly spaced, which is exactly what hand-clicking along
 * a bend produces. The curve still passes through every control point.
 */
function catmullRom(points: readonly PlanePoint[], sharp: ReadonlySet<number>): PlanePoint[] {
  if (points.length < 3) return points.map((p) => ({ ...p }));

  const out: PlanePoint[] = [{ ...points[0]! }];

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]!;
    const p2 = points[i + 1]!;

    // A sharp endpoint on either side means this segment stays a straight run.
    if (sharp.has(i) && sharp.has(i + 1)) {
      out.push({ ...p2 });
      continue;
    }

    const p0 = sharp.has(i) ? p1 : (points[i - 1] ?? p1);
    const p3 = sharp.has(i + 1) ? p2 : (points[i + 2] ?? p2);

    const t0 = 0;
    const t1 = t0 + Math.sqrt(len(sub(p1, p0))) || t0 + EPS;
    const t2 = t1 + Math.sqrt(len(sub(p2, p1))) || t1 + EPS;
    const t3 = t2 + Math.sqrt(len(sub(p3, p2))) || t2 + EPS;

    const at = (t: number): PlanePoint => {
      const a1 = lerpT(p0, p1, t0, t1, t);
      const a2 = lerpT(p1, p2, t1, t2, t);
      const a3 = lerpT(p2, p3, t2, t3, t);
      const b1 = lerpT(a1, a2, t0, t2, t);
      const b2 = lerpT(a2, a3, t1, t3, t);
      return lerpT(b1, b2, t1, t2, t);
    };

    // How far this piece of spline actually bows away from its own chord.
    //
    // Three probes rather than one, because a segment shaped like a shallow S crosses its
    // chord at the middle: a single midpoint sample would read that as flat and draw a
    // curve as a straight line. The quarter points catch it.
    const chord = (k: number): PlanePoint => ({
      x: p1.x + (p2.x - p1.x) * k,
      y: p1.y + (p2.y - p1.y) * k,
    });
    let sagitta = 0;
    for (const k of [0.25, 0.5, 0.75]) {
      sagitta = Math.max(sagitta, len(sub(at(t1 + (t2 - t1) * k), chord(k))));
    }

    const count = stepsForSagitta(sagitta);
    for (let s = 1; s <= count; s++) {
      out.push(at(t1 + ((t2 - t1) * s) / count));
    }
  }

  return out;
}

function lerpT(
  a: PlanePoint,
  b: PlanePoint,
  ta: number,
  tb: number,
  t: number,
): PlanePoint {
  const span = tb - ta;
  if (Math.abs(span) < EPS) return { ...b };
  const k = (t - ta) / span;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

// --------------------------------------------------------------------------- public

/**
 * Resolve control points into the polyline everything downstream works on.
 *
 * Straight mode returns the input unchanged, so nothing pays for a feature it is not
 * using — and a project with no curves produces byte-identical geometry to before.
 */
export function tessellate(
  controlPoints: readonly LngLat[],
  settings: CurveSettings = DEFAULT_CURVE,
): LngLat[] {
  const points = dedupe(controlPoints);
  if (settings.mode === 'straight' || points.length < 3) return points;

  const plane = localPlane(originFor(points));
  const planar = points.map((p) => plane.toPlane(p));
  const sharp = new Set(settings.sharpVertices ?? []);

  if (settings.mode === 'smooth') {
    return catmullRom(planar, sharp).map((p) => plane.toLngLat(p) as LngLat);
  }

  const out: PlanePoint[] = [{ ...planar[0]! }];
  for (let i = 1; i < planar.length - 1; i++) {
    if (sharp.has(i)) {
      out.push({ ...planar[i]! });
      continue;
    }
    const arc = roundCorner(planar[i - 1]!, planar[i]!, planar[i + 1]!, settings.radiusMeters);
    if (arc) out.push(...arc);
    else out.push({ ...planar[i]! });
  }
  out.push({ ...planar[planar.length - 1]! });

  return dedupe(out.map((p) => plane.toLngLat(p) as LngLat), 1e-11);
}

/**
 * Tightest radius actually present in a resolved line, in metres.
 *
 * Reported rather than assumed: a rounded corner clamped by a short segment does not have
 * the radius that was asked for, and a design that quietly claims one it does not have is
 * the failure this whole project is trying to avoid. Returns Infinity for a straight line.
 */
export function tightestRadius(line: readonly LngLat[]): number {
  if (line.length < 3) return Infinity;
  const plane = localPlane(originFor(line));
  const pts = line.map((p) => plane.toPlane(p));

  let tightest = Infinity;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const ab = len(sub(b, a));
    const bc = len(sub(c, b));
    const ca = len(sub(a, c));
    const area = Math.abs(cross(sub(b, a), sub(c, a))) / 2;
    if (area < 1e-9) continue;
    // Circumradius of the three points: the local radius of curvature.
    tightest = Math.min(tightest, (ab * bc * ca) / (4 * area));
  }
  return tightest;
}

/**
 * Resolve a closed ring, wrapping the curve around the closure.
 *
 * A ring has no ends, so every control point is an interior one — including the first.
 * Reusing the open tessellator would leave a hard corner at whichever vertex happened to
 * be index 0, which is an arbitrary artefact of how the shape was drawn rather than
 * anything the user asked for.
 *
 * Input is unclosed (the first point is not repeated); output is unclosed too, so callers
 * close it themselves the way GeoJSON wants.
 */
export function tessellateRing(
  controlPoints: readonly LngLat[],
  settings: CurveSettings = DEFAULT_CURVE,
): LngLat[] {
  const points = dedupe(controlPoints);
  if (settings.mode === 'straight' || points.length < 3) return points;

  const plane = localPlane(originFor(points));
  const planar = points.map((p) => plane.toPlane(p));
  const sharp = new Set(settings.sharpVertices ?? []);
  const n = planar.length;
  const back = (i: number) => planar[(i - 1 + n) % n]!;
  const forward = (i: number) => planar[(i + 1) % n]!;

  if (settings.mode === 'smooth') {
    // Wrap two points either side so the spline is continuous across the closure.
    const wrapped = [planar[n - 1]!, ...planar, planar[0]!, planar[1]!];
    const shifted = new Set([...sharp].map((i) => i + 1));
    const curve = catmullRom(wrapped, shifted);
    // Drop the samples belonging to the wrapped padding segments.
    const trimmed = curve.slice(1, curve.length - 1);
    return dedupe(trimmed.map((p) => plane.toLngLat(p) as LngLat), 1e-11);
  }

  const out: PlanePoint[] = [];
  for (let i = 0; i < n; i++) {
    if (sharp.has(i)) {
      out.push({ ...planar[i]! });
      continue;
    }
    const arc = roundCorner(back(i), planar[i]!, forward(i), settings.radiusMeters);
    if (arc) out.push(...arc);
    else out.push({ ...planar[i]! });
  }

  return dedupe(out.map((p) => plane.toLngLat(p) as LngLat), 1e-11);
}

// -------------------------------------------------------------------- memoised access

interface CurvedLine {
  id: string;
  centerline: readonly LngLat[];
  curve?: CurveSettings | undefined;
}

interface CurvedRing {
  id: string;
  ring: readonly LngLat[];
  curve?: CurveSettings | undefined;
}

interface ResolvedEntry {
  centerline: readonly LngLat[];
  curve: CurveSettings | undefined;
  resolved: LngLat[];
}

const resolvedCache = new Map<string, ResolvedEntry>();

/**
 * The polyline everything downstream works on, memoised on input identity.
 *
 * Every consumer must go through here rather than reading `centerline` directly, and that
 * includes junction detection: if bands followed the curve while junctions were detected
 * against the straight control polygon, the two would disagree about where streets meet
 * and the trimming would carve holes in the wrong place.
 *
 * Cached because a smooth centerline can be several hundred points and is rebuilt on every
 * frame of a drag. Reference equality is enough — the store never mutates in place.
 */
export function resolveCenterline(street: CurvedLine): LngLat[] {
  const hit = resolvedCache.get(street.id);
  if (hit && hit.centerline === street.centerline && hit.curve === street.curve) {
    return hit.resolved;
  }
  const resolved = tessellate(street.centerline, street.curve ?? DEFAULT_CURVE);
  resolvedCache.set(street.id, { centerline: street.centerline, curve: street.curve, resolved });
  return resolved;
}

/** Drop cached lines for streets that no longer exist. */
export function pruneResolvedCache(liveIds: ReadonlySet<string>): void {
  for (const id of [...resolvedCache.keys()]) if (!liveIds.has(id)) resolvedCache.delete(id);
}

const resolvedRingCache = new Map<string, ResolvedEntry>();

/** The closed ring an area is actually drawn as, memoised on input identity. */
export function resolveRing(area: CurvedRing): LngLat[] {
  const hit = resolvedRingCache.get(area.id);
  if (hit && hit.centerline === area.ring && hit.curve === area.curve) return hit.resolved;
  const resolved = tessellateRing(area.ring, area.curve ?? DEFAULT_CURVE);
  resolvedRingCache.set(area.id, { centerline: area.ring, curve: area.curve, resolved });
  return resolved;
}

export function pruneResolvedRingCache(liveIds: ReadonlySet<string>): void {
  for (const id of [...resolvedRingCache.keys()]) if (!liveIds.has(id)) resolvedRingCache.delete(id);
}

/** Close a ring for GeoJSON: repeat the first point at the end. */
export function closeRing(ring: readonly LngLat[]): LngLat[] {
  if (ring.length === 0) return [];
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  const closed = ring.map((p) => [p[0], p[1]] as LngLat);
  if (first[0] !== last[0] || first[1] !== last[1]) closed.push([first[0], first[1]]);
  return closed;
}

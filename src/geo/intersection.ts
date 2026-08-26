import type { LngLat, LocalPlane, PlanePoint } from './projection';
import type { Junction, JunctionLeg } from './junctions';

/**
 * Intersection geometry: curb returns, the paved area, and the footprint.
 *
 * Two rings come out of here, and the distinction between them is the whole reason
 * intersections look right rather than merely trimmed:
 *
 *   paved      bounded by the legs' curb-to-curb edges and the corner returns. Roadway
 *              components are clipped OUTSIDE this, and the junction fills it, so asphalt
 *              reads as one continuous surface through the intersection.
 *   footprint  the same walk at the full section width, with the returns widened by
 *              whatever sits outside the kerb. Everything that is not roadway is clipped
 *              outside this, and the ring is drawn underneath the paved one, so what shows
 *              around each corner is the footway turning the corner. No boolean is needed
 *              for that; z-order does it.
 *
 * The two rings get their own stop offsets, because a footway really does stay curved for
 * longer than a lane does: a 4.5 m kerb return with a 3 m footway behind it puts the back
 * of walk on a 7.5 m radius, and that does not straighten out until much further from the
 * centre than the kerb does.
 *
 * The corner radius is the single most consequential number at an intersection — it sets
 * how fast a driver takes the turn and how long a person on foot is exposed — so it is a
 * first-class per-corner input rather than a constant.
 *
 * Everything is planar metres. The caller supplies the plane so junction geometry and the
 * banding it has to line up with are computed in the same frame.
 */

const EPS = 1e-9;

/** Degrees of arc per generated segment. 12 keeps a 4.5 m return visually smooth. */
const ARC_STEP_DEG = 12;

/** Clear space kept beyond the last curb return before the cross-section resumes. */
export const STOP_MARGIN_METRES = 0.6;

/** NACTO's usual starting point for an urban corner, and the number worth arguing down. */
export const DEFAULT_CORNER_RADIUS_METRES = 4.5;

/** Below this the two curb lines are parallel and there is no corner to fillet. */
const PARALLEL_EPS = 0.02;

/** A radius smaller than this is drawn as a sharp corner; an arc would be invisible. */
const MIN_RADIUS_METRES = 0.05;

export interface CornerInput {
  radiusMeters?: number;
}

export interface CornerGeometry {
  /** This corner sits counter-clockwise from leg `index`, between it and the next leg. */
  index: number;
  radiusMeters: number;
  /** What was actually used — a radius is clamped when the legs are too short or sharp. */
  appliedRadiusMeters: number;
  /** Interior angle of the corner, degrees. 180 means the street simply runs past. */
  angleDegrees: number;
  centre: LngLat | null;
  clamped: boolean;
}

export interface LegGeometry {
  streetId: string;
  sense: 1 | -1;
  /** Where the roadway resumes: the intersection box, and the stop bar line. */
  stopOffsetMeters: number;
  /** Where the footway resumes. Always at or beyond the roadway's. */
  footStopOffsetMeters: number;
  /** The stop line, kerb to kerb. Its length is the pedestrian crossing distance. */
  stopLine: [LngLat, LngLat];
  crossingDistanceMeters: number;
  /** True when the returns need more room than the street has left. */
  overrunsLeg: boolean;
}

export interface JunctionGeometry {
  key: string;
  centre: LngLat;
  /** Closed ring, kerb to kerb, including the corner returns. */
  paved: LngLat[];
  /** Closed ring at the full section width. */
  footprint: LngLat[];
  legs: LegGeometry[];
  corners: CornerGeometry[];
  warnings: string[];
}

export interface JunctionOptions {
  /** Per-corner overrides, indexed to match `junction.legs`. */
  corners?: readonly CornerInput[];
  /** Extra setback per leg, metres. The derived minimum is always respected. */
  stopOffsets?: readonly (number | null | undefined)[];
  defaultRadiusMeters?: number;
}

// -------------------------------------------------------------------------- vectors

const add = (p: PlanePoint, q: PlanePoint): PlanePoint => ({ x: p.x + q.x, y: p.y + q.y });
const sub = (p: PlanePoint, q: PlanePoint): PlanePoint => ({ x: p.x - q.x, y: p.y - q.y });
const scale = (p: PlanePoint, k: number): PlanePoint => ({ x: p.x * k, y: p.y * k });
const dot = (p: PlanePoint, q: PlanePoint): number => p.x * q.x + p.y * q.y;

function unit(bearing: number): PlanePoint {
  return { x: Math.cos(bearing), y: Math.sin(bearing) };
}

/** Left-hand normal of a direction, looking along it. */
function leftOf(d: PlanePoint): PlanePoint {
  return { x: -d.y, y: d.x };
}

function normalise(p: PlanePoint): PlanePoint {
  const len = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / len, y: p.y / len };
}

/** Intersection of two infinite lines given as point + direction. Null if parallel. */
function lineCross(
  p: PlanePoint,
  dp: PlanePoint,
  q: PlanePoint,
  dq: PlanePoint,
): PlanePoint | null {
  const denom = dp.x * dq.y - dp.y * dq.x;
  if (Math.abs(denom) < PARALLEL_EPS) return null;
  const t = ((q.x - p.x) * dq.y - (q.y - p.y) * dq.x) / denom;
  return add(p, scale(dp, t));
}

function angleOf(centre: PlanePoint, p: PlanePoint): number {
  return Math.atan2(p.y - centre.y, p.x - centre.x);
}

/**
 * Points along a corner return.
 *
 * Walking the ring counter-clockwise, a curb return is traversed clockwise — the return
 * adds pavement into the corner quadrant, so the arc turns the opposite way to the ring.
 */
function arcPoints(
  centre: PlanePoint,
  radius: number,
  fromAngle: number,
  toAngle: number,
): PlanePoint[] {
  let sweep = fromAngle - toAngle;
  while (sweep < 0) sweep += Math.PI * 2;
  const steps = Math.max(2, Math.ceil((sweep * 180) / Math.PI / ARC_STEP_DEG));

  const out: PlanePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = fromAngle - (sweep * i) / steps;
    out.push({ x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) });
  }
  return out;
}

// ---------------------------------------------------------------------------- frames

interface Frame {
  d: PlanePoint;
  n: PlanePoint;
  /** The leg's outer edges, as lines through these points along `d`. */
  leftEdge: PlanePoint;
  rightEdge: PlanePoint;
  halfLeft: number;
  halfRight: number;
}

function frameFor(origin: PlanePoint, leg: JunctionLeg, useTravelway: boolean): Frame {
  const d = unit(leg.bearing);
  const n = leftOf(d);
  const halfLeft = useTravelway ? leg.travelwayHalfLeft : leg.halfLeft;
  const halfRight = useTravelway ? leg.travelwayHalfRight : leg.halfRight;
  return {
    d,
    n,
    halfLeft,
    halfRight,
    leftEdge: add(origin, scale(n, halfLeft)),
    rightEdge: add(origin, scale(n, -halfRight)),
  };
}

// --------------------------------------------------------------------------- fillets

interface Fillet {
  /** Tangent point on the earlier leg's left edge. */
  fromPoint: PlanePoint;
  /** Tangent point on the later leg's right edge. */
  toPoint: PlanePoint;
  centre: PlanePoint | null;
  radius: number;
  requested: number;
  clamped: boolean;
  angleRad: number;
  /** How far out along each leg the tangent point sits. Drives the stop offset. */
  fromProjection: number;
  toProjection: number;
}

/**
 * Fillet the corner between two adjacent legs.
 *
 * The two kerb lines meet at a sharp point C. The return is inscribed in the wedge at C
 * formed by the two legs running *away* from the junction — that wedge is the footway
 * corner, and rounding it is precisely what a kerb return does: it adds pavement into the
 * corner so a vehicle can turn. Tangent distance R/tan(theta/2) from C, centre
 * R/sin(theta/2) along the outward bisector.
 *
 * Getting the side wrong is not a subtle error. Putting the centre on the pavement side
 * bites a chunk out of the intersection instead of rounding it, and once the radius
 * exceeds the street's half-width the ring folds over itself and the area collapses.
 *
 * Two degenerate cases are real rather than theoretical. Antiparallel legs — the straight
 * side of a T-junction — have no corner at all and the edges are simply joined. Legs too
 * short or too acute to carry the requested radius get it clamped to what fits, and say so.
 */
function filletBetween(
  origin: PlanePoint,
  a: JunctionLeg,
  b: JunctionLeg,
  requestedRadius: number,
  useTravelway: boolean,
): Fillet {
  const fa = frameFor(origin, a, useTravelway);
  const fb = frameFor(origin, b, useTravelway);

  // Going counter-clockwise, the corner sits on a's left and b's right.
  const corner = lineCross(fa.leftEdge, fa.d, fb.rightEdge, fb.d);

  let angle = b.bearing - a.bearing;
  while (angle <= 0) angle += Math.PI * 2;
  while (angle > Math.PI * 2) angle -= Math.PI * 2;

  const project = (p: PlanePoint, frame: Frame) => dot(sub(p, origin), frame.d);

  if (!corner || Math.abs(Math.sin(angle)) < PARALLEL_EPS) {
    // The street runs straight past. If the two sections are asymmetric this is a short
    // jog rather than a continuous line, which is right — the kerb really does step.
    return {
      fromPoint: fa.leftEdge,
      toPoint: fb.rightEdge,
      centre: null,
      radius: 0,
      requested: requestedRadius,
      clamped: false,
      angleRad: angle,
      fromProjection: project(fa.leftEdge, fa),
      toProjection: project(fb.rightEdge, fb),
    };
  }

  const cornerProjectionA = project(corner, fa);
  const cornerProjectionB = project(corner, fb);

  // How much tangent length each leg can spare before the return runs off its end. A
  // return that reaches past the end of a short leg produces a ring that folds over.
  const budget = Math.max(
    0,
    Math.min(
      a.lengthMeters - cornerProjectionA - STOP_MARGIN_METRES,
      b.lengthMeters - cornerProjectionB - STOP_MARGIN_METRES,
    ),
  );

  const tanHalf = Math.tan(angle / 2);
  let radius = Math.max(0, requestedRadius);
  let tangent = Math.abs(tanHalf) < EPS ? Infinity : radius / tanHalf;
  let clamped = false;

  if (!Number.isFinite(tangent) || tangent > budget) {
    tangent = budget;
    radius = Math.max(0, tangent * tanHalf);
    clamped = true;
  }

  if (radius < MIN_RADIUS_METRES) {
    // Sharp corner. Still a valid intersection, just an uncomfortable one.
    return {
      fromPoint: corner,
      toPoint: corner,
      centre: null,
      radius: 0,
      requested: requestedRadius,
      clamped,
      angleRad: angle,
      fromProjection: cornerProjectionA,
      toProjection: cornerProjectionB,
    };
  }

  // Outward bisector: the return sits in the corner quadrant, away from the junction.
  const bisector = normalise(add(fa.d, fb.d));
  const centre = add(corner, scale(bisector, radius / Math.sin(angle / 2)));
  const fromPoint = add(corner, scale(fa.d, tangent));
  const toPoint = add(corner, scale(fb.d, tangent));

  return {
    fromPoint,
    toPoint,
    centre,
    radius,
    requested: requestedRadius,
    clamped,
    angleRad: angle,
    fromProjection: project(fromPoint, fa),
    toProjection: project(toPoint, fb),
  };
}

// ------------------------------------------------------------------------------ ring

/**
 * The cross-section cannot resume until it is clear of both returns on that leg.
 *
 * Derived by default, exactly like the section anchor: the right value falls out of the
 * geometry, and asking a user to supply it would mostly be asking them to get it wrong.
 */
function stopOffsetsFor(
  legs: readonly JunctionLeg[],
  fillets: readonly Fillet[],
  extra: readonly (number | null | undefined)[] | undefined,
): number[] {
  return legs.map((_, i) => {
    const before = fillets[(i - 1 + legs.length) % legs.length]!;
    const after = fillets[i]!;
    const minimum = Math.max(before.toProjection, after.fromProjection, 0.5) + STOP_MARGIN_METRES;
    const requested = extra?.[i];
    return requested === null || requested === undefined ? minimum : Math.max(requested, minimum);
  });
}

/**
 * Walk the boundary counter-clockwise.
 *
 * For each leg: outward along its right edge to the stop line, across the stop line, back
 * inward along its left edge to the corner tangent, then round the corner onto the next
 * leg's right edge. That single traversal produces the familiar rounded-cross outline with
 * no boolean union, and therefore no union artefacts between nearly-collinear legs.
 */
function buildRing(
  origin: PlanePoint,
  legs: readonly JunctionLeg[],
  fillets: readonly Fillet[],
  stopOffsets: readonly number[],
  useTravelway: boolean,
): PlanePoint[] {
  const ring: PlanePoint[] = [];

  legs.forEach((leg, i) => {
    const frame = frameFor(origin, leg, useTravelway);
    const at = add(origin, scale(frame.d, stopOffsets[i]!));
    const previous = fillets[(i - 1 + legs.length) % legs.length]!;
    const next = fillets[i]!;

    ring.push(previous.toPoint);
    ring.push(add(at, scale(frame.n, -frame.halfRight)));
    ring.push(add(at, scale(frame.n, frame.halfLeft)));
    ring.push(next.fromPoint);

    if (next.centre) {
      const arc = arcPoints(
        next.centre,
        next.radius,
        angleOf(next.centre, next.fromPoint),
        angleOf(next.centre, next.toPoint),
      );
      // The endpoints are already in the ring, here and at the next leg's start.
      ring.push(...arc.slice(1, -1));
    }
  });

  return ring;
}

function close(ring: PlanePoint[]): PlanePoint[] {
  if (ring.length === 0) return ring;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (Math.abs(first.x - last.x) > EPS || Math.abs(first.y - last.y) > EPS) {
    ring.push({ ...first });
  }
  return ring;
}

// ---------------------------------------------------------------------------- public

/**
 * Build the geometry for one junction.
 *
 * Returns empty rings rather than throwing for a junction with fewer than three legs: two
 * streets that merely touch end to end are a continuation, not an intersection, and
 * carving a hole there would be wrong.
 */
export function junctionGeometry(
  junction: Junction,
  plane: LocalPlane,
  options: JunctionOptions = {},
): JunctionGeometry {
  const legs = junction.legs;
  const origin = plane.toPlane(junction.position);
  const warnings: string[] = [];
  const defaultRadius = options.defaultRadiusMeters ?? DEFAULT_CORNER_RADIUS_METRES;

  if (legs.length < 3) {
    return {
      key: junction.key,
      centre: junction.position,
      paved: [],
      footprint: [],
      legs: [],
      corners: [],
      warnings,
    };
  }

  const radii = legs.map((_, i) => options.corners?.[i]?.radiusMeters ?? defaultRadius);

  // Corners are built twice — once against the kerb lines, once against the section edges.
  // The footway return is a wider arc around a different corner point, not the kerb arc
  // offset outward, and sharing one would pinch the footway on asymmetric sections.
  const pavedFillets = legs.map((leg, i) =>
    filletBetween(origin, leg, legs[(i + 1) % legs.length]!, radii[i]!, true),
  );

  const footFillets = legs.map((leg, i) => {
    const next = legs[(i + 1) % legs.length]!;
    const outside = Math.max(
      leg.halfLeft - leg.travelwayHalfLeft,
      next.halfRight - next.travelwayHalfRight,
      0,
    );
    return filletBetween(origin, leg, next, radii[i]! + outside, false);
  });

  const pavedOffsets = stopOffsetsFor(legs, pavedFillets, options.stopOffsets);
  const footOffsets = stopOffsetsFor(legs, footFillets, options.stopOffsets);

  const paved = close(buildRing(origin, legs, pavedFillets, pavedOffsets, true));
  const footprint = close(buildRing(origin, legs, footFillets, footOffsets, false));

  const legGeometry: LegGeometry[] = legs.map((leg, i) => {
    const frame = frameFor(origin, leg, true);
    const at = add(origin, scale(frame.d, pavedOffsets[i]!));
    const overrunsLeg = footOffsets[i]! > leg.lengthMeters;

    if (overrunsLeg) {
      warnings.push(
        `A ${leg.lengthMeters.toFixed(0)} m leg cannot fit corner returns needing ${footOffsets[i]!.toFixed(0)} m. Tighten the corners or extend the street.`,
      );
    }

    return {
      streetId: leg.streetId,
      sense: leg.sense,
      stopOffsetMeters: pavedOffsets[i]!,
      footStopOffsetMeters: footOffsets[i]!,
      stopLine: [
        plane.toLngLat(add(at, scale(frame.n, -frame.halfRight))),
        plane.toLngLat(add(at, scale(frame.n, frame.halfLeft))),
      ],
      crossingDistanceMeters: frame.halfLeft + frame.halfRight,
      overrunsLeg,
    };
  });

  const corners: CornerGeometry[] = pavedFillets.map((fillet, i) => {
    if (fillet.clamped && fillet.angleRad < Math.PI - 0.05) {
      warnings.push(
        `Corner ${i + 1} was tightened to ${fillet.radius.toFixed(1)} m — the legs meeting there are too short or too sharp for ${fillet.requested.toFixed(1)} m.`,
      );
    }
    return {
      index: i,
      radiusMeters: fillet.requested,
      appliedRadiusMeters: fillet.radius,
      angleDegrees: (fillet.angleRad * 180) / Math.PI,
      centre: fillet.centre ? plane.toLngLat(fillet.centre) : null,
      clamped: fillet.clamped,
    };
  });

  return {
    key: junction.key,
    centre: junction.position,
    paved: paved.map((p) => plane.toLngLat(p)),
    footprint: footprint.map((p) => plane.toLngLat(p)),
    legs: legGeometry,
    corners,
    warnings,
  };
}

/** Signed area of a planar ring in square metres. Positive when counter-clockwise. */
export function ringArea(ring: readonly PlanePoint[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i]!.x * ring[i + 1]!.y - ring[i + 1]!.x * ring[i]!.y;
  }
  return sum / 2;
}

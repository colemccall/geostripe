import type { LngLat, LocalPlane, PlanePoint } from './projection';
import type { Junction, JunctionLeg } from './junctions';

/**
 * Intersection geometry: curb returns, crossings, corner treatments, and the areas that
 * streets are trimmed against.
 *
 * Three rings come out of here, and the differences between them are load-bearing:
 *
 *   paved        the asphalt fill, with any bulb-outs taken out of it.
 *   roadwayCut   the same walk with the bulb-outs put back. Roadway components are cut
 *                against this, so the ground a bulb-out reclaims loses its lane bands and
 *                shows the footway underneath.
 *   footprint    the walk at full section width, drawn beneath everything, so what shows
 *                around each corner is the footway turning it.
 *
 * The footprint is unaffected by bulb-outs on purpose: a curb extension widens the footway
 * and narrows the roadway, so the back of walk does not move. That is what lets the extra
 * footway appear with no boolean at all — the stacking order is the boolean.
 *
 * The corner radius and the bulb-out are the two controls that move the number this whole
 * tool exists to argue about. Crossing distance is measured across the *bulbed* roadway,
 * so extending a curb visibly shortens the walk, which is exactly the claim a redesign
 * needs to be able to make honestly.
 *
 * Everything is planar metres. The caller supplies the plane so junction geometry and the
 * banding it has to line up with are computed in the same frame.
 */

const EPS = 1e-9;

/** Degrees of arc per generated segment. 12 keeps a 4.5 m return visually smooth. */
const ARC_STEP_DEG = 12;

/** Clear space kept beyond the last return before the cross-section resumes. */
export const STOP_MARGIN_METRES = 0.6;

/** NACTO's usual starting point for an urban corner, and the number worth arguing down. */
export const DEFAULT_CORNER_RADIUS_METRES = 4.5;

/** A curb extension usually reclaims exactly the parking lane it replaces. */
export const DEFAULT_BULB_OUT_METRES = 2.4;

/** Parking pulled back from a corner so drivers and pedestrians can see each other. */
export const DEFAULT_DAYLIGHT_METRES = 6;

/** 10 ft, the usual marked width, measured along the direction of travel. */
export const DEFAULT_CROSSWALK_WIDTH_METRES = 3;

/** Below this the two curb lines are parallel and there is no corner to fillet. */
const PARALLEL_EPS = 0.02;

/** A radius smaller than this is drawn as a sharp corner; an arc would be invisible. */
const MIN_RADIUS_METRES = 0.05;

/** Roadway left un-bulbed on each side, so a curb extension can never close the street. */
const MIN_REMAINING_HALF_METRES = 1.5;

/** Continental bars and the gaps between them. */
const STRIPE_WIDTH_METRES = 0.5;
const STRIPE_GAP_METRES = 0.5;

/** Thickness of a transverse crosswalk edge line, and of a stop bar. */
const EDGE_LINE_METRES = 0.15;
const STOP_BAR_METRES = 0.6;

/** Gap between the far edge of a crossing and the stop bar behind it. */
const STOP_BAR_GAP_METRES = 1.2;

export type CrosswalkStyle = 'transverse' | 'continental' | 'ladder' | 'raised';
export type CornerTreatment = 'plain' | 'bulbOut';

export interface CrosswalkSpec {
  style: CrosswalkStyle;
  /** Along the direction of travel. */
  widthMeters: number;
  /** Pushed back from the intersection edge. Zero puts it against the corner returns. */
  setbackMeters: number;
}

export interface CornerInput {
  radiusMeters?: number;
  treatment?: CornerTreatment;
  /** How far the curb is extended into the roadway. Only used when treatment is bulbOut. */
  bulbOutMeters?: number;
  /** Parking suppressed within this distance of the corner. */
  daylightMeters?: number;
}

export interface LegInput {
  crosswalk?: CrosswalkSpec | null;
  stopBar?: boolean;
  /** Extra setback. The derived minimum is always respected. */
  stopOffsetMeters?: number | null;
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
  treatment: CornerTreatment;
  /** What the curb extension actually reclaimed, after clamping. */
  appliedBulbOutMeters: number;
  daylightMeters: number;
}

export interface LegGeometry {
  streetId: string;
  sense: 1 | -1;
  /** Where the roadway resumes: the intersection box. */
  stopOffsetMeters: number;
  /** Where the footway resumes. Always at or beyond the roadway's. */
  footStopOffsetMeters: number;
  /** The stop line, curb to curb. Its length is the pedestrian crossing distance. */
  stopLine: [LngLat, LngLat];
  /**
   * Kerb-to-kerb, measured across the *bulbed* roadway — so a curb extension shortens it.
   * This is the pedestrian counterpart to a street's fit check.
   */
  crossingDistanceMeters: number;
  /** What it would have been without the curb extensions, for the before/after claim. */
  crossingDistanceWithoutBulbsMeters: number;
  hasCrosswalk: boolean;
  /** True when the returns need more room than the street has left. */
  overrunsLeg: boolean;
}

export interface CrossingPart {
  legIndex: number;
  kind: 'stripe' | 'edge' | 'table' | 'stopBar';
  ring: LngLat[];
}

export interface JunctionGeometry {
  key: string;
  centre: LngLat;
  /** Asphalt fill, with bulb-outs removed. */
  paved: LngLat[];
  /** What roadway bands are cut against: the same walk with bulb-outs put back. */
  roadwayCut: LngLat[];
  /** Full section width; drawn underneath in footway colour. */
  footprint: LngLat[];
  crossings: CrossingPart[];
  /** Rectangles in which parking is suppressed, per leg. */
  daylightZones: { legIndex: number; ring: LngLat[] }[];
  legs: LegGeometry[];
  corners: CornerGeometry[];
  warnings: string[];
}

export interface JunctionOptions {
  /** Per-corner overrides, indexed to match `junction.legs`. */
  corners?: readonly CornerInput[];
  /** Per-leg overrides, indexed to match `junction.legs`. */
  legs?: readonly LegInput[];
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
  leftEdge: PlanePoint;
  rightEdge: PlanePoint;
  halfLeft: number;
  halfRight: number;
}

/**
 * A leg's local frame. `insetLeft` / `insetRight` pull the kerb in — that is a bulb-out,
 * and it is applied to the kerb lines rather than bolted on afterwards so the corner
 * return is built against the extended kerb and comes out tangent to it.
 */
function frameFor(
  origin: PlanePoint,
  leg: JunctionLeg,
  useTravelway: boolean,
  insetLeft = 0,
  insetRight = 0,
): Frame {
  const d = unit(leg.bearing);
  const n = leftOf(d);
  const halfLeft = (useTravelway ? leg.travelwayHalfLeft : leg.halfLeft) - insetLeft;
  const halfRight = (useTravelway ? leg.travelwayHalfRight : leg.halfRight) - insetRight;
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
  fromPoint: PlanePoint;
  toPoint: PlanePoint;
  centre: PlanePoint | null;
  radius: number;
  requested: number;
  clamped: boolean;
  angleRad: number;
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
  insetA = 0,
  insetB = 0,
): Fillet {
  const fa = frameFor(origin, a, useTravelway, insetA, 0);
  const fb = frameFor(origin, b, useTravelway, 0, insetB);

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

interface LegShape {
  leftInset: number;
  rightInset: number;
  /** Projection out to which the inset is held before tapering back to full width. */
  bulbEndMeters: number;
  taperMeters: number;
}

const NO_BULB: LegShape = { leftInset: 0, rightInset: 0, bulbEndMeters: 0, taperMeters: 0 };

/**
 * Walk the boundary counter-clockwise.
 *
 * For each leg: outward along its right edge to the stop line, across the stop line, back
 * inward along its left edge to the corner tangent, then round the corner onto the next
 * leg's right edge. That single traversal produces the familiar rounded-cross outline with
 * no boolean union, and therefore no union artefacts between nearly-collinear legs.
 *
 * A bulb-out adds two points per side: hold the extended kerb out past the crossing, then
 * taper back to the running width. Holding it past the crossing is the whole point — a
 * curb extension that stopped short of the crosswalk would not shorten the walk.
 */
function buildRing(
  origin: PlanePoint,
  legs: readonly JunctionLeg[],
  fillets: readonly Fillet[],
  stopOffsets: readonly number[],
  shapes: readonly LegShape[],
  useTravelway: boolean,
): PlanePoint[] {
  const ring: PlanePoint[] = [];

  legs.forEach((leg, i) => {
    const shape = shapes[i]!;
    const frame = frameFor(origin, leg, useTravelway, shape.leftInset, shape.rightInset);
    const full = frameFor(origin, leg, useTravelway);
    const stop = stopOffsets[i]!;
    const previous = fillets[(i - 1 + legs.length) % legs.length]!;
    const next = fillets[i]!;

    const along = (metres: number, across: number) =>
      add(add(origin, scale(frame.d, metres)), scale(frame.n, across));

    ring.push(previous.toPoint);

    if (shape.rightInset > EPS) {
      const hold = Math.max(shape.bulbEndMeters, previous.toProjection);
      ring.push(along(hold, -frame.halfRight));
      ring.push(along(hold + shape.taperMeters, -full.halfRight));
    }

    ring.push(along(stop, -full.halfRight));
    ring.push(along(stop, full.halfLeft));

    if (shape.leftInset > EPS) {
      const hold = Math.max(shape.bulbEndMeters, next.fromProjection);
      ring.push(along(hold + shape.taperMeters, full.halfLeft));
      ring.push(along(hold, frame.halfLeft));
    }

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

/**
 * A box in a leg's local frame, given as ranges along the leg and across it.
 *
 * Across is signed the way the frame is: positive to the leg's left looking outward. Both
 * ranges are explicit rather than derived from half-widths, because crossings and stop
 * bars cover only part of the roadway and a half-width argument reads as the whole of it.
 */
function legBox(
  origin: PlanePoint,
  frame: Frame,
  from: number,
  to: number,
  acrossFrom: number,
  acrossTo: number,
): PlanePoint[] {
  const at = (metres: number, across: number) =>
    add(add(origin, scale(frame.d, metres)), scale(frame.n, across));
  return [
    at(from, acrossFrom),
    at(to, acrossFrom),
    at(to, acrossTo),
    at(from, acrossTo),
    at(from, acrossFrom),
  ];
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
  const count = legs.length;

  if (count < 3) {
    return {
      key: junction.key,
      centre: junction.position,
      paved: [],
      roadwayCut: [],
      footprint: [],
      crossings: [],
      daylightZones: [],
      legs: [],
      corners: [],
      warnings,
    };
  }

  const radii = legs.map((_, i) => options.corners?.[i]?.radiusMeters ?? defaultRadius);
  const treatments = legs.map<CornerTreatment>((_, i) => options.corners?.[i]?.treatment ?? 'plain');

  // ---- corners without any curb extension. These fix where the intersection "edge" is,
  // which everything downstream is measured from — including the bulb-outs themselves,
  // so the two cannot chase each other.
  const plainFillets = legs.map((leg, i) =>
    filletBetween(origin, leg, legs[(i + 1) % count]!, radii[i]!, true),
  );

  const footFillets = legs.map((leg, i) => {
    const next = legs[(i + 1) % count]!;
    const outside = Math.max(
      leg.halfLeft - leg.travelwayHalfLeft,
      next.halfRight - next.travelwayHalfRight,
      0,
    );
    return filletBetween(origin, leg, next, radii[i]! + outside, false);
  });

  /** The kerb-to-kerb edge of the intersection on each leg. */
  const edgeProjection = legs.map((_, i) =>
    Math.max(plainFillets[(i - 1 + count) % count]!.toProjection, plainFillets[i]!.fromProjection),
  );

  // ---- crossings, placed from the intersection edge outward.
  const crosswalks = legs.map((_, i) => {
    const spec = options.legs?.[i]?.crosswalk;
    if (!spec) return null;
    const near = edgeProjection[i]! + Math.max(0, spec.setbackMeters);
    return { spec, near, far: near + Math.max(0.5, spec.widthMeters) };
  });

  // ---- curb extensions, clamped so one can never close the street.
  const bulbs = legs.map((_, i) => {
    if (treatments[i] !== 'bulbOut') return 0;
    const requested = options.corners?.[i]?.bulbOutMeters ?? DEFAULT_BULB_OUT_METRES;
    const a = legs[i]!;
    const b = legs[(i + 1) % count]!;
    const room = Math.min(
      a.travelwayHalfLeft - MIN_REMAINING_HALF_METRES,
      b.travelwayHalfRight - MIN_REMAINING_HALF_METRES,
    );
    const applied = Math.max(0, Math.min(requested, room));
    if (applied < requested - 1e-6) {
      warnings.push(
        `Corner ${i + 1}: the curb extension was cut to ${applied.toFixed(1)} m — any more would leave under ${MIN_REMAINING_HALF_METRES * 2} m of roadway.`,
      );
    }
    return applied;
  });

  const shapes = legs.map<LegShape>((_, i) => {
    const leftInset = bulbs[i]!;
    const rightInset = bulbs[(i - 1 + count) % count]!;
    if (leftInset < EPS && rightInset < EPS) return NO_BULB;
    const crossing = crosswalks[i];
    // Hold the extension past the crossing, then taper. A curb extension that stopped
    // short of the crosswalk would not actually shorten the walk.
    const bulbEndMeters = (crossing ? crossing.far : edgeProjection[i]!) + 0.5;
    const taperMeters = Math.max(1, Math.max(leftInset, rightInset) * 2);
    return { leftInset, rightInset, bulbEndMeters, taperMeters };
  });

  // ---- where each cross-section resumes. Derived by default, exactly like the anchor.
  const stopOffsets = legs.map((_, i) => {
    const shape = shapes[i]!;
    const crossing = crosswalks[i];
    const needed = Math.max(
      edgeProjection[i]!,
      crossing ? crossing.far : 0,
      shape.bulbEndMeters + shape.taperMeters,
      0.5,
    );
    const minimum = needed + STOP_MARGIN_METRES;
    const requested = options.legs?.[i]?.stopOffsetMeters;
    return requested === null || requested === undefined ? minimum : Math.max(requested, minimum);
  });

  const footOffsets = legs.map((_, i) => {
    const minimum =
      Math.max(
        footFillets[(i - 1 + count) % count]!.toProjection,
        footFillets[i]!.fromProjection,
        stopOffsets[i]!,
        0.5,
      ) + STOP_MARGIN_METRES;
    return minimum;
  });

  // ---- corners again, this time against the extended kerbs.
  const bulbedFillets = legs.map((leg, i) =>
    filletBetween(origin, leg, legs[(i + 1) % count]!, radii[i]!, true, bulbs[i]!, bulbs[i]!),
  );

  const paved = close(buildRing(origin, legs, bulbedFillets, stopOffsets, shapes, true));
  const roadwayCut = close(
    buildRing(origin, legs, plainFillets, stopOffsets, legs.map(() => NO_BULB), true),
  );
  const footprint = close(
    buildRing(origin, legs, footFillets, footOffsets, legs.map(() => NO_BULB), false),
  );

  // ---- crossings, stop bars, and daylighting.
  const crossings: CrossingPart[] = [];
  const daylightZones: { legIndex: number; ring: LngLat[] }[] = [];

  legs.forEach((leg, i) => {
    const shape = shapes[i]!;
    const frame = frameFor(origin, leg, true, shape.leftInset, shape.rightInset);
    const full = frameFor(origin, leg, true);
    const toLngLat = (ring: PlanePoint[]) => ring.map((p) => plane.toLngLat(p));

    const crossing = crosswalks[i];
    if (crossing) {
      const { spec, near, far } = crossing;
      const span = frame.halfLeft + frame.halfRight;

      if (spec.style === 'raised') {
        crossings.push({
          legIndex: i,
          kind: 'table',
          ring: toLngLat(legBox(origin, frame, near, far, -frame.halfRight, frame.halfLeft)),
        });
      }

      if (spec.style === 'transverse' || spec.style === 'ladder') {
        for (const edge of [near, far - EDGE_LINE_METRES]) {
          crossings.push({
            legIndex: i,
            kind: 'edge',
            ring: toLngLat(
              legBox(
                origin,
                frame,
                edge,
                edge + EDGE_LINE_METRES,
                -frame.halfRight,
                frame.halfLeft,
              ),
            ),
          });
        }
      }

      if (spec.style !== 'transverse') {
        // Continental bars run WITH the traffic, spaced across the roadway. Centred on the
        // crossing so the pattern stays symmetric as a bulb-out narrows it.
        const pitch = STRIPE_WIDTH_METRES + STRIPE_GAP_METRES;
        const bars = Math.max(1, Math.floor((span - STRIPE_GAP_METRES) / pitch));
        const used = bars * pitch - STRIPE_GAP_METRES;
        let across = -frame.halfRight + (span - used) / 2;
        for (let bar = 0; bar < bars; bar++) {
          crossings.push({
            legIndex: i,
            kind: 'stripe',
            ring: toLngLat(
              legBox(origin, frame, near, far, across, across + STRIPE_WIDTH_METRES),
            ),
          });
          across += pitch;
        }
      }
    }

    if (options.legs?.[i]?.stopBar) {
      // Traffic approaching the junction travels toward the centre, so in right-hand
      // traffic it keeps to the leg's left half in this outward-facing frame.
      const base = (crossing ? crossing.far : edgeProjection[i]!) + STOP_BAR_GAP_METRES;
      crossings.push({
        legIndex: i,
        kind: 'stopBar',
        ring: toLngLat(legBox(origin, frame, base, base + STOP_BAR_METRES, 0, frame.halfLeft)),
      });
    }

    const daylight = Math.max(
      options.corners?.[(i - 1 + count) % count]?.daylightMeters ?? 0,
      options.corners?.[i]?.daylightMeters ?? 0,
    );
    if (daylight > 0) {
      const from = edgeProjection[i]!;
      daylightZones.push({
        legIndex: i,
        ring: toLngLat(
          legBox(origin, frame, from, from + daylight, -full.halfRight, full.halfLeft),
        ),
      });
    }
  });

  // ---- reporting.
  const legGeometry: LegGeometry[] = legs.map((leg, i) => {
    const shape = shapes[i]!;
    const frame = frameFor(origin, leg, true, shape.leftInset, shape.rightInset);
    const full = frameFor(origin, leg, true);
    const at = add(origin, scale(frame.d, stopOffsets[i]!));
    const overrunsLeg = footOffsets[i]! > leg.lengthMeters;

    if (overrunsLeg) {
      warnings.push(
        `A ${leg.lengthMeters.toFixed(0)} m leg cannot fit what this junction needs (${footOffsets[i]!.toFixed(0)} m). Tighten the corners or extend the street.`,
      );
    }

    return {
      streetId: leg.streetId,
      sense: leg.sense,
      stopOffsetMeters: stopOffsets[i]!,
      footStopOffsetMeters: footOffsets[i]!,
      stopLine: [
        plane.toLngLat(add(at, scale(frame.n, -full.halfRight))),
        plane.toLngLat(add(at, scale(frame.n, full.halfLeft))),
      ],
      crossingDistanceMeters: frame.halfLeft + frame.halfRight,
      crossingDistanceWithoutBulbsMeters: full.halfLeft + full.halfRight,
      hasCrosswalk: crosswalks[i] !== null,
      overrunsLeg,
    };
  });

  const corners: CornerGeometry[] = bulbedFillets.map((fillet, i) => {
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
      treatment: treatments[i]!,
      appliedBulbOutMeters: bulbs[i]!,
      daylightMeters: options.corners?.[i]?.daylightMeters ?? 0,
    };
  });

  return {
    key: junction.key,
    centre: junction.position,
    paved: paved.map((p) => plane.toLngLat(p)),
    roadwayCut: roadwayCut.map((p) => plane.toLngLat(p)),
    footprint: footprint.map((p) => plane.toLngLat(p)),
    crossings,
    daylightZones,
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

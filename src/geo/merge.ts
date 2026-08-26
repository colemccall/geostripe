import * as polyclip from 'polyclip-ts';
import type { LngLat, LocalPlane, PlanePoint } from './projection';
import type { Junction, JunctionLeg } from './junctions';
import type { CornerGeometry, CrossingPart, JunctionGeometry, LegGeometry } from './intersection';
import { GLYPHS } from './glyphs';
import { stampGlyph } from './markings';

/**
 * Merges: where one road joins another instead of crossing it.
 *
 * A slip road meeting an arterial at twenty degrees is not an intersection, and treating it
 * as one is where the previous model fell apart. The corner-return machinery would try to
 * inscribe a fillet in a twenty-degree wedge, need a tangent two and a half times the
 * radius to do it, clamp itself to nothing, and leave a lozenge of asphalt bulging out of
 * the side of the mainline with a crosswalk stranded across it.
 *
 * What actually happens on the ground is simpler. The mainline is not interrupted at all.
 * The ramp's two kerbs run until each one reaches the mainline's kerb, and the ground
 * between them — a long thin wedge — is the taper. There is no junction box, no stop line
 * across the mainline, and no corner: there is a *nose*, the acute point where the two
 * kerbs finally meet, and a triangle of paint in front of it.
 *
 * So a merge is built as one wedge rather than as a ring walked leg by leg:
 *
 *   - find where each of the ramp's kerbs crosses the mainline's kerb
 *   - cut the ramp back to just beyond the further of the two crossings
 *   - fill everything between with pavement
 *   - leave the mainline entirely alone
 *
 * Everything is planar metres in the caller's plane, exactly as the intersection code is.
 */

/** Beyond the last kerb crossing before the ramp's own cross-section resumes. */
const MERGE_MARGIN_METRES = 1.5;

/** Width of the physical nose where the two kerbs meet — the gore paint ends here. */
const NOSE_WIDTH_METRES = 1.2;

/** Below this the ramp and the mainline are the same road, not two meeting. */
const MIN_MERGE_DEGREES = 0.5;

/**
 * A merge sharper than this is a junction wearing a merge's clothes.
 *
 * Reported rather than refused: plenty of real slip roads come in at thirty degrees and
 * behave like a junction, and which one it is depends on whether traffic yields or merges —
 * something the geometry cannot see.
 */
export const SHARP_MERGE_DEGREES = 25;

const add = (p: PlanePoint, q: PlanePoint): PlanePoint => ({ x: p.x + q.x, y: p.y + q.y });
const scale = (p: PlanePoint, k: number): PlanePoint => ({ x: p.x * k, y: p.y * k });
const unit = (bearing: number): PlanePoint => ({ x: Math.cos(bearing), y: Math.sin(bearing) });
const leftOf = (d: PlanePoint): PlanePoint => ({ x: -d.y, y: d.x });
const cross = (a: PlanePoint, b: PlanePoint): number => a.x * b.y - a.y * b.x;

/** Smallest angle between two bearings, in radians, always in [0, pi]. */
export function angleBetween(a: number, b: number): number {
  const delta = Math.abs(((a - b) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return delta > Math.PI ? Math.PI * 2 - delta : delta;
}

/** Where the ray `p + t*d` meets the infinite line through `q` with direction `e`. */
function rayHitsLine(
  p: PlanePoint,
  d: PlanePoint,
  q: PlanePoint,
  e: PlanePoint,
): { t: number; point: PlanePoint } | null {
  const denom = cross(d, e);
  if (Math.abs(denom) < 1e-9) return null;
  const t = cross({ x: q.x - p.x, y: q.y - p.y }, e) / denom;
  return { t, point: add(p, scale(d, t)) };
}

export type JunctionForm = 'intersection' | 'merge' | 'continuation';

/** How a junction breaks down into the street that ends and the street that continues. */
export interface MergeParts {
  stemIndex: number;
  throughIndices: [number, number];
  /** Angle between the ramp and the road it joins, in degrees. */
  angleDegrees: number;
}

/**
 * Can this junction be read as a merge, and at what angle?
 *
 * Requires exactly two streets, one contributing a single leg and the other passing
 * through. Anything else — a crossroads, three streets at a point, a street that ends on
 * another street's end — is not a merge, whatever the angles are.
 */
export function mergeParts(junction: Junction): MergeParts | null {
  const legs = junction.legs;
  if (legs.length !== 3) return null;

  const byStreet = new Map<string, number[]>();
  legs.forEach((leg, index) => {
    const list = byStreet.get(leg.streetId);
    if (list) list.push(index);
    else byStreet.set(leg.streetId, [index]);
  });
  if (byStreet.size !== 2) return null;

  const entries = [...byStreet.values()];
  const stem = entries.find((list) => list.length === 1);
  const through = entries.find((list) => list.length === 2);
  if (!stem || !through) return null;

  const stemIndex = stem[0]!;
  const stemBearing = legs[stemIndex]!.bearing;
  // The deviation from whichever mainline arm the ramp lies closest to. A ramp joining
  // from behind is shallow against the arm pointing back the way it came.
  const angle = Math.min(
    ...through.map((index) => angleBetween(stemBearing, legs[index]!.bearing)),
  );

  return {
    stemIndex,
    throughIndices: [through[0]!, through[1]!],
    angleDegrees: (angle * 180) / Math.PI,
  };
}

/**
 * Which form this junction takes, before any user override.
 *
 * Auto-classified rather than asked about, because a twenty-degree crossroads is never
 * what anyone drew and making them say so every time would be a tax on the common case.
 * The override exists for the genuinely ambiguous band around thirty degrees.
 */
export function classifyJunction(junction: Junction, mergeBelowDegrees = 40): JunctionForm {
  if (junction.legs.length < 3) return 'continuation';
  const parts = mergeParts(junction);
  if (!parts) return 'intersection';
  if (parts.angleDegrees < MIN_MERGE_DEGREES) return 'intersection';
  return parts.angleDegrees < mergeBelowDegrees ? 'merge' : 'intersection';
}

// --------------------------------------------------------------------------- geometry

/**
 * How the wedge is actually built, and why it is a boolean rather than a walk.
 *
 * The first version walked the ramp's two kerbs outward until each met the mainline's kerb,
 * and stitched the four points into a quadrilateral. That works only while the ramp is
 * narrower than the road it joins. A slip road with shoulders is often wider, and then one
 * of its kerbs starts *already outside* the mainline: the ray never crosses going outward,
 * the walk has no fourth point, and the whole merge silently falls back to being a junction
 * — which is exactly the wrong answer, drawn confidently.
 *
 * So the wedge is stated as what it is: the ramp's corridor, minus the road it joins.
 * That has no special cases. It produces the acute nose for free, it is correct whichever
 * road is wider, and it stays correct when the mainline curves through the merge.
 */

interface Strip {
  ring: Ring;
  /** The two kerb lines, for working out how far along the ramp the overlap reaches. */
  edges: { origin: PlanePoint; direction: PlanePoint }[];
}

type Ring = [number, number][];

const ring = (points: readonly PlanePoint[]): Ring => {
  const out: Ring = points.map((p) => [p.x, p.y]);
  const first = out[0]!;
  const last = out[out.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
};

/** How far a strip is extended along each arm. Long enough to swallow any ramp corridor. */
function reachOf(leg: JunctionLeg): number {
  return Math.max(20, Math.min(leg.lengthMeters, 400));
}

/**
 * The road being joined, as one long quadrilateral between its kerbs.
 *
 * Built from both arms rather than one, so a mainline that bends through the merge is
 * subtracted where it actually is rather than where a straight extrapolation would put it.
 */
function throughStrip(
  origin: PlanePoint,
  legs: readonly JunctionLeg[],
  through: readonly [number, number],
): Strip {
  const corners: PlanePoint[] = [];
  const edges: Strip['edges'] = [];

  for (const index of through) {
    const leg = legs[index]!;
    const d = unit(leg.bearing);
    const n = leftOf(d);
    const far = add(origin, scale(d, reachOf(leg)));
    const left = add(far, scale(n, leg.travelwayHalfLeft));
    const right = add(far, scale(n, -leg.travelwayHalfRight));
    // Both arms are walked left-then-right, and it is worth seeing why that is not a bug.
    // The arms point opposite ways, so one arm's left IS the other's right: walking each
    // as left-then-right traces the far end of one side, across, and back along the other.
    // Reversing the second arm to "compensate" ties the ring into a bow, and the boolean
    // then returns two triangles instead of a road.
    corners.push(left, right);
    edges.push(
      { origin: add(origin, scale(n, leg.travelwayHalfLeft)), direction: d },
      { origin: add(origin, scale(n, -leg.travelwayHalfRight)), direction: d },
    );
  }

  return { ring: ring(corners), edges };
}

/**
 * How far out along the ramp its corridor is still tangled with the road it joins.
 *
 * The last point at which either kerb crosses either of the mainline's kerb lines. A kerb
 * that never crosses going outward started outside and contributes nothing, which is the
 * case the ray walk could not express.
 */
function overlapReach(
  origin: PlanePoint,
  stem: JunctionLeg,
  strip: Strip,
  halfLeft: number,
  halfRight: number,
): number {
  const d = unit(stem.bearing);
  const n = leftOf(d);
  let reach = 0;
  for (const from of [add(origin, scale(n, halfLeft)), add(origin, scale(n, -halfRight))]) {
    for (const edge of strip.edges) {
      const hit = rayHitsLine(from, d, edge.origin, edge.direction);
      if (hit && hit.t > reach) reach = hit.t;
    }
  }
  return reach;
}

/** The ramp's own corridor, from behind the junction out to where its bands resume. */
function stemBox(
  origin: PlanePoint,
  stem: JunctionLeg,
  halfLeft: number,
  halfRight: number,
  back: number,
  forward: number,
): Ring {
  const d = unit(stem.bearing);
  const n = leftOf(d);
  const at = (along: number, across: number) =>
    add(add(origin, scale(d, along)), scale(n, across));
  return ring([
    at(-back, halfLeft),
    at(forward, halfLeft),
    at(forward, -halfRight),
    at(-back, -halfRight),
  ]);
}

/** Largest piece of a boolean result, as a single ring. Merges never want the crumbs. */
function largestRing(result: readonly Ring[][]): Ring | null {
  let best: Ring | null = null;
  let bestArea = 0;
  for (const polygon of result) {
    const outer = polygon[0];
    if (!outer) continue;
    let sum = 0;
    for (let i = 0; i < outer.length - 1; i++) {
      sum += outer[i]![0] * outer[i + 1]![1] - outer[i + 1]![0] * outer[i]![1];
    }
    const area = Math.abs(sum / 2);
    if (area > bestArea) {
      bestArea = area;
      best = outer;
    }
  }
  return best;
}

/** The sharpest vertex of a ring — the nose, where the two kerbs finally meet. */
function sharpestVertex(
  points: Ring,
): { point: PlanePoint; angleRad: number; into: PlanePoint; along: PlanePoint } | null {
  const n = points.length - 1;
  if (n < 3) return null;

  let best: { point: PlanePoint; angleRad: number; into: PlanePoint; along: PlanePoint } | null =
    null;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]!;
    const here = points[i]!;
    const next = points[(i + 1) % n]!;
    const a = { x: prev[0] - here[0], y: prev[1] - here[1] };
    const b = { x: next[0] - here[0], y: next[1] - here[1] };
    const la = Math.hypot(a.x, a.y);
    const lb = Math.hypot(b.x, b.y);
    // Ignore hairline edges: a near-duplicate vertex has a meaningless angle and would
    // win every time.
    if (la < 0.3 || lb < 0.3) continue;
    const cosine = (a.x * b.x + a.y * b.y) / (la * lb);
    const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
    if (!best || angle < best.angleRad) {
      best = {
        point: { x: here[0], y: here[1] },
        angleRad: angle,
        into: { x: a.x / la, y: a.y / la },
        along: { x: b.x / lb, y: b.y / lb },
      };
    }
  }
  return best;
}

/** The painted triangle in front of the nose, ending where the nose is a hand wide. */
function goreRing(nose: NonNullable<ReturnType<typeof sharpestVertex>>): PlanePoint[] | null {
  const half = Math.sin(nose.angleRad / 2);
  if (half < 1e-6) return null;
  const reach = Math.min(40, NOSE_WIDTH_METRES / 2 / half);
  return [
    { ...nose.point },
    add(nose.point, scale(nose.into, reach)),
    add(nose.point, scale(nose.along, reach)),
    { ...nose.point },
  ];
}

export interface MergeOptions {
  /** A yield line across the ramp where its own cross-section stops. */
  yieldLine?: boolean;
  /** Paint the gore triangle. On by default: it is what makes a nose read as a nose. */
  gore?: boolean;
}

/**
 * Build the geometry for a junction being treated as a merge.
 *
 * Returns null when the parts do not make one — the caller falls back to an intersection,
 * which is the right answer for anything this cannot describe.
 */
export function mergeGeometry(
  junction: Junction,
  plane: LocalPlane,
  options: MergeOptions = {},
): JunctionGeometry | null {
  const parts = mergeParts(junction);
  if (!parts) return null;

  const legs = junction.legs;
  const stem = legs[parts.stemIndex]!;
  const origin = plane.toPlane(junction.position);
  const warnings: string[] = [];

  const strip = throughStrip(origin, legs, parts.throughIndices);

  // How far back behind the junction the ramp's corridor has to start to be sure it
  // reaches right through the road it joins, whichever side it approaches from.
  const back =
    Math.max(
      ...parts.throughIndices.map((index) =>
        Math.max(legs[index]!.travelwayHalfLeft, legs[index]!.travelwayHalfRight),
      ),
    ) + 5;

  const pavedReach = overlapReach(
    origin, stem, strip, stem.travelwayHalfLeft, stem.travelwayHalfRight,
  );
  const footReach = overlapReach(origin, stem, strip, stem.halfLeft, stem.halfRight);

  const stop = pavedReach + MERGE_MARGIN_METRES;
  const footStop = Math.max(stop, footReach + MERGE_MARGIN_METRES * 2);

  const cut = (box: Ring): Ring | null => {
    try {
      return largestRing(polyclip.difference([box] as never, [strip.ring] as never) as unknown as Ring[][]);
    } catch {
      // A degenerate strip should cost this one merge, not the whole design.
      return null;
    }
  };

  const pavedRing = cut(
    stemBox(origin, stem, stem.travelwayHalfLeft, stem.travelwayHalfRight, back, stop),
  );
  const footRing = cut(stemBox(origin, stem, stem.halfLeft, stem.halfRight, back, footStop));
  if (!pavedRing) return null;

  if (parts.angleDegrees > SHARP_MERGE_DEGREES) {
    warnings.push(
      `This joins at ${parts.angleDegrees.toFixed(0)}\u00b0, which is sharp for a merge — traffic has to slow right down to make it. Below about ${SHARP_MERGE_DEGREES}\u00b0 it reads as a merge; above, it behaves like a junction and can be drawn as one.`,
    );
  }
  if (stop > stem.lengthMeters) {
    warnings.push(
      `The taper needs ${stop.toFixed(0)} m but the road joining is only ${stem.lengthMeters.toFixed(0)} m long. Extend it, or bring it in at a steeper angle.`,
    );
  }

  const toLngLat = (points: readonly PlanePoint[]): LngLat[] => points.map((p) => plane.toLngLat(p));
  const ringToLngLat = (points: Ring): LngLat[] =>
    points.map((p) => plane.toLngLat({ x: p[0]!, y: p[1]! }));

  const crossings: CrossingPart[] = [];

  const nose = sharpestVertex(pavedRing);
  if (options.gore !== false && nose && nose.angleRad < Math.PI / 3) {
    const gore = goreRing(nose);
    if (gore) crossings.push({ legIndex: parts.stemIndex, kind: 'stripe', ring: toLngLat(gore) });
  }

  if (options.yieldLine) {
    // Shark's teeth across the ramp, facing the traffic that has to give way.
    const d = unit(stem.bearing);
    const width = stem.travelwayHalfLeft + stem.travelwayHalfRight;
    const at = add(origin, scale(d, stop + 1.0));
    for (const polygon of stampGlyph(
      GLYPHS.sharkTeeth.build(width), at, { x: -d.x, y: -d.y }, plane,
    )) {
      const outer = polygon[0];
      if (outer) crossings.push({ legIndex: parts.stemIndex, kind: 'stripe', ring: outer });
    }
  }

  const legGeometry: LegGeometry[] = legs.map((leg, index) => {
    const isStem = index === parts.stemIndex;
    const d = unit(leg.bearing);
    const n = leftOf(d);
    const along = isStem ? stop : 0;
    const at = add(origin, scale(d, along));
    const halfLeft = leg.travelwayHalfLeft;
    const halfRight = leg.travelwayHalfRight;
    return {
      streetId: leg.streetId,
      sense: leg.sense,
      // The road being joined is not cut at all, which is the entire point of a merge.
      stopOffsetMeters: along,
      footStopOffsetMeters: isStem ? footStop : 0,
      stopLine: [
        plane.toLngLat(add(at, scale(n, -halfRight))),
        plane.toLngLat(add(at, scale(n, halfLeft))),
      ],
      crossingDistanceMeters: halfLeft + halfRight,
      crossingDistanceWithoutBulbsMeters: halfLeft + halfRight,
      hasCrosswalk: false,
      overrunsLeg: isStem && stop > leg.lengthMeters,
    };
  });

  // Corners are reported so the inspector's wheel still draws, but a merge has none: the
  // one place two kerbs meet is the nose, and that is a gore rather than a kerb return.
  const corners: CornerGeometry[] = legs.map((leg, index) => {
    const next = legs[(index + 1) % legs.length]!;
    const sweep = (next.bearing - leg.bearing + Math.PI * 2) % (Math.PI * 2);
    return {
      index,
      radiusMeters: 0,
      appliedRadiusMeters: 0,
      angleDegrees: (sweep * 180) / Math.PI,
      centre: null,
      clamped: false,
      treatment: 'plain',
      appliedBulbOutMeters: 0,
      daylightMeters: 0,
    };
  });

  return {
    key: junction.key,
    centre: junction.position,
    paved: ringToLngLat(pavedRing),
    // Nothing is bulbed, so what the ramp's roadway is cut against is the fill itself.
    roadwayCut: ringToLngLat(pavedRing),
    // Cut against the road's TRAVELWAY rather than its footprint, so the footway it
    // interrupts really is interrupted — a ramp crossing a pavement does cross it.
    footprint: ringToLngLat(footRing ?? pavedRing),
    crossings,
    daylightZones: [],
    legs: legGeometry,
    corners,
    warnings,
  };
}

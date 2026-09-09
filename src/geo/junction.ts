import { dedupe } from './projection';
import type { LngLat, LocalPlane } from './projection';


/**
 * The ground a junction owns.
 *
 * This module is the whole of the junction geometry, and it is deliberately about a
 * hundred lines, because the previous answer was about three thousand and most of it was
 * spent undoing a decision made further up.
 *
 * That version built roads as long ribbons, worked out where the ribbons overlapped,
 * guessed at the shape of the junction from the outside, and then subtracted that shape
 * out of every ribbon it touched with polygon booleans. It had to classify what kind of
 * place it was looking at first — crossroads, merge, staggered pair, fork — because the
 * shape to subtract depended on the answer, and a fork subtracted as a crossroads comes
 * out as a hole.
 *
 * Nothing here subtracts anything, and nothing here classifies anything.
 *
 * The roads run all the way into the node and overlap each other in the middle, which
 * looks wrong. Then the junction's paved ground is drawn ON TOP of them, which covers the
 * overlap. That is the entire mechanism. The stacking order does the work the boolean used
 * to do, so a fork is drawn as a fork for the same reason a crossroads is drawn as a
 * crossroads: nobody asked which one it was.
 *
 * Two plates come out rather than one, and their order matters:
 *
 *   the FOOTPRINT, as wide as the widest thing arriving, in footway colour;
 *   the PAVED area, as wide as the carriageways only, in asphalt, drawn over it.
 *
 * What shows between them, at the corners, is the footway turning the corner — which the
 * old model computed as a per-corner polygon and this one gets for nothing.
 */

/**
 * A vector in the junction's own frame: metres, relative to the node.
 *
 * A tuple rather than the plane's `{x, y}` because the hull and the fillet do arithmetic
 * on thousands of these and read better indexed, and because every one of them is local to
 * this module — nothing crosses the boundary in this form.
 */
type Vec = [number, number];

/** A junction needs at least two roads. One road arriving at a node is just its end. */
const MIN_ENDS = 2;

/**
 * How far apart two roads must point before the place they meet is a junction.
 *
 * The number that separates a crossing from a merge, and the reason a freeway interchange
 * does not come out covered in grey pills. A ramp joins a mainline at fifteen or twenty
 * degrees: nothing crosses anything, the two carriageways simply run together for a while
 * and the ground between them is a gore rather than a junction. Build a plate there and you
 * get a lozenge stamped across the freeway, covering the lane markings, at every ramp.
 *
 * Measured on axes rather than headings — a road arriving and the same road leaving are the
 * same line — so a mainline contributes one direction to this test, not two opposed ones.
 *
 * Forty degrees is the figure the old model's merge classifier used, and keeping it means
 * the two readings of "these roads are running together" agree.
 */
const CORRIDOR_DEGREES = 40;

/**
 * Whether everything here is heading much the same way.
 *
 * The arrivals' axes are angles modulo 180 degrees, so the question is whether they all fit
 * inside a CORRIDOR_DEGREES arc of a half circle. Found by sorting and taking the largest
 * gap: what is left over is the smallest arc that contains them all.
 */
function isCorridor(arrivals: readonly Arrival[]): boolean {
  const HALF = Math.PI;
  const axes = arrivals
    .map((a) => {
      const angle = Math.atan2(a.direction[1], a.direction[0]) % HALF;
      return angle < 0 ? angle + HALF : angle;
    })
    .sort((a, b) => a - b);

  if (axes.length < 2) return true;

  let widestGap = axes[0]! + HALF - axes[axes.length - 1]!;
  for (let i = 1; i < axes.length; i++) {
    widestGap = Math.max(widestGap, axes[i]! - axes[i - 1]!);
  }

  const spread = HALF - widestGap;
  return spread < (CORRIDOR_DEGREES * Math.PI) / 180;
}

/** Below this the plate is not worth drawing and the hull is numerically unhappy. */
const EPS = 1e-6;

/**
 * One road arriving at one node, in the frame that matters: looking OUTWARD from the node.
 *
 * `halfLeft` is always the kerb on the outward left, so a road arriving at its `to` node
 * has the section's left and right already swapped. Getting this wrong is invisible on a
 * symmetric street and obvious on any street with parking down one side, which is why it
 * is resolved once, here, rather than at each use.
 */
export interface Arrival {
  segmentId: string;
  /** Unit vector pointing away from the node, in plane metres. */
  direction: Vec;
  halfLeft: number;
  halfRight: number;
  /** Carriageway half-widths in the same outward frame. Zero for a path. */
  pavedLeft: number;
  pavedRight: number;
  level: number;
}

export interface JunctionPlates {
  nodeId: string;
  level: number;
  /** Full width, in footway colour. Drawn first. */
  footprint: LngLat[];
  /** Carriageway only, in asphalt. Drawn over the footprint. */
  paved: LngLat[] | null;
}

/**
 * How far a corner may sit from the node, as a multiple of the road's half-width.
 *
 * Two kerbs meeting at angle d have their corner at (width / sin d) from the node: one
 * width away at ninety degrees, two at thirty, three at twenty — and then it runs away.
 * At five degrees the corner is a hundred metres down the road, which is not a corner, it
 * is a gore, and the roads either side of it are merging rather than crossing.
 *
 * So it is capped. A pair that wants more than this is not cornered at all, and the plate
 * simply stops — which is what keeps a ramp coming off a freeway from being boxed.
 */
const MAX_CORNER_REACH = 3;

/** Left of a heading, in a plane with x east and y north. */
const leftNormal = (d: Vec): Vec => [-d[1], d[0]];

/** Where two infinite lines meet, or null when they are parallel. */
function meet(p: Vec, dp: Vec, q: Vec, dq: Vec): Vec | null {
  const denom = dp[0] * dq[1] - dp[1] * dq[0];
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((q[0] - p[0]) * dq[1] - (q[1] - p[1]) * dq[0]) / denom;
  return [p[0] + t * dp[0], p[1] + t * dp[1]];
}

/**
 * The outline of the junction: the points where each pair of neighbouring kerbs meet.
 *
 * This is the corner-return construction, and it is what makes a crossroads look like a
 * crossroads. The obvious alternative — take the convex hull of the roads' rectangles — is
 * simpler and wrong in a way that is immediately visible: the convex hull of a cross is a
 * square, so the plate bulges out past both roads into the four quadrants where there is no
 * pavement at all, and a junction between a wide road and a narrow one reads as a
 * roundabout.
 *
 * Sorting by bearing is what makes "neighbouring" mean anything. Between one road and the
 * next one anticlockwise there is exactly one corner, and it is where that road's LEFT kerb
 * crosses the next road's RIGHT kerb.
 */
function cornerRing(
  arrivals: readonly Arrival[],
  half: (a: Arrival) => { left: number; right: number },
): Vec[] {
  const sorted = [...arrivals].sort(
    (a, b) => Math.atan2(a.direction[1], a.direction[0]) - Math.atan2(b.direction[1], b.direction[0]),
  );

  const out: Vec[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const here = sorted[i]!;
    const next = sorted[(i + 1) % sorted.length]!;
    const hereHalf = half(here);
    const nextHalf = half(next);

    const hn = leftNormal(here.direction);
    const nn = leftNormal(next.direction);

    // This road's left kerb, and the next road's right kerb: the two edges facing the gap.
    const hereKerb: Vec = [hn[0] * hereHalf.left, hn[1] * hereHalf.left];
    const nextKerb: Vec = [-nn[0] * nextHalf.right, -nn[1] * nextHalf.right];

    const corner = meet(hereKerb, here.direction, nextKerb, next.direction);
    const cap =
      MAX_CORNER_REACH *
      Math.max(MIN_CORNER_WIDTH, hereHalf.left, hereHalf.right, nextHalf.left, nextHalf.right);

    if (corner && Math.hypot(corner[0], corner[1]) <= cap) {
      out.push(corner);
      continue;
    }

    // Too shallow to have a corner. Square both roads off at the cap instead, which leaves
    // the gore between them open rather than inventing pavement across it.
    out.push(
      [hereKerb[0] + here.direction[0] * cap, hereKerb[1] + here.direction[1] * cap],
      [nextKerb[0] + next.direction[0] * cap, nextKerb[1] + next.direction[1] * cap],
    );
  }

  return out;
}

/** Floor on the width used for the corner cap, so hairline paths still get a usable one. */
const MIN_CORNER_WIDTH = 1.5;

/**
 * Convex hull, Andrew's monotone chain.
 *
 * Convex is the right answer and not merely the cheap one. A junction is where several
 * roads can all see each other; the concave alternative would be the exact union of the
 * rectangles, which has notches in it at every pair of legs — and a notch in a junction is
 * a piece of missing asphalt that no real intersection has.
 */
export function convexHull(points: readonly Vec[]): Vec[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const cross = (o: Vec, a: Vec, b: Vec): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const half = (input: readonly Vec[]): Vec[] => {
    const out: Vec[] = [];
    for (const p of input) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) {
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };

  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * How much of an edge a single corner may consume.
 *
 * A third, not a half. At a half, two corners sharing a short edge eat all of it and the
 * edge disappears into one continuous curve — which is how a ramp crossing a freeway came
 * out as a grey capsule laid across the carriageway rather than as a junction. A third
 * always leaves some straight kerb between the returns, so the shape still reads as the
 * roads that made it.
 */
const MAX_CORNER_BITE = 1 / 3;

/**
 * Round the corners of a ring, which is what a kerb return is.
 *
 * A quadratic through each corner, cut back along both edges by the radius or by a share of
 * the shorter edge, whichever is less. The clamp is why this never needs the warning the
 * old curb-return code needed: a corner between two short edges simply gets a smaller
 * radius instead of producing a shape that crosses itself.
 */
export function roundRing(ring: readonly Vec[], radius: number, steps = 4): Vec[] {
  if (ring.length < 3 || radius <= EPS) return [...ring];
  const out: Vec[] = [];

  for (let i = 0; i < ring.length; i++) {
    const prev = ring[(i - 1 + ring.length) % ring.length]!;
    const here = ring[i]!;
    const next = ring[(i + 1) % ring.length]!;

    const toPrev = Math.hypot(prev[0] - here[0], prev[1] - here[1]);
    const toNext = Math.hypot(next[0] - here[0], next[1] - here[1]);
    if (toPrev < EPS || toNext < EPS) {
      out.push(here);
      continue;
    }

    const cut = Math.min(radius, toPrev * MAX_CORNER_BITE, toNext * MAX_CORNER_BITE);
    const a: Vec = [
      here[0] + ((prev[0] - here[0]) / toPrev) * cut,
      here[1] + ((prev[1] - here[1]) / toPrev) * cut,
    ];
    const b: Vec = [
      here[0] + ((next[0] - here[0]) / toNext) * cut,
      here[1] + ((next[1] - here[1]) / toNext) * cut,
    ];

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      out.push([
        u * u * a[0] + 2 * u * t * here[0] + t * t * b[0],
        u * u * a[1] + 2 * u * t * here[1] + t * t * b[1],
      ]);
    }
  }

  return out;
}

/**
 * Build the plates for one node.
 *
 * `origin` is the node's own position; every arrival is expressed relative to it, so the
 * hull is computed in a frame centred on the junction and the numbers stay small.
 */
export function junctionPlates(
  nodeId: string,
  origin: LngLat,
  arrivals: readonly Arrival[],
  radiusMeters: number,
  plane: LocalPlane,
): JunctionPlates | null {
  if (arrivals.length < MIN_ENDS) return null;

  // Roads at different levels do not meet, whatever the plan view says. This is what makes
  // an interchange buildable out of parts that already exist: raise the road that crosses
  // and the junction stops existing, the decks order themselves, and the flyover reads as a
  // flyover. Without it, an overpass carves a paved slab through the carriageway beneath it.
  if (arrivals.some((a) => a.level !== arrivals[0]!.level)) return null;

  // Nothing crosses anything here — a ramp meeting a mainline, or one road continuing into
  // the next. The roads overlap and run together, which is what a merge looks like, and a
  // plate would be a lozenge painted across both of them.
  if (isCorridor(arrivals)) return null;

  const base = plane.toPlane(origin);
  const toWorld = (points: readonly Vec[]): LngLat[] =>
    points.map((p) => plane.toLngLat({ x: base.x + p[0], y: base.y + p[1] }));

  const paved = arrivals.filter((a) => a.pavedLeft > EPS || a.pavedRight > EPS);

  const footprint = buildRing(
    arrivals,
    (a) => ({ left: a.halfLeft, right: a.halfRight }),
    radiusMeters,
  );
  if (!footprint) return null;

  // One carriageway arriving is a road meeting a footpath, not a paved junction: the
  // asphalt plate would be a rectangle sitting on top of the one road that made it.
  const pavedRing =
    paved.length >= MIN_ENDS
      ? buildRing(paved, (a) => ({ left: a.pavedLeft, right: a.pavedRight }), radiusMeters)
      : null;

  return {
    nodeId,
    level: arrivals.reduce((max, a) => Math.max(max, a.level), 0),
    footprint: dedupe(toWorld(footprint)),
    paved: pavedRing ? dedupe(toWorld(pavedRing)) : null,
  };
}

/**
 * One plate: the corner ring, rounded.
 *
 * Two roads meeting end to end produce only two corners, which is a line rather than a
 * shape. That is not a failure — it is a joint, not a junction — so the ring falls back to
 * the quad across both kerbs at the node, which is exactly the patch needed to cover the
 * seam where one asset becomes another.
 */
function buildRing(
  arrivals: readonly Arrival[],
  half: (a: Arrival) => { left: number; right: number },
  radiusMeters: number,
): Vec[] | null {
  const corners = cornerRing(arrivals, half);
  const ring = corners.length >= 3 ? corners : convexHull(kerbPoints(arrivals, half));
  if (ring.length < 3) return null;
  return roundRing(ring, radiusMeters);
}

/** The kerb points at the node itself, for the cases a corner ring cannot describe. */
function kerbPoints(
  arrivals: readonly Arrival[],
  half: (a: Arrival) => { left: number; right: number },
): Vec[] {
  const out: Vec[] = [];
  for (const arrival of arrivals) {
    const n = leftNormal(arrival.direction);
    const h = half(arrival);
    const d = arrival.direction;
    // A short way along the road as well as across it, so two opposed ends give a quad
    // with area rather than a flat line through the node.
    const reach = Math.max(MIN_CORNER_WIDTH, h.left, h.right) / 2;
    out.push(
      [n[0] * h.left + d[0] * reach, n[1] * h.left + d[1] * reach],
      [-n[0] * h.right + d[0] * reach, -n[1] * h.right + d[1] * reach],
    );
  }
  return out;
}

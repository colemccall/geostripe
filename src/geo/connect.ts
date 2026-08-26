import { localPlane, originFor } from './projection';
import type { LngLat, LocalPlane, PlanePoint } from './projection';
import { resolveCenterline } from './curve';
import { sectionExtent } from '../model/section';
import type { Street } from '../model/types';

/**
 * Making streets actually meet.
 *
 * Junctions are derived from where centerlines really cross, which is the right model —
 * but it puts the whole weight of the design on where a line happened to stop, and a line
 * drawn over imagery never stops exactly where it was aimed. Three things go wrong, and
 * all three read as "the intersections are a mess":
 *
 *   overshoot   The side street pokes a metre past the road it joins. The detector sees a
 *               fourth arm and builds a four-way crossing, with four corner fillets, out
 *               of what was plainly a T. This is the worst of the three, because a miss of
 *               one metre changes the *kind* of junction.
 *   undershoot  The side street stops short. A junction is still found — it is projected
 *               onto the through street — but the side street's pavement stops where the
 *               line stopped, leaving a strip of bare imagery between the two.
 *   near miss   Past the detector's tolerance, which is the section half-width, nothing is
 *               found at all. The streets simply overlap, silently.
 *
 * The fix is to move the endpoint, not to loosen the detector. Loosening it would invent
 * junctions out of near misses and, worse, would make the geometry stop describing the
 * design: the pavement would be drawn somewhere the centerline never went. Welding the
 * endpoint keeps the two in agreement — what is stored is what is drawn is what is
 * measured — and it is an ordinary edit, so it undoes.
 *
 * Everything here plans first and applies second. A plan can be shown before it is run,
 * counted in the UI, and drawn on the map as "these ends are loose"; and computing every
 * candidate against the original geometry stops two streets welding to each other's old
 * positions and swapping places.
 */

const EPS = 1e-9;

/** Closer than this and the end is already on the line. Nothing to do. */
const TOUCHING_METRES = 0.05;

/** Floor on how far an end may be moved, for streets too narrow to set their own. */
const MIN_WELD_METRES = 12;

/** Added to the target's half-width to get the weld reach. */
const WELD_MARGIN_METRES = 4;

/** How far past the target's kerb a tail may run and still count as slop rather than a leg. */
const TRIM_MARGIN_METRES = 3;

/**
 * How far off its own heading an end may be aiming and still count as aimed at something.
 *
 * Generous, because the test is only there to stop a dead end being welded to a street it
 * happens to sit near while pointing somewhere else entirely.
 */
const AIM_DEGREES = 75;

export type ConnectionKind = 'extend' | 'trim' | 'corner';

/** One end of one street that does not meet what it was drawn to meet. */
export interface Connection {
  streetId: string;
  /** Which end of the centerline: index 0, or the last index. */
  end: 'start' | 'end';
  /** The street this end belongs against. */
  targetId: string;
  kind: ConnectionKind;
  /** Where the end would move to. */
  point: LngLat;
  /** How far it would move, in metres — what makes one candidate better than another. */
  movedMeters: number;
  /** Human-readable, for the notice after the fact. */
  label: string;
  /**
   * Control points a trim strands outside the junction, to be removed with the move.
   *
   * A trim cuts the line back to where it crosses; any control point that was between the
   * cut and the old end is now past the end of the street. Left in place it would drag the
   * line back out through the junction it was just pulled out of.
   */
  strandedIndices?: number[];
}

export interface ConnectOptions {
  /**
   * Only consider these streets as things to move. Absent means all of them.
   *
   * This is the difference between "connect what I just drew" and "tidy up everything".
   * Targets are never restricted: a street being connected must be free to meet anything.
   */
  moveOnly?: ReadonlySet<string>;
  /** Override the reach, in metres. Absent derives it from the streets involved. */
  weldMeters?: number;
}

// ------------------------------------------------------------------------- geometry

interface Track {
  street: Street;
  /** Resolved centerline in the shared plane — where the pavement really goes. */
  pts: PlanePoint[];
  /** Control points in the shared plane — the things that get moved. */
  controls: PlanePoint[];
  halfWidth: number;
  level: number;
}

function buildTrack(street: Street, plane: LocalPlane): Track | null {
  const resolved = resolveCenterline(street);
  if (resolved.length < 2 || street.centerline.length < 2) return null;
  const extent = sectionExtent(street.section);
  return {
    street,
    pts: resolved.map((p) => plane.toPlane(p)),
    controls: street.centerline.map((p) => plane.toPlane(p)),
    halfWidth: Math.max(extent.left, extent.right),
    level: street.level ?? 0,
  };
}

function sub(a: PlanePoint, b: PlanePoint): PlanePoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function norm(p: PlanePoint): PlanePoint {
  const l = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / l, y: p.y / l };
}

function dist(a: PlanePoint, b: PlanePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Closest point on a segment, as a parameter in [0,1] and the distance to it. */
function closestOnSegment(
  p: PlanePoint,
  a: PlanePoint,
  b: PlanePoint,
): { t: number; distance: number; point: PlanePoint } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { t, distance: Math.hypot(p.x - point.x, p.y - point.y), point };
}

/** Nearest point anywhere on a polyline. */
function nearestOnLine(p: PlanePoint, line: readonly PlanePoint[]): { distance: number; point: PlanePoint } {
  let best = { distance: Infinity, point: line[0]! };
  for (let i = 0; i < line.length - 1; i++) {
    const near = closestOnSegment(p, line[i]!, line[i + 1]!);
    if (near.distance < best.distance) best = { distance: near.distance, point: near.point };
  }
  return best;
}

/**
 * First hit of a ray against a polyline, as a distance along the ray.
 *
 * The ray is what makes the aim test rigorous. An end that is near a street but heading
 * away from it produces no hit at all, so "was this drawn to meet that?" is answered by
 * the geometry rather than by a distance threshold that cannot tell the two apart.
 */
function rayHit(
  origin: PlanePoint,
  direction: PlanePoint,
  line: readonly PlanePoint[],
  maxDistance: number,
): { distance: number; point: PlanePoint } | null {
  let best: { distance: number; point: PlanePoint } | null = null;

  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const denom = direction.x * sy - direction.y * sx;
    if (Math.abs(denom) < EPS) continue;

    const qx = a.x - origin.x;
    const qy = a.y - origin.y;
    const t = (qx * sy - qy * sx) / denom;
    const u = (qx * direction.y - qy * direction.x) / denom;
    if (t < -EPS || t > maxDistance || u < -EPS || u > 1 + EPS) continue;

    if (!best || t < best.distance) {
      best = { distance: t, point: { x: origin.x + direction.x * t, y: origin.y + direction.y * t } };
    }
  }

  return best;
}

/** Angle between two unit-ish vectors, in degrees. */
function angleBetween(a: PlanePoint, b: PlanePoint): number {
  const ua = norm(a);
  const ub = norm(b);
  const cos = Math.max(-1, Math.min(1, ua.x * ub.x + ua.y * ub.y));
  return (Math.acos(cos) * 180) / Math.PI;
}

// ------------------------------------------------------------------------- planning

interface EndRef {
  track: Track;
  end: 'start' | 'end';
  index: number;
  /** The control point at this end. */
  point: PlanePoint;
  /** Unit vector pointing out of the street, away from its body. */
  outward: PlanePoint;
}

function endsOf(track: Track): EndRef[] {
  const c = track.controls;
  const last = c.length - 1;
  return [
    { track, end: 'start', index: 0, point: c[0]!, outward: norm(sub(c[0]!, c[1]!)) },
    { track, end: 'end', index: last, point: c[last]!, outward: norm(sub(c[last]!, c[last - 1]!)) },
  ];
}

/**
 * How far along the street, measured back from this end, the tail may be cut.
 *
 * The rule is not a fixed length but a question about the junction: does the tail escape
 * the intersection at all? A tail that dies inside the box it crosses was never a leg —
 * nobody draws a two-metre street — so cutting it loses nothing and turns a phantom
 * four-way back into the T that was meant.
 */
function trimBudget(target: Track): number {
  return target.halfWidth + TRIM_MARGIN_METRES;
}

function weldReach(target: Track, override?: number): number {
  if (override !== undefined) return override;
  return Math.max(target.halfWidth + WELD_MARGIN_METRES, MIN_WELD_METRES);
}

/**
 * Where an end sits relative to one candidate target, if anywhere useful.
 *
 * Overshoot is checked before undershoot: if the street already crosses the target, the
 * question is only how much to cut, and a ray fired outward from a point already past the
 * line would find something further away and extend in the wrong direction entirely.
 */
function candidateFor(
  ref: EndRef,
  target: Track,
  options: ConnectOptions,
  plane: LocalPlane,
): Connection | null {
  const { track, end } = ref;
  if (target.street.id === track.street.id) return null;
  // Streets at different levels do not meet. An overpass welded to the road beneath it
  // would be exactly the bug the level field exists to prevent.
  if (target.level !== track.level) return null;

  const reach = weldReach(target, options.weldMeters);
  const near = nearestOnLine(ref.point, target.pts);

  // Touching is handled by the caller, across every target at once. Reaching here means
  // this end meets nothing, so it is free to be moved.
  if (near.distance <= TOUCHING_METRES) return null;

  // ---- overshoot. Fire the ray INWARD: if the target is behind this end, the street has
  // already gone past it and the tail between the two is slop.
  const inward = { x: -ref.outward.x, y: -ref.outward.y };
  const back = rayHit(ref.point, inward, target.pts, trimBudget(target));
  if (back) {
    return {
      streetId: track.street.id,
      end,
      targetId: target.street.id,
      kind: 'trim',
      point: plane.toLngLat(back.point),
      movedMeters: back.distance,
      label: `trimmed ${back.distance.toFixed(1)} m of overshoot past ${target.street.name}`,
      strandedIndices: strandedBy(ref, back.distance),
    };
  }

  // ---- undershoot. The ray outward answers "was this heading there?" on its own.
  const forward = rayHit(ref.point, ref.outward, target.pts, reach);
  if (forward) {
    return {
      streetId: track.street.id,
      end,
      targetId: target.street.id,
      kind: 'extend',
      point: plane.toLngLat(forward.point),
      movedMeters: forward.distance,
      label: `extended ${forward.distance.toFixed(1)} m to meet ${target.street.name}`,
    };
  }

  // ---- corner. Two streets that end near each other form an L, and neither ray finds
  // the other because each stops before reaching a segment it could cross.
  let nearestCorner: { point: PlanePoint; gap: number } | null = null;
  for (const corner of [target.pts[0]!, target.pts[target.pts.length - 1]!]) {
    const gap = dist(ref.point, corner);
    if (gap > reach) continue;
    if (angleBetween(ref.outward, sub(corner, ref.point)) > AIM_DEGREES) continue;
    if (!nearestCorner || gap < nearestCorner.gap) nearestCorner = { point: corner, gap };
  }
  if (nearestCorner) {
    return {
      streetId: track.street.id,
      end,
      targetId: target.street.id,
      kind: 'corner',
      point: plane.toLngLat(nearestCorner.point),
      movedMeters: nearestCorner.gap,
      label: `closed a ${nearestCorner.gap.toFixed(1)} m gap to ${target.street.name}`,
    };
  }

  return null;
}

/**
 * Which control points a cut at `cutDistance` leaves outside the street.
 *
 * Measured along the end's own inward direction, so a control point still outside the cut
 * scores less than the cut does. Both ends of the line are exempt: the end control point
 * is the one being moved onto the cut, and the far end is the rest of the street.
 */
function strandedBy(ref: EndRef, cutDistance: number): number[] {
  const inward = { x: -ref.outward.x, y: -ref.outward.y };
  const stranded: number[] = [];

  for (let i = 0; i < ref.track.controls.length; i++) {
    if (i === ref.index) continue;
    if (i === 0 || i === ref.track.controls.length - 1) continue;
    const offset = sub(ref.track.controls[i]!, ref.point);
    const along = offset.x * inward.x + offset.y * inward.y;
    if (along >= -EPS && along < cutDistance - EPS) stranded.push(i);
  }

  return stranded;
}

/**
 * Every end that should move, and where to.
 *
 * Nothing is applied. The same plan drives the map markers, the button's enabled state and
 * the count in its label, so what the button says it will do is computed by the code that
 * does it.
 */
export function planConnections(
  streets: readonly Street[],
  options: ConnectOptions = {},
): Connection[] {
  const live = streets.filter((s) => s.visible && s.centerline.length >= 2);
  if (live.length < 2) return [];

  const plane = localPlane(originFor(live.flatMap((s) => s.centerline)));

  const tracks: Track[] = [];
  for (const street of live) {
    const track = buildTrack(street, plane);
    if (track) tracks.push(track);
  }

  const plan: Connection[] = [];

  for (const track of tracks) {
    if (options.moveOnly && !options.moveOnly.has(track.street.id)) continue;

    for (const ref of endsOf(track)) {
      // An end that already meets something is finished, whatever else is nearby. Asking
      // per-target instead would let an end sitting exactly on one street be dragged off
      // it to reach another a few metres further on — breaking a good junction to make a
      // worse one.
      const alreadyMeets = tracks.some(
        (target) =>
          target.street.id !== track.street.id &&
          target.level === track.level &&
          nearestOnLine(ref.point, target.pts).distance <= TOUCHING_METRES,
      );
      if (alreadyMeets) continue;

      let best: Connection | null = null;
      for (const target of tracks) {
        const candidate = candidateFor(ref, target, options, plane);
        if (!candidate) continue;
        // Nearest wins. When an end sits between two streets, the one it stopped closest
        // to is the one it was aiming at.
        if (!best || candidate.movedMeters < best.movedMeters) best = candidate;
      }
      if (best) plan.push(best);
    }
  }

  return dropMutualDuplicates(plan);
}

/**
 * Drop one half of every pair of ends welding to each other.
 *
 * Two dead ends facing across a gap each name the other, and applying both moves each to
 * where the other *was* — they swap and the gap survives. One move closes it, so the
 * lower street id keeps its position and the other comes to meet it. Arbitrary, but
 * stable, which is what matters: the same project connects the same way every time.
 */
function dropMutualDuplicates(plan: readonly Connection[]): Connection[] {
  const byEnd = new Map<string, Connection>();
  for (const c of plan) byEnd.set(`${c.streetId}:${c.end}`, c);

  const dropped = new Set<string>();
  for (const c of plan) {
    if (c.kind !== 'corner') continue;
    for (const other of plan) {
      if (other.kind !== 'corner') continue;
      if (other.streetId !== c.targetId || c.streetId !== other.targetId) continue;
      const mine = `${c.streetId}:${c.end}`;
      const theirs = `${other.streetId}:${other.end}`;
      if (dropped.has(mine) || dropped.has(theirs)) continue;
      dropped.add(c.streetId < other.streetId ? theirs : mine);
    }
  }

  return plan.filter((c) => !dropped.has(`${c.streetId}:${c.end}`));
}

// -------------------------------------------------------------------------- applying

/**
 * Move a street's end control point, dropping anything the trim made redundant.
 *
 * Trimming can strand control points beyond the cut. They are removed rather than left
 * where they are, because a control point past the end of the line would drag the curve
 * back out through the junction it was just pulled out of.
 */
function applyOne(street: Street, connections: readonly Connection[]): Street {
  const moved = street.centerline.map((p) => [...p] as [number, number]);
  const drop = new Set<number>();

  for (const c of connections) {
    if (c.end === 'end') moved[moved.length - 1] = [...c.point];
    else moved[0] = [...c.point];
    for (const index of c.strandedIndices ?? []) drop.add(index);
  }

  // Removals and index remapping happen in one pass, because both the stranded points and
  // any the move collapsed onto a neighbour shift every sharp-vertex index after them.
  // Rebuilding the flags from a kept-index map is the only version of this that stays
  // right when both kinds of removal happen on the same street.
  const centerline: [number, number][] = [];
  const keptFrom: number[] = [];

  for (let i = 0; i < moved.length; i++) {
    if (drop.has(i)) continue;
    const p = moved[i]!;
    const previous = centerline[centerline.length - 1];
    if (previous && Math.abs(previous[0] - p[0]) < 1e-12 && Math.abs(previous[1] - p[1]) < 1e-12) {
      // Keep the LAST of a coincident run, so an end welded onto its own neighbour keeps
      // the welded position rather than the stale one it landed on.
      centerline.pop();
      keptFrom.pop();
    }
    centerline.push(p);
    keptFrom.push(i);
  }

  // Never destroy the street. Two points is the least a centerline can be, and a weld that
  // would collapse one past that is better left undone than left invalid.
  if (centerline.length < 2) return street;

  let sharp = street.curve?.sharpVertices ? [...street.curve.sharpVertices] : null;
  if (sharp) {
    const remap = new Map(keptFrom.map((old, next) => [old, next]));
    sharp = sharp.map((i) => remap.get(i)).filter((i): i is number => i !== undefined);
  }

  const next: Street = { ...street, centerline };
  if (street.curve) {
    next.curve = sharp ? { ...street.curve, sharpVertices: sharp } : street.curve;
  }
  return next;
}

/** Run a plan. Returns a new street list; streets not in the plan are returned unchanged. */
export function applyConnections(
  streets: readonly Street[],
  plan: readonly Connection[],
): Street[] {
  if (plan.length === 0) return [...streets];

  const byStreet = new Map<string, Connection[]>();
  for (const c of plan) {
    const list = byStreet.get(c.streetId);
    if (list) list.push(c);
    else byStreet.set(c.streetId, [c]);
  }

  return streets.map((street) => {
    const mine = byStreet.get(street.id);
    return mine ? applyOne(street, mine) : street;
  });
}

/** Plan and apply in one step, for callers that do not need to show the plan first. */
export function connectStreets(
  streets: readonly Street[],
  options: ConnectOptions = {},
): { streets: Street[]; plan: Connection[] } {
  const plan = planConnections(streets, options);
  return { streets: applyConnections(streets, plan), plan };
}

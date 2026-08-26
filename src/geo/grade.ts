import { dedupe } from './projection';
import type { LngLat } from './projection';
import { distanceMeters } from './measure';

/**
 * Where a street leaves the ground, and where it comes back.
 *
 * `level` used to be one integer for a whole street: it was at grade, or it was an
 * overpass, for its entire length. That is enough to stop a freeway carving a hole through
 * the road beneath it, which is what it was added for — but it cannot express the thing
 * every real overpass does, which is climb, cross, and come back down. A street that is
 * elevated end to end has no ramps, and a design with no ramps is not a design.
 *
 * A profile is a handful of breakpoints along the centerline, and the level between them
 * is a straight line. So an overpass is four points — ground, up, up, ground — and the two
 * sloping stretches between them are the ramps. Nothing else needs to know that: everything
 * downstream asks `levelAt` for a station and gets a number.
 *
 * Deliberately *not* an elevation in metres. The question this tool answers is which of two
 * things crossing is on top, which is ordinal — and a real height would invite a gradient
 * check this tool has no business claiming to do. Fractional levels exist only because a
 * ramp has to be somewhere between its ends.
 */

export interface GradePoint {
  /** Distance along the resolved centerline, in metres. */
  stationMeters: number;
  /** 0 at grade, +1 an overpass, -1 a tunnel. */
  level: number;
}

/**
 * How far apart two levels must be before the things carrying them stop meeting.
 *
 * Half a level: a street on a ramp at 0.4 still meets the ground, one at 0.6 does not. The
 * alternative — requiring exactly equal levels — would break every junction at the foot of
 * a ramp, which is precisely where a ramp needs to meet something.
 */
export const SEPARATION_THRESHOLD = 0.5;

/** Above this the street is drawn as a deck rather than as road on the ground. */
export const ELEVATED_THRESHOLD = 0.5;

/** The level at a station, interpolating between breakpoints. */
export function levelAt(
  profile: readonly GradePoint[] | undefined,
  stationMeters: number,
  fallback = 0,
): number {
  if (!profile || profile.length === 0) return fallback;
  if (profile.length === 1) return profile[0]!.level;

  const first = profile[0]!;
  if (stationMeters <= first.stationMeters) return first.level;

  const last = profile[profile.length - 1]!;
  if (stationMeters >= last.stationMeters) return last.level;

  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i]!;
    const b = profile[i + 1]!;
    if (stationMeters > b.stationMeters) continue;
    const span = b.stationMeters - a.stationMeters;
    if (span <= 0) return b.level;
    const t = (stationMeters - a.stationMeters) / span;
    return a.level + (b.level - a.level) * t;
  }

  return last.level;
}

/** Whether two things crossing at these levels are on the same piece of ground. */
export function levelsMeet(a: number, b: number): boolean {
  return Math.abs(a - b) < SEPARATION_THRESHOLD;
}

/** Cumulative distance to each vertex of a line, in metres. */
export function stationsAlong(line: readonly LngLat[]): number[] {
  const stations = [0];
  for (let i = 1; i < line.length; i++) {
    stations.push(stations[i - 1]! + distanceMeters(line[i - 1]!, line[i]!));
  }
  return stations;
}

export interface GradeSpan {
  fromMeters: number;
  toMeters: number;
  /** 'ramp' where the level is changing, 'deck' where it is held away from the ground. */
  kind: 'ramp' | 'deck';
  /** Signed: +1 region is an overpass, -1 a tunnel. */
  direction: 1 | -1;
}

/**
 * The stretches worth drawing differently: the climbs, and the part held up in the air.
 *
 * Ramps and decks are separated because they read differently on a plan. A deck has an
 * edge — you can see where the structure is — while a ramp is ground rising to meet it,
 * and drawing them the same way loses exactly the information somebody is looking for when
 * they ask how the road gets back down.
 */
export function gradeSpans(profile: readonly GradePoint[] | undefined): GradeSpan[] {
  if (!profile || profile.length < 2) return [];

  const spans: GradeSpan[] = [];

  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i]!;
    const b = profile[i + 1]!;
    if (b.stationMeters <= a.stationMeters) continue;

    const climbing = Math.abs(b.level - a.level) > 1e-9;
    const direction: 1 | -1 = (climbing ? b.level + a.level : a.level) >= 0 ? 1 : -1;

    if (climbing) {
      spans.push({ fromMeters: a.stationMeters, toMeters: b.stationMeters, kind: 'ramp', direction });
      continue;
    }
    if (Math.abs(a.level) >= ELEVATED_THRESHOLD) {
      spans.push({ fromMeters: a.stationMeters, toMeters: b.stationMeters, kind: 'deck', direction });
    }
  }

  return spans;
}

/**
 * The piece of a line between two stations.
 *
 * Returns at least two points whenever the span has any length, so a caller can hand the
 * result straight to a renderer without checking.
 */
export function sliceLine(
  line: readonly LngLat[],
  fromMeters: number,
  toMeters: number,
): LngLat[] {
  const pts = dedupe(line);
  if (pts.length < 2 || toMeters <= fromMeters) return [];

  const stations = stationsAlong(pts);
  const total = stations[stations.length - 1]!;
  const from = Math.max(0, Math.min(fromMeters, total));
  const to = Math.max(0, Math.min(toMeters, total));
  if (to - from < 1e-6) return [];

  const at = (station: number): LngLat => {
    for (let i = 0; i < stations.length - 1; i++) {
      const a = stations[i]!;
      const b = stations[i + 1]!;
      if (station > b) continue;
      const span = b - a;
      const t = span <= 0 ? 0 : (station - a) / span;
      const p = pts[i]!;
      const q = pts[i + 1]!;
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    }
    return pts[pts.length - 1]!;
  };

  const out: LngLat[] = [at(from)];
  for (let i = 0; i < pts.length; i++) {
    const station = stations[i]!;
    if (station > from && station < to) out.push(pts[i]!);
  }
  out.push(at(to));
  return out;
}

/**
 * How far along a line a point sits, in metres.
 *
 * Measured by projection onto the nearest segment, so a junction position — which is a
 * point in space, not an index into anything — can be turned into the station a grade
 * profile is written against.
 */
export function stationAt(line: readonly LngLat[], point: LngLat): number {
  const pts = dedupe(line);
  if (pts.length < 2) return 0;

  const stations = stationsAlong(pts);
  let best = { station: 0, distance: Infinity };

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    const t = lenSq <= 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lenSq));
    const on: LngLat = [a[0] + dx * t, a[1] + dy * t];
    const distance = distanceMeters(point, on);
    if (distance < best.distance) {
      best = { station: stations[i]! + (stations[i + 1]! - stations[i]!) * t, distance };
    }
  }

  return best.station;
}

/**
 * A profile for a street that crosses something and comes back down.
 *
 * The default anybody actually wants when they say "put this over that": rise, hold across
 * the obstruction, fall. Stated in terms of where the crossing is, because that is what the
 * user can point at — the ramps are placed around it.
 */
export function overpassProfile(
  totalLengthMeters: number,
  crossingStationMeters: number,
  options: { rampMeters?: number; holdMeters?: number; direction?: 1 | -1 } = {},
): GradePoint[] {
  const ramp = options.rampMeters ?? 45;
  const hold = options.holdMeters ?? 25;
  const level = options.direction ?? 1;

  const holdFrom = Math.max(0, crossingStationMeters - hold / 2);
  const holdTo = Math.min(totalLengthMeters, crossingStationMeters + hold / 2);

  // Clamped to the street rather than extended past it: a street too short to carry its own
  // ramps starts elevated, which is honest — it says the ramp is somewhere off the drawing.
  const startsAt = Math.max(0, holdFrom - ramp);
  const endsAt = Math.min(totalLengthMeters, holdTo + ramp);

  const points: GradePoint[] = [];
  if (startsAt > 0) points.push({ stationMeters: 0, level: 0 });
  points.push({ stationMeters: startsAt, level: 0 });
  points.push({ stationMeters: holdFrom, level });
  points.push({ stationMeters: holdTo, level });
  points.push({ stationMeters: endsAt, level: 0 });
  if (endsAt < totalLengthMeters) points.push({ stationMeters: totalLengthMeters, level: 0 });

  // Collapse breakpoints that landed on top of each other after clamping.
  return points.filter(
    (p, i) => i === 0 || p.stationMeters - points[i - 1]!.stationMeters > 1e-6,
  );
}

/** Whether a profile says anything at all beyond "flat on the ground". */
export function isFlat(profile: readonly GradePoint[] | undefined): boolean {
  if (!profile || profile.length === 0) return true;
  return profile.every((p) => Math.abs(p.level) < 1e-9);
}

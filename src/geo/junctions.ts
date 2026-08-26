import { dedupe, localPlane, originFor } from './projection';
import { resolveCenterline } from './curve';
import type { LngLat, LocalPlane, PlanePoint } from './projection';
import { sectionExtent, travelwayWidth } from '../model/section';
import type { Street } from '../model/types';

/**
 * Where streets meet.
 *
 * Junctions are *derived*, not authored: anywhere two centerlines cross, or one ends on
 * another, is a junction. That is the only model that survives editing — drag a street and
 * its junctions move with it, reshape a corner and the geometry follows, with nothing to
 * keep in sync by hand.
 *
 * Customisation is layered on top by key rather than by storing a position. A junction's
 * identity is the *set of streets that meet there* plus an ordinal, so a corner radius
 * stays attached to the right corner after you insert a vertex, drag the crossing fifty
 * metres, or reverse the direction a street was drawn in. Storing a coordinate, or a
 * vertex index, would break under all three.
 *
 * Everything here is planar metres in a single shared local plane. One plane for the whole
 * project rather than one per street: junction geometry compares two streets against each
 * other, and two different planes would put their shared crossing point in two places.
 */

const EPS = 1e-9;

/** Below this, two crossings are the same crossing found twice. */
const DUPLICATE_METRES = 0.05;

/** Floor on the clustering radius, so hairline-thin streets still merge sensibly. */
const MIN_CLUSTER_METRES = 3;

/** A leg shorter than this is a stub — reported, because it constrains the design. */
export const STUB_METRES = 12;

/**
 * One arm of a junction: a street leaving the junction point in one direction.
 *
 * A street passing straight through contributes two legs; a street that ends there
 * contributes one. That is what makes a T-junction three legs rather than "two streets".
 */
export interface JunctionLeg {
  streetId: string;
  /** Distance along the street's centerline, in metres, at which the junction sits. */
  stationMeters: number;
  /** +1 if this leg heads toward increasing station, -1 toward decreasing. */
  sense: 1 | -1;
  /** Direction the leg heads away from the junction: radians, 0 = east, CCW. */
  bearing: number;
  /** How much street remains along this leg. Short legs constrain corner radii. */
  lengthMeters: number;
  /**
   * Section half-widths as seen looking OUTWARD along this leg — so `halfLeft` is always
   * the corner on the leg's left. For a leg with sense -1 these are the street's own left
   * and right swapped, which is exactly the bookkeeping that is easy to get wrong when
   * building corner fillets.
   */
  halfLeft: number;
  halfRight: number;
  /** Curb-to-curb half-widths, same outward frame. Drives the paved area. */
  travelwayHalfLeft: number;
  travelwayHalfRight: number;
}

export type JunctionKind = 'crossing' | 'tee' | 'corner';

export interface Junction {
  /**
   * Stable identity: the participating street ids, sorted, plus an ordinal distinguishing
   * multiple crossings of the same pair. Survives vertex edits and geometry changes.
   */
  key: string;
  streetIds: string[];
  position: LngLat;
  /** Legs sorted by bearing, counter-clockwise from east. Corners sit between them. */
  legs: JunctionLeg[];
  kind: JunctionKind;
  /** True when any leg is shorter than STUB_METRES. */
  hasStub: boolean;
}

// ---------------------------------------------------------------------------- tracks

interface Track {
  streetId: string;
  level: number;
  pts: PlanePoint[];
  /** Cumulative distance from the start at each vertex. */
  stations: number[];
  length: number;
  extent: { left: number; right: number };
  travelwayHalf: number;
}

function buildTrack(street: Street, plane: LocalPlane): Track | null {
  // The resolved line, not the control points: a curved street meets its neighbours where
  // the curve goes, and detecting against the straight control polygon would place the
  // junction somewhere the pavement never reaches.
  const line = dedupe(resolveCenterline(street));
  if (line.length < 2) return null;

  const pts = line.map((p) => plane.toPlane(p));
  const stations: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    stations.push(stations[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  }

  return {
    streetId: street.id,
    level: street.level ?? 0,
    pts,
    stations,
    length: stations[stations.length - 1]!,
    extent: sectionExtent(street.section),
    travelwayHalf: travelwayWidth(street.section.components) / 2,
  };
}

/** Unit tangent at a station, pointing toward increasing station. */
function tangentAt(track: Track, station: number): PlanePoint {
  const i = segmentIndexAt(track, station);
  const a = track.pts[i]!;
  const b = track.pts[i + 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function segmentIndexAt(track: Track, station: number): number {
  for (let i = 0; i < track.stations.length - 1; i++) {
    if (station <= track.stations[i + 1]! + EPS) return i;
  }
  return Math.max(track.stations.length - 2, 0);
}

// ------------------------------------------------------------------------- crossings

interface Crossing {
  point: PlanePoint;
  /** Station along each track. Keyed by street id. */
  stations: Map<string, number>;
  radius: number;
}

function cross2(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/**
 * Proper intersection of two segments, as parameters along each.
 *
 * Returns null for parallel or collinear pairs. Two streets running down the same line do
 * not form a junction — that is a duplicate, not a crossing, and treating it as one would
 * generate a junction at every shared vertex.
 */
function segmentCross(
  p: PlanePoint,
  p2: PlanePoint,
  q: PlanePoint,
  q2: PlanePoint,
): { t: number; u: number } | null {
  const rx = p2.x - p.x;
  const ry = p2.y - p.y;
  const sx = q2.x - q.x;
  const sy = q2.y - q.y;

  const denom = cross2(rx, ry, sx, sy);
  if (Math.abs(denom) < EPS) return null;

  const t = cross2(q.x - p.x, q.y - p.y, sx, sy) / denom;
  const u = cross2(q.x - p.x, q.y - p.y, rx, ry) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;

  return { t, u };
}

/** Closest point on a segment to `p`, as a parameter in [0,1] and a distance. */
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

function stationOf(track: Track, index: number, t: number): number {
  const a = track.stations[index]!;
  const b = track.stations[index + 1]!;
  return a + t * (b - a);
}

/**
 * How far apart two things can be and still count as meeting.
 *
 * Derived from the streets rather than fixed: an endpoint that lands anywhere inside the
 * crossing street's footprint is meeting it, and that footprint is metres wide. A fixed
 * tolerance would either miss a T-junction on a boulevard or invent one on a lane.
 */
function toleranceFor(a: Track, b: Track): number {
  return Math.max(a.extent.left, a.extent.right, b.extent.left, b.extent.right, MIN_CLUSTER_METRES);
}

function crossingsBetween(a: Track, b: Track): Crossing[] {
  const tolerance = toleranceFor(a, b);
  const found: Crossing[] = [];

  const add = (point: PlanePoint, stationA: number, stationB: number) => {
    for (const existing of found) {
      if (Math.hypot(existing.point.x - point.x, existing.point.y - point.y) < DUPLICATE_METRES) {
        return;
      }
    }
    found.push({
      point,
      stations: new Map([
        [a.streetId, stationA],
        [b.streetId, stationB],
      ]),
      radius: tolerance,
    });
  };

  // Proper crossings first: an X is unambiguous and takes priority over any near-miss.
  for (let i = 0; i < a.pts.length - 1; i++) {
    for (let j = 0; j < b.pts.length - 1; j++) {
      const hit = segmentCross(a.pts[i]!, a.pts[i + 1]!, b.pts[j]!, b.pts[j + 1]!);
      if (!hit) continue;
      const point = {
        x: a.pts[i]!.x + hit.t * (a.pts[i + 1]!.x - a.pts[i]!.x),
        y: a.pts[i]!.y + hit.t * (a.pts[i + 1]!.y - a.pts[i]!.y),
      };
      add(point, stationOf(a, i, hit.t), stationOf(b, j, hit.u));
    }
  }

  // Then T-junctions: an endpoint of one street landing on the body of the other. The
  // junction sits at the projection onto the through street, not at the loose endpoint,
  // so a centerline drawn slightly short still produces a square junction.
  const endpointOnto = (from: Track, onto: Track, flip: boolean) => {
    for (const end of [0, from.pts.length - 1]) {
      const p = from.pts[end]!;
      const stationFrom = from.stations[end]!;

      let best: { distance: number; point: PlanePoint; station: number } | null = null;
      for (let j = 0; j < onto.pts.length - 1; j++) {
        const near = closestOnSegment(p, onto.pts[j]!, onto.pts[j + 1]!);
        if (near.distance > tolerance) continue;
        if (!best || near.distance < best.distance) {
          best = { distance: near.distance, point: near.point, station: stationOf(onto, j, near.t) };
        }
      }
      if (!best) continue;
      add(best.point, flip ? best.station : stationFrom, flip ? stationFrom : best.station);
    }
  };

  endpointOnto(a, b, false);
  endpointOnto(b, a, true);

  return found;
}

// -------------------------------------------------------------------------- clusters

/**
 * Merge crossings that are really one junction.
 *
 * Three streets meeting at a plaza produce three pairwise crossings a metre or two apart;
 * they are one six-legged junction, not three. Greedy single-link clustering is enough —
 * junction counts are in the tens, and the radius comes from the streets themselves.
 */
function cluster(crossings: Crossing[]): Crossing[][] {
  const clusters: Crossing[][] = [];

  for (const crossing of crossings) {
    let target: Crossing[] | undefined;
    for (const group of clusters) {
      const near = group.some(
        (other) =>
          Math.hypot(other.point.x - crossing.point.x, other.point.y - crossing.point.y) <=
          Math.max(other.radius, crossing.radius),
      );
      if (near) {
        target = group;
        break;
      }
    }
    if (target) target.push(crossing);
    else clusters.push([crossing]);
  }

  return clusters;
}

// --------------------------------------------------------------------------- legs

function buildLegs(group: Crossing[], tracks: Map<string, Track>): JunctionLeg[] {
  // One station per street: average where a street appears in several crossings of the
  // same cluster, which is what happens when three streets meet at not-quite-one point.
  const stationByStreet = new Map<string, number[]>();
  for (const crossing of group) {
    for (const [streetId, station] of crossing.stations) {
      const list = stationByStreet.get(streetId);
      if (list) list.push(station);
      else stationByStreet.set(streetId, [station]);
    }
  }

  const legs: JunctionLeg[] = [];

  for (const [streetId, stations] of stationByStreet) {
    const track = tracks.get(streetId);
    if (!track) continue;
    const station = stations.reduce((sum, s) => sum + s, 0) / stations.length;
    const tangent = tangentAt(track, station);

    // A leg exists in each direction that still has street left in it. A street ending
    // here yields one leg; a street passing through yields two.
    const arms: { sense: 1 | -1; lengthMeters: number }[] = [];
    if (track.length - station > EPS) arms.push({ sense: 1, lengthMeters: track.length - station });
    if (station > EPS) arms.push({ sense: -1, lengthMeters: station });

    for (const arm of arms) {
      const dx = tangent.x * arm.sense;
      const dy = tangent.y * arm.sense;
      const bearing = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);

      // Looking outward along the leg, the section's own left and right swap when the leg
      // runs against the direction the street was drawn.
      const outwardLeft = arm.sense === 1 ? track.extent.left : track.extent.right;
      const outwardRight = arm.sense === 1 ? track.extent.right : track.extent.left;

      legs.push({
        streetId,
        stationMeters: station,
        sense: arm.sense,
        bearing,
        lengthMeters: arm.lengthMeters,
        halfLeft: outwardLeft,
        halfRight: outwardRight,
        travelwayHalfLeft: track.travelwayHalf,
        travelwayHalfRight: track.travelwayHalf,
      });
    }
  }

  legs.sort((a, b) => a.bearing - b.bearing);
  return legs;
}

function classify(legs: readonly JunctionLeg[], streetCount: number): JunctionKind {
  if (legs.length <= 2) return 'corner';
  if (legs.length === 3) return 'tee';
  return streetCount >= 2 ? 'crossing' : 'tee';
}

function centroid(group: Crossing[]): PlanePoint {
  let x = 0;
  let y = 0;
  for (const crossing of group) {
    x += crossing.point.x;
    y += crossing.point.y;
  }
  return { x: x / group.length, y: y / group.length };
}

// --------------------------------------------------------------------------- public

export interface DetectionResult {
  junctions: Junction[];
  /** The plane every junction was computed in — reuse it downstream, do not rebuild it. */
  plane: LocalPlane;
}

/**
 * Find every junction among the given streets.
 *
 * Hidden streets are excluded: hiding a street should remove its junctions too, or the
 * corners it created would stay carved out of streets that no longer meet anything.
 */
export function detectJunctions(streets: readonly Street[]): DetectionResult {
  const visible = streets.filter((s) => s.visible && s.centerline.length >= 2);
  const allPoints = visible.flatMap((s) => resolveCenterline(s));
  const plane = localPlane(originFor(allPoints.length ? allPoints : [[0, 0]]));

  const tracks = new Map<string, Track>();
  for (const street of visible) {
    const track = buildTrack(street, plane);
    if (track) tracks.set(street.id, track);
  }

  const list = [...tracks.values()];
  const crossings: Crossing[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      // Different levels never meet. An overpass crossing the street below it is not an
      // intersection, and detecting one would carve a hole through both.
      if (list[i]!.level !== list[j]!.level) continue;
      // Self-intersection is a curvature problem, not a junction, so pairs only.
      crossings.push(...crossingsBetween(list[i]!, list[j]!));
    }
  }

  const groups = cluster(crossings);
  const draft = groups.map((group) => {
    const legs = buildLegs(group, tracks);
    const streetIds = [...new Set(legs.map((l) => l.streetId))].sort();
    const point = centroid(group);
    return {
      streetIds,
      point,
      legs,
      kind: classify(legs, streetIds.length),
      hasStub: legs.some((l) => l.lengthMeters < STUB_METRES),
    };
  });

  // Ordinals are assigned within each street-set, ordered along the first street, so a
  // pair that crosses twice keeps "the northern one" and "the southern one" apart even
  // after both are dragged.
  const byGroup = new Map<string, typeof draft>();
  for (const entry of draft) {
    const groupKey = entry.streetIds.join('~');
    const bucket = byGroup.get(groupKey);
    if (bucket) bucket.push(entry);
    else byGroup.set(groupKey, [entry]);
  }

  const junctions: Junction[] = [];
  for (const [groupKey, entries] of byGroup) {
    const first = entries[0]!.streetIds[0]!;
    entries.sort((a, b) => {
      const sa = a.legs.find((l) => l.streetId === first)?.stationMeters ?? 0;
      const sb = b.legs.find((l) => l.streetId === first)?.stationMeters ?? 0;
      return sa - sb;
    });
    entries.forEach((entry, ordinal) => {
      junctions.push({
        key: `${groupKey}#${ordinal}`,
        streetIds: entry.streetIds,
        position: plane.toLngLat(entry.point),
        legs: entry.legs,
        kind: entry.kind,
        hasStub: entry.hasStub,
      });
    });
  }

  junctions.sort((a, b) => a.key.localeCompare(b.key));
  return { junctions, plane };
}

/** Angle from one leg to the next going counter-clockwise, in radians. */
export function cornerAngle(legs: readonly JunctionLeg[], index: number): number {
  const a = legs[index];
  const b = legs[(index + 1) % legs.length];
  if (!a || !b) return 0;
  const delta = b.bearing - a.bearing;
  return (delta + Math.PI * 2) % (Math.PI * 2);
}

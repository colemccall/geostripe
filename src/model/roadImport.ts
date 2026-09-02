import { resolveCenterline } from '../geo/curve';
import { sliceLine, stationsAlong } from '../geo/grade';
import { sectionAt } from '../geo/lanes';
import { dedupe } from '../geo/projection';
import type { LngLat } from '../geo/projection';
import type { RoadNetworkDoc, RoadNode, RoadSegment } from './road';
import { newId } from './types';
import type { Street } from './types';

/**
 * Turn a set of drawn streets into a real graph.
 *
 * The bridge between the two models, and a one-way one. A street is a long polyline with
 * junctions found wherever it happens to cross another; a road network is nodes you place
 * and roads you draw between them. Everything already traced exists in the first form, and
 * none of it should be thrown away to move to the second.
 *
 * The important decision here is what counts as JOINED, and the honest answer turned out to
 * be far stricter than the old detector's.
 *
 * That detector used a tolerance scaled to the widest street involved — twenty metres on a
 * forty-metre freeway — and clustered nearby hits into one junction reported at their
 * centroid. Measured against the real I-75 data it was calling roads joined whose ends are
 * seventeen and nineteen metres apart, and placing the junction on none of the streets that
 * supposedly met there: up to 16.8 m off every one of them. Each became a junction the
 * geometry then had to build, at a spot no road actually reached. That is not a tolerance to
 * be tuned. It is the model claiming to know something it cannot.
 *
 * So a node is placed only where roads genuinely meet:
 *
 *   - where two centerlines actually cross, at the exact crossing point, which by
 *     construction lies on both of them;
 *   - where one road's end lands within a lane's width of another road, which is somebody
 *     tracing a T-junction and stopping slightly short or long.
 *
 * Everything else stays unjoined and shows on the map as two separate ends. That is not a
 * failure to detect something — it is the truth about what was drawn, and joining them is
 * one edit. Nothing is connected until you connect it, which is the entire point.
 */

/** A cut this close to the end of a street is that end. */
const MIN_SEGMENT_METRES = 3;

/**
 * How close a road's end must come to another road to count as landing on it.
 *
 * A tracing tolerance, not a guess at intent. Somebody drawing a T aims at the road and
 * stops within a metre or two; nobody aims at a road and stops seventeen metres short. A
 * lane's width is the scale at which "that clearly meets" stops being true.
 */
const TOUCH_METRES = 3.5;

/** Two nodes closer than this are the same place. */
const WELD_METRES = 1;

/** Report an unjoined end this close to another road; beyond it, they are simply apart. */
const NEAR_MISS_METRES = 30;

const M_PER_DEG_LAT = 111132;

export interface NearMiss {
  position: LngLat;
  gapMeters: number;
  between: [string, string];
}

export interface ImportResult {
  doc: RoadNetworkDoc;
  /** Which segments each original street became. */
  segmentsByStreet: Map<string, string[]>;
  /**
   * Ends that came close to another road but not close enough to join.
   *
   * Reported rather than silently joined or silently ignored. These are exactly the places
   * the old model pretended about, and the first ones worth looking at.
   */
  nearMisses: NearMiss[];
}

interface Track {
  streetId: string;
  street: Street;
  line: LngLat[];
  stations: number[];
  length: number;
}

/** A place two roads meet, and where it falls along each. */
interface Meeting {
  point: LngLat;
  a: { streetId: string; station: number };
  b: { streetId: string; station: number };
}

export function roadNetworkFromStreets(streets: readonly Street[]): ImportResult {
  const tracks: Track[] = [];
  for (const street of streets) {
    if (street.visible === false) continue;
    const line = dedupe(resolveCenterline(street));
    if (line.length < 2) continue;
    const stations = stationsAlong(line);
    const length = stations[stations.length - 1]!;
    if (length <= MIN_SEGMENT_METRES) continue;
    tracks.push({ streetId: street.id, street, line, stations, length });
  }

  const meetings: Meeting[] = [];
  const nearMisses: NearMiss[] = [];
  for (let i = 0; i < tracks.length; i++) {
    for (let j = i + 1; j < tracks.length; j++) {
      meetingsBetween(tracks[i]!, tracks[j]!, meetings, nearMisses);
    }
  }

  // One node per meeting. Three roads crossing within a metre give three pairwise meetings
  // and three nodes; welding folds them back into the one place they are.
  const nodes: RoadNode[] = [];
  const cutsByStreet = new Map<string, { station: number; nodeId: string }[]>();

  const addCut = (streetId: string, station: number, nodeId: string) => {
    const list = cutsByStreet.get(streetId);
    if (list) list.push({ station, nodeId });
    else cutsByStreet.set(streetId, [{ station, nodeId }]);
  };

  for (const meeting of meetings) {
    const id = newId('n');
    nodes.push({ id, position: meeting.point });
    addCut(meeting.a.streetId, meeting.a.station, id);
    addCut(meeting.b.streetId, meeting.b.station, id);
  }

  const segments: RoadSegment[] = [];
  const segmentsByStreet = new Map<string, string[]>();

  for (const track of tracks) {
    const all = cutsByStreet.get(track.streetId) ?? [];
    const interior = all
      .filter(
        (cut) => cut.station > MIN_SEGMENT_METRES && track.length - cut.station > MIN_SEGMENT_METRES,
      )
      .sort((a, b) => a.station - b.station);

    // A road that stops on another already has a node there: its cut sits at station zero or
    // at the full length, which the interior filter removed. Pick it back up rather than
    // making a second node a few centimetres away.
    const endNodeFor = (station: number): string => {
      const existing = all.find((cut) => Math.abs(cut.station - station) <= MIN_SEGMENT_METRES);
      if (existing) return existing.nodeId;
      const id = newId('n');
      nodes.push({ id, position: pointAt(track.line, track.stations, station) });
      return id;
    };

    const stops: { station: number; nodeId: string }[] = [{ station: 0, nodeId: endNodeFor(0) }];
    for (const cut of interior) {
      if (cut.station - stops[stops.length - 1]!.station < MIN_SEGMENT_METRES) continue;
      stops.push(cut);
    }
    if (track.length - stops[stops.length - 1]!.station < MIN_SEGMENT_METRES && stops.length > 1) {
      stops.pop();
    }
    stops.push({ station: track.length, nodeId: endNodeFor(track.length) });

    const ids: string[] = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i]!;
      const to = stops[i + 1]!;
      if (from.nodeId === to.nodeId) continue;

      // The shape between the two nodes, with its ends dropped: the ends ARE the nodes, and
      // repeating them would let a road disagree with a node about where it stops.
      const piece = sliceLine(track.line, from.station, to.station);
      const shape = piece.slice(1, -1);

      // The section that applies along this stretch. A street dropping a lane into a ramp
      // becomes two roads with two widths, which is what it always was.
      const section = sectionAt(
        track.street.section,
        track.street.sectionChanges ?? [],
        (from.station + to.station) / 2,
      );

      const id = newId('s');
      segments.push({
        id,
        name: track.street.name,
        fromNodeId: from.nodeId,
        toNodeId: to.nodeId,
        shape,
        section: { ...section, id: newId('sec') },
        ...(track.street.level ? { level: track.street.level } : {}),
        visible: true,
      });
      ids.push(id);
    }

    segmentsByStreet.set(track.streetId, ids);
  }

  return { doc: weld({ nodes, segments }), segmentsByStreet, nearMisses };
}

// -------------------------------------------------------------------------- meetings

function meetingsBetween(a: Track, b: Track, out: Meeting[], nearMisses: NearMiss[]): void {
  const scale = Math.cos((a.line[0]![1] * Math.PI) / 180);
  const seen: LngLat[] = [];

  const push = (point: LngLat, stationA: number, stationB: number) => {
    for (const other of seen) if (apart(other, point, scale) < WELD_METRES) return;
    seen.push(point);
    out.push({
      point,
      a: { streetId: a.streetId, station: stationA },
      b: { streetId: b.streetId, station: stationB },
    });
  };

  // Proper crossings first. The point is on both lines exactly, which is what lets both
  // roads be cut there without either being bent to reach it.
  for (let i = 0; i < a.line.length - 1; i++) {
    for (let j = 0; j < b.line.length - 1; j++) {
      const hit = crossing(a.line[i]!, a.line[i + 1]!, b.line[j]!, b.line[j + 1]!, scale);
      if (!hit) continue;
      const p0 = a.line[i]!;
      const p1 = a.line[i + 1]!;
      push(
        [p0[0] + hit.t * (p1[0] - p0[0]), p0[1] + hit.t * (p1[1] - p0[1])],
        a.stations[i]! + hit.t * (a.stations[i + 1]! - a.stations[i]!),
        b.stations[j]! + hit.u * (b.stations[j + 1]! - b.stations[j]!),
      );
    }
  }

  // Then one road's end landing on the other. The node goes at the projection onto the
  // through road rather than at the loose end, so a line traced slightly short still meets
  // it squarely instead of leaving a sliver.
  const endOnto = (from: Track, onto: Track, flip: boolean) => {
    for (const end of [0, from.line.length - 1]) {
      const p = from.line[end]!;
      const stationFrom = from.stations[end]!;
      const near = nearestOnLine(onto.line, onto.stations, p, scale);
      if (near.distance <= TOUCH_METRES) {
        push(near.point, flip ? near.station : stationFrom, flip ? stationFrom : near.station);
      } else if (near.distance <= NEAR_MISS_METRES) {
        nearMisses.push({
          position: p,
          gapMeters: near.distance,
          between: [from.streetId, onto.streetId],
        });
      }
    }
  };

  endOnto(a, b, false);
  endOnto(b, a, true);
}

function apart(p: LngLat, q: LngLat, scale: number): number {
  return Math.hypot((p[0] - q[0]) * scale, p[1] - q[1]) * M_PER_DEG_LAT;
}

/** Where two segments properly cross, as parameters along each, or null. */
function crossing(
  a0: LngLat,
  a1: LngLat,
  b0: LngLat,
  b1: LngLat,
  scale: number,
): { t: number; u: number } | null {
  const rx = (a1[0] - a0[0]) * scale;
  const ry = a1[1] - a0[1];
  const sx = (b1[0] - b0[0]) * scale;
  const sy = b1[1] - b0[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-15) return null;
  const qpx = (b0[0] - a0[0]) * scale;
  const qpy = b0[1] - a0[1];
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

function nearestOnLine(
  line: readonly LngLat[],
  stations: readonly number[],
  point: LngLat,
  scale: number,
): { station: number; distance: number; point: LngLat } {
  let best = { station: 0, distance: Infinity, point: line[0]! };

  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const ax = a[0] * scale;
    const dx = b[0] * scale - ax;
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    const t =
      lenSq <= 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((point[0] * scale - ax) * dx + (point[1] - a[1]) * dy) / lenSq),
          );
    const cx = ax + t * dx;
    const cy = a[1] + t * dy;
    const distance = Math.hypot(point[0] * scale - cx, point[1] - cy) * M_PER_DEG_LAT;
    if (distance < best.distance) {
      best = {
        station: stations[i]! + t * (stations[i + 1]! - stations[i]!),
        distance,
        point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
      };
    }
  }

  return best;
}

function pointAt(line: readonly LngLat[], stations: readonly number[], station: number): LngLat {
  for (let i = 0; i < stations.length - 1; i++) {
    if (station <= stations[i + 1]!) {
      const span = stations[i + 1]! - stations[i]!;
      const t = span <= 1e-9 ? 0 : (station - stations[i]!) / span;
      const a = line[i]!;
      const b = line[i + 1]!;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
  }
  return line[line.length - 1]!;
}

/**
 * Fold together nodes that landed on the same spot.
 *
 * Three roads crossing within a metre produce three pairwise meetings and three nodes, and
 * they are one place. Left alone that is a joint that looks joined and is not — the roads
 * would come apart the moment any of the three was dragged.
 */
function weld(doc: RoadNetworkDoc): RoadNetworkDoc {
  const keep: RoadNode[] = [];
  const remap = new Map<string, string>();
  const scale = Math.cos(((doc.nodes[0]?.position[1] ?? 0) * Math.PI) / 180);

  for (const node of doc.nodes) {
    const near = keep.find((other) => apart(other.position, node.position, scale) < WELD_METRES);
    if (near) remap.set(node.id, near.id);
    else keep.push(node);
  }

  const segments = doc.segments
    .map((segment) => ({
      ...segment,
      fromNodeId: remap.get(segment.fromNodeId) ?? segment.fromNodeId,
      toNodeId: remap.get(segment.toNodeId) ?? segment.toNodeId,
    }))
    .filter((segment) => segment.fromNodeId !== segment.toNodeId);

  const used = new Set<string>();
  for (const segment of segments) {
    used.add(segment.fromNodeId);
    used.add(segment.toNodeId);
  }

  return { nodes: keep.filter((node) => used.has(node.id)), segments };
}

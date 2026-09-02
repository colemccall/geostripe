import { dedupe, localPlane, originFor } from './projection';
import type { LngLat, LocalPlane, PlanePoint } from './projection';
import { resolveCenterline } from './curve';
import { sectionAt } from './lanes';
import { sectionExtent, travelwayWidth } from '../model/section';
import type { Junction, JunctionLeg } from './junctions';
import type { Street } from '../model/types';

/**
 * The road network as a graph: nodes, and the segments between them.
 *
 * GeoStripe draws *streets* — continuous polylines you can grab anywhere and reshape. That
 * is the right thing to author, and it is why the editor works before you have thought
 * about intersections at all. But it is the wrong thing to *reason* about, and everything
 * that has been hard here traces back to reasoning about it directly.
 *
 * A street has no ends that mean anything. It has no notion of the stretch between two
 * junctions. Ask "how many lanes arrive at this intersection from the north" and there is
 * nothing to ask it of. So junction geometry was built by cutting shapes out of long
 * ribbons with polygon booleans, which is slow, and which fails in a specific way: five
 * roads that converge and separate get cut back to a shared rectangle, because a rectangle
 * is what you get when you have legs but no idea what they are legs OF.
 *
 * This module builds the layer underneath, the one road-building games have always had:
 *
 *   - a NODE is a place where road ends meet. It owns the ground there.
 *   - a SEGMENT is one stretch of road, running between exactly two nodes.
 *   - an END is a segment arriving at a node: a direction, and a width.
 *
 * Nothing here is authored. The graph is derived from the streets on every build, the same
 * way junctions are, so dragging a street still moves everything that touches it and there
 * is no second model to keep in step. What changes is that the derivation now produces
 * something with structure, and junction geometry is built from the ends that meet — which
 * is how you tell a crossroads from a fork without being told.
 *
 * Everything is planar metres in one shared local plane.
 */

const EPS = 1e-9;

/** A cut this close to a street's end is that end, not a segment of its own. */
const MIN_SEGMENT_METRES = 3;

/**
 * Below this, two roads are running together rather than crossing.
 *
 * The one number that separates a junction from a merge, and it earns that job because it
 * is also the number that makes the geometry finite. Two ends meeting at angle d have their
 * kerb corner at (width / sin d) from the node: at 90 degrees that is one width away, at 30
 * degrees two, at 20 degrees three — and then it runs away fast. At 5 degrees the corner is
 * a hundred metres down the road, which is not a corner, it is a gore, and the roads either
 * side of it are merging.
 *
 * So the corner distance is capped at the value this angle implies, and a pair that wants
 * more is not cornered at all. That is what stops a ramp fan being boxed.
 */
export const MIN_CROSS_DEGREES = 20;

/** (width / sin MIN_CROSS_DEGREES) — how far a corner may sit from the node, per metre of width. */
const CORNER_REACH_FACTOR = 1 / Math.sin((MIN_CROSS_DEGREES * Math.PI) / 180);

/** Floor on the width used for that cap, so hairline streets still get a usable corner. */
const MIN_CORNER_WIDTH_METRES = 3;

/** Angular slop, in radians, for "these two ends are one straight road". */
const STRAIGHT_EPS = 0.02;

/**
 * How far off one line a node's roads may lie and still be running together.
 *
 * A different question from MIN_CROSS_DEGREES, and deliberately a different number. That one
 * asks whether two kerbs make a corner; this one asks whether the node is a crossing at all.
 * Two roads meeting at thirty degrees do have a kerb corner, and a node where every road
 * lies within forty degrees of one line still has nothing crossing anything — everybody is
 * going roughly the same way.
 *
 * Forty is the figure the merge classifier has always used, and this keeps them in step.
 */
export const DEFAULT_CORRIDOR_DEGREES = 40;

// ----------------------------------------------------------------------------- types

/**
 * One segment arriving at one node.
 *
 * The unit the whole module exists to provide. A junction is not a set of streets, it is a
 * set of ends: five roads terminating together is five ends, and a crossroads where two
 * streets pass through is four — the same street contributing an end on each side, because
 * from the node's point of view those are two different roads leaving in two directions.
 */
export interface SegmentEnd {
  segmentId: string;
  nodeId: string;
  streetId: string;
  /** Station along the street's resolved centerline where this end sits. */
  stationMeters: number;
  /** +1 if the segment runs toward increasing station away from the node, -1 toward decreasing. */
  sense: 1 | -1;
  /** Direction the segment heads AWAY from the node: radians, 0 = east, CCW. */
  bearing: number;
  /**
   * Section half-widths seen looking OUTWARD along the segment, so `halfLeft` is always the
   * kerb on this end's left. For sense -1 these are the street's own left and right swapped.
   */
  halfLeft: number;
  halfRight: number;
  /** Curb-to-curb half-width, same outward frame. */
  travelwayHalf: number;
  /** Length of the segment this end belongs to. Short segments constrain corner radii. */
  lengthMeters: number;
  level: number;
}

/** One stretch of road, between exactly two nodes. */
export interface NetworkSegment {
  id: string;
  streetId: string;
  fromNodeId: string;
  toNodeId: string;
  /** Stations along the street, always fromStation < toStation. */
  fromStation: number;
  toStation: number;
  lengthMeters: number;
  level: number;
}

export interface NetworkNode {
  id: string;
  position: PlanePoint;
  positionLngLat: LngLat;
  /** Ends sorted by bearing, counter-clockwise from east. */
  ends: SegmentEnd[];
  /** Set when this node came from a detected or placed junction rather than a loose end. */
  junctionKey?: string;
  /** Set when a user placed the junction this node came from. */
  placedNodeId?: string;
}

export interface Network {
  nodes: NetworkNode[];
  segments: NetworkSegment[];
  nodeById: Map<string, NetworkNode>;
  segmentById: Map<string, NetworkSegment>;
  /** Segment ids along each street, in station order. */
  segmentsByStreet: Map<string, string[]>;
  plane: LocalPlane;
}

/**
 * What kind of place this node is, read off the ends rather than counted from the streets.
 *
 * - `terminus`     one end. The road stops here.
 * - `continuation` two ends that carry on into each other. A bend, or a change of section.
 * - `merge`        three or more ends, none of which corners against another: they all run
 *                  the same way. A fork, a ramp joining a freeway, a braid of carriageways.
 * - `junction`     at least one real corner. Something turns across something.
 */
export type NodeForm = 'terminus' | 'continuation' | 'merge' | 'junction';

/** The kerb corner in the gap between two consecutive ends. */
export interface NodeCorner {
  /** Index into the node's ends: the end on the clockwise side, whose LEFT edge bounds this. */
  fromEnd: number;
  /** The end on the counter-clockwise side, whose RIGHT edge bounds this. */
  toEnd: number;
  /** Angular gap between the two ends, radians. */
  gap: number;
  /**
   * Where the two kerbs meet, or null when they do not meet anywhere useful — because the
   * ends run parallel, or because the meeting point is past the cap and the two roads are
   * merging rather than cornering.
   */
  point: PlanePoint | null;
}

export interface NodeEnvelope {
  form: NodeForm;
  /** How far each end retreats from the node centre, in the node's end order. */
  retreats: number[];
  corners: NodeCorner[];
  /**
   * The paved ground the node owns. Empty for a `merge` and a `terminus`, which own none:
   * a fork is a continuous surface belonging to the roads, and a dead end is just an end.
   */
  surface: PlanePoint[];
}

// ------------------------------------------------------------------------- vector help

const unit = (bearing: number): PlanePoint => ({ x: Math.cos(bearing), y: Math.sin(bearing) });
const leftOf = (d: PlanePoint): PlanePoint => ({ x: -d.y, y: d.x });
const cross = (a: PlanePoint, b: PlanePoint): number => a.x * b.y - a.y * b.x;

/** Positive angular gap from `a` counter-clockwise to `b`, in (0, 2pi]. */
function ccwGap(a: number, b: number): number {
  const raw = (b - a) % (Math.PI * 2);
  const gap = raw <= EPS ? raw + Math.PI * 2 : raw;
  return gap;
}

// ------------------------------------------------------------------------- the graph

interface Alignment {
  streetId: string;
  pts: PlanePoint[];
  stations: number[];
  length: number;
  level: number;
  street: Street;
}

function alignmentFor(street: Street, plane: LocalPlane): Alignment | null {
  const line = dedupe(resolveCenterline(street));
  if (line.length < 2) return null;

  const pts = line.map((p) => plane.toPlane(p));
  const stations: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    stations.push(
      stations[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y),
    );
  }

  return {
    streetId: street.id,
    pts,
    stations,
    length: stations[stations.length - 1]!,
    level: street.level ?? 0,
    street,
  };
}

function segmentIndexAt(alignment: Alignment, station: number): number {
  for (let i = 0; i < alignment.stations.length - 1; i++) {
    if (station <= alignment.stations[i + 1]! + EPS) return i;
  }
  return Math.max(alignment.stations.length - 2, 0);
}

/** Unit tangent at a station, pointing toward increasing station. */
function tangentAt(alignment: Alignment, station: number): PlanePoint {
  const i = segmentIndexAt(alignment, station);
  const a = alignment.pts[i]!;
  const b = alignment.pts[i + 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function pointAt(alignment: Alignment, station: number): PlanePoint {
  const i = segmentIndexAt(alignment, station);
  const a = alignment.pts[i]!;
  const b = alignment.pts[i + 1]!;
  const span = alignment.stations[i + 1]! - alignment.stations[i]!;
  const t = span <= EPS ? 0 : (station - alignment.stations[i]!) / span;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/**
 * Widths at a station, in the street's own frame.
 *
 * Reads the section that actually applies there, so a freeway that drops a lane into a ramp
 * arrives at the node narrower than it left the last one — which is the entire point of
 * having segments.
 */
function halfWidthsAt(street: Street, station: number): { left: number; right: number; travelway: number } {
  const section = sectionAt(street.section, street.sectionChanges ?? [], station);
  const extent = sectionExtent(section);
  return {
    left: extent.left,
    right: extent.right,
    travelway: travelwayWidth(section.components) / 2,
  };
}

/**
 * Every station along a street at which it is cut.
 *
 * The junction stations, plus the two ends. Cuts within a lane's width of an end collapse
 * onto it: a junction three metres from where a road stops is that road stopping, and
 * keeping both would leave a three-metre segment nobody drew.
 */
function cutStations(alignment: Alignment, junctionStations: readonly number[]): number[] {
  const cuts = [0, alignment.length];
  for (const station of junctionStations) {
    const clamped = Math.min(Math.max(station, 0), alignment.length);
    if (clamped <= MIN_SEGMENT_METRES) continue;
    if (alignment.length - clamped <= MIN_SEGMENT_METRES) continue;
    cuts.push(clamped);
  }
  cuts.sort((a, b) => a - b);

  const out: number[] = [];
  for (const cut of cuts) {
    const last = out[out.length - 1];
    if (last !== undefined && cut - last < MIN_SEGMENT_METRES) continue;
    out.push(cut);
  }
  // The final end must survive even if the last junction crowded it.
  if (out[out.length - 1]! < alignment.length - EPS) {
    if (alignment.length - out[out.length - 1]! < MIN_SEGMENT_METRES) out.pop();
    out.push(alignment.length);
  }
  return out;
}

/** The node a cut belongs to: a junction if one sits there, otherwise a loose end. */
function nodeIdForCut(
  streetId: string,
  station: number,
  atEnd: 'start' | 'end' | null,
  legsByStation: { station: number; key: string }[],
): string {
  let best: { station: number; key: string } | null = null;
  for (const leg of legsByStation) {
    if (best === null || Math.abs(leg.station - station) < Math.abs(best.station - station)) {
      best = leg;
    }
  }
  if (best && Math.abs(best.station - station) <= MIN_SEGMENT_METRES) return `j:${best.key}`;
  if (atEnd) return `end:${streetId}:${atEnd}`;
  // A cut with no junction and not at an end cannot happen through cutStations, but a
  // caller-supplied station could produce one; give it a node of its own rather than
  // silently welding it to something else.
  return `cut:${streetId}:${station.toFixed(3)}`;
}

export interface NetworkOptions {
  /** Extra stations to cut at, keyed by street id — where a section changes, typically. */
  extraCuts?: Record<string, readonly number[]>;
}

/**
 * Build the graph.
 *
 * Junctions come in already found — detection is not this module's job, and reusing it
 * means levels, grade separation, placed nodes and clustering all keep working exactly as
 * they did. What is new is everything downstream of "here is a place where roads meet".
 */
export function buildNetwork(
  streets: readonly Street[],
  junctions: readonly Junction[],
  plane?: LocalPlane,
  options: NetworkOptions = {},
): Network {
  const visible = streets.filter((street) => street.visible !== false);
  const workingPlane = plane ?? localPlane(originFor(visible.flatMap((s) => s.centerline)));

  const alignments = new Map<string, Alignment>();
  for (const street of visible) {
    const alignment = alignmentFor(street, workingPlane);
    if (alignment) alignments.set(street.id, alignment);
  }

  // Where each street is touched by a junction, and by which one.
  const touchesByStreet = new Map<string, { station: number; key: string }[]>();
  const junctionByKey = new Map<string, Junction>();
  for (const junction of junctions) {
    junctionByKey.set(junction.key, junction);
    const seen = new Set<string>();
    for (const leg of junction.legs) {
      if (seen.has(leg.streetId)) continue;
      seen.add(leg.streetId);
      const list = touchesByStreet.get(leg.streetId);
      const touch = { station: leg.stationMeters, key: junction.key };
      if (list) list.push(touch);
      else touchesByStreet.set(leg.streetId, [touch]);
    }
  }

  const segments: NetworkSegment[] = [];
  const segmentsByStreet = new Map<string, string[]>();
  const endsByNode = new Map<string, SegmentEnd[]>();

  for (const [streetId, alignment] of alignments) {
    const touches = touchesByStreet.get(streetId) ?? [];
    const extra = options.extraCuts?.[streetId] ?? [];
    const cuts = cutStations(alignment, [...touches.map((t) => t.station), ...extra]);
    const ids: string[] = [];

    for (let i = 0; i < cuts.length - 1; i++) {
      const fromStation = cuts[i]!;
      const toStation = cuts[i + 1]!;
      const id = `${streetId}#${i}`;
      const fromNodeId = nodeIdForCut(streetId, fromStation, i === 0 ? 'start' : null, touches);
      const toNodeId = nodeIdForCut(
        streetId,
        toStation,
        i === cuts.length - 2 ? 'end' : null,
        touches,
      );

      const segment: NetworkSegment = {
        id,
        streetId,
        fromNodeId,
        toNodeId,
        fromStation,
        toStation,
        lengthMeters: toStation - fromStation,
        level: alignment.level,
      };
      segments.push(segment);
      ids.push(id);

      // Two ends, each looking outward from its node along this segment.
      for (const [nodeId, station, sense] of [
        [fromNodeId, fromStation, 1],
        [toNodeId, toStation, -1],
      ] as const) {
        const tangent = tangentAt(alignment, station);
        const dx = tangent.x * sense;
        const dy = tangent.y * sense;
        const widths = halfWidthsAt(alignment.street, station);
        const end: SegmentEnd = {
          segmentId: id,
          nodeId,
          streetId,
          stationMeters: station,
          sense,
          bearing: (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2),
          halfLeft: sense === 1 ? widths.left : widths.right,
          halfRight: sense === 1 ? widths.right : widths.left,
          travelwayHalf: widths.travelway,
          lengthMeters: segment.lengthMeters,
          level: alignment.level,
        };
        const list = endsByNode.get(nodeId);
        if (list) list.push(end);
        else endsByNode.set(nodeId, [end]);
      }
    }

    segmentsByStreet.set(streetId, ids);
  }

  const nodes: NetworkNode[] = [];
  for (const [nodeId, ends] of endsByNode) {
    ends.sort((a, b) => a.bearing - b.bearing);

    let position: PlanePoint;
    let positionLngLat: LngLat;
    let junctionKey: string | undefined;
    let placedNodeId: string | undefined;

    if (nodeId.startsWith('j:')) {
      junctionKey = nodeId.slice(2);
      const junction = junctionByKey.get(junctionKey);
      positionLngLat = junction ? junction.position : [0, 0];
      position = workingPlane.toPlane(positionLngLat);
      if (junction?.nodeId) placedNodeId = junction.nodeId;
    } else {
      // A loose end, or a cut of our own: the node is wherever that end is.
      const first = ends[0]!;
      const alignment = alignments.get(first.streetId)!;
      position = pointAt(alignment, first.stationMeters);
      positionLngLat = workingPlane.toLngLat(position);
    }

    nodes.push({
      id: nodeId,
      position,
      positionLngLat,
      ends,
      ...(junctionKey ? { junctionKey } : {}),
      ...(placedNodeId ? { placedNodeId } : {}),
    });
  }

  return {
    nodes,
    segments,
    nodeById: new Map(nodes.map((node) => [node.id, node])),
    segmentById: new Map(segments.map((segment) => [segment.id, segment])),
    segmentsByStreet,
    plane: workingPlane,
  };
}

// ---------------------------------------------------------------------- node geometry

/**
 * Where two consecutive ends' kerbs meet, and how far each must retreat to get there.
 *
 * Ends are in counter-clockwise order, so the gap between end `a` and the next end `b` is
 * bounded on one side by a's LEFT kerb and on the other by b's RIGHT kerb. Solving for
 * where those two lines cross gives the corner, and the distances along each end at which
 * it sits are exactly how far back each road must stop.
 *
 * Returns null when there is no corner to build:
 *
 *   - the two ends are parallel or anti-parallel, so the kerbs never meet. A road running
 *     straight through a junction is this case, and retreating it would be wrong.
 *   - the meeting point is behind the node, which means the gap is reflex and the corner
 *     belongs to the other side.
 *   - the meeting point is further out than MIN_CROSS_DEGREES allows. Two roads at five
 *     degrees do meet, eventually, hundreds of metres away — but that shape is a gore
 *     between merging roads, not a kerb, and building it as a corner is what turns a fork
 *     into a box.
 */
function cornerBetween(centre: PlanePoint, a: SegmentEnd, b: SegmentEnd): {
  point: PlanePoint;
  fromDistance: number;
  toDistance: number;
} | null {
  const gap = ccwGap(a.bearing, b.bearing);
  if (gap >= Math.PI - STRAIGHT_EPS) return null;

  const ua = unit(a.bearing);
  const ub = unit(b.bearing);
  const denom = cross(ua, ub);
  if (Math.abs(denom) < 1e-6) return null;

  const na = leftOf(ua);
  const nb = leftOf(ub);
  // a's left kerb:  centre + t*ua + halfLeft(a)*na
  // b's right kerb: centre + s*ub - halfRight(b)*nb
  const d = {
    x: -b.halfRight * nb.x - a.halfLeft * na.x,
    y: -b.halfRight * nb.y - a.halfLeft * na.y,
  };
  const t = cross(d, ub) / denom;
  const s = cross(d, ua) / denom;
  if (t < -EPS || s < -EPS) return null;

  const width = Math.max(a.halfLeft + b.halfRight, MIN_CORNER_WIDTH_METRES);
  const cap = width * CORNER_REACH_FACTOR;
  if (t > cap || s > cap) return null;

  return {
    point: { x: centre.x + t * ua.x + a.halfLeft * na.x, y: centre.y + t * ua.y + a.halfLeft * na.y },
    fromDistance: t,
    toDistance: s,
  };
}

/**
 * Group the ends into bundles of roads heading the same way.
 *
 * Ends arrive sorted by bearing, so a bundle is a run of them with no gap wider than the
 * spread, wrapping around from the last back to the first. Two carriageways of a freeway
 * are one bundle; the four arms of a crossroads are four.
 *
 * The spread defaults to the same figure the merge test uses, and that is not a coincidence
 * — it is what keeps the count and the classification telling the same story. A node the
 * classifier calls a merge has every end within the corridor, so its ends fall into one
 * bundle heading out and at most one heading back. Grouped at any tighter grain a fork
 * would report three or four bundles while being called a merge, which is a number that
 * makes a reader doubt the label.
 */
export function bundlesOf(
  ends: readonly SegmentEnd[],
  spreadDegrees = DEFAULT_CORRIDOR_DEGREES,
): number[][] {
  const n = ends.length;
  if (n === 0) return [];
  const threshold = (spreadDegrees * Math.PI) / 180;

  const breaks: number[] = [];
  for (let i = 0; i < n; i++) {
    const gap = ccwGap(ends[i]!.bearing, ends[(i + 1) % n]!.bearing);
    if (gap > threshold) breaks.push((i + 1) % n);
  }
  if (breaks.length === 0) return [Array.from({ length: n }, (_, i) => i)];

  const out: number[][] = [];
  for (let b = 0; b < breaks.length; b++) {
    const start = breaks[b]!;
    const stop = breaks[(b + 1) % breaks.length]!;
    const bundle: number[] = [];
    for (let i = start; ; i = (i + 1) % n) {
      bundle.push(i);
      if ((i + 1) % n === stop) break;
    }
    out.push(bundle);
  }
  return out;
}

/**
 * What kind of place this is.
 *
 * A merge is a node where nothing crosses anything: every road runs along one corridor, in
 * at most two directions. Two conditions, and both are needed.
 *
 * The bundles say the roads all point the same way — one bundle, or two facing each other.
 * That alone is not enough, and an early version of this that stopped there was wrong in a
 * way an existing test caught: three streets crossing at seven degrees also have their ends
 * in two opposing bundles, and they are not merging, they are crossing at a rotten angle.
 * Traffic on each really does cut across the other two.
 *
 * The difference is whether the roads END here. A fork is roads that terminate together and
 * separate; a shallow crossing is roads that carry straight on out the far side. So at most
 * one street may pass through — one may, because a ramp leaving a freeway is exactly that,
 * and the freeway carrying on is not crossing anything.
 */
function formOf(ends: readonly SegmentEnd[], corridorDegrees: number): NodeForm {
  if (ends.length <= 1) return 'terminus';
  if (ends.length === 2) return 'continuation';

  // Every end has to lie within the corridor. Anti-parallel counts as aligned: the two ends
  // of a road passing through point opposite ways, and so do a ramp arriving and the road
  // it runs into.
  //
  // Pairwise rather than measuring the whole spread at once, which is not the same test and
  // is the looser one. Ends at 0, 40 and 79 degrees span a corridor either way, but the
  // outer two are seventy-nine degrees apart and traffic between them genuinely turns.
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const between = Math.abs(ends[i]!.bearing - ends[j]!.bearing) % (Math.PI * 2);
      const acute = between > Math.PI ? Math.PI * 2 - between : between;
      const off = Math.min(acute, Math.PI - acute);
      if ((off * 180) / Math.PI > corridorDegrees) return 'junction';
    }
  }

  const endsPerStreet = new Map<string, number>();
  for (const end of ends) {
    endsPerStreet.set(end.streetId, (endsPerStreet.get(end.streetId) ?? 0) + 1);
  }
  const through = [...endsPerStreet.values()].filter((count) => count >= 2).length;
  if (through > 1) return 'junction';

  return 'merge';
}

/**
 * The ground a node owns, and how far each road stops short of it.
 *
 * This is the construction that road-building games use and GeoStripe did not have. Every
 * end retreats far enough that its kerbs clear its neighbours', the retreated mouths are
 * joined corner to corner, and the ring between them is the junction surface. Nothing is
 * cut out of anything: the surface is built from the ends, so it cannot gouge a road it was
 * never told about, and its cost does not depend on how long the roads are.
 *
 * The form falls out of the same arithmetic. A node whose ends never corner against each
 * other is a merge — that is not a separate rule, it is what "no corner within
 * MIN_CROSS_DEGREES" means — and a merge owns no ground, because the roads there are simply
 * running alongside one another and the pavement is theirs.
 */
export interface EnvelopeOptions {
  /** How far off one line the roads may lie and still count as running together. */
  corridorDegrees?: number;
}

export function nodeEnvelope(node: NetworkNode, options: EnvelopeOptions = {}): NodeEnvelope {
  const corridorDegrees = options.corridorDegrees ?? DEFAULT_CORRIDOR_DEGREES;
  const ends = node.ends;
  const n = ends.length;

  if (n === 0) return { form: 'terminus', retreats: [], corners: [], surface: [] };
  if (n === 1) return { form: 'terminus', retreats: [0], corners: [], surface: [] };

  const corners: NodeCorner[] = [];
  const retreats = new Array<number>(n).fill(0);

  // Only consecutive pairs can corner: any other pair has an end between them, and that end
  // is what actually bounds the gap.
  const pairs = n === 2 ? [[0, 1]] : Array.from({ length: n }, (_, i) => [i, (i + 1) % n]);

  for (const [i, j] of pairs) {
    const a = ends[i!]!;
    const b = ends[j!]!;
    const hit = cornerBetween(node.position, a, b);
    corners.push({
      fromEnd: i!,
      toEnd: j!,
      gap: ccwGap(a.bearing, b.bearing),
      point: hit ? hit.point : null,
    });
    if (!hit) continue;
    retreats[i!] = Math.max(retreats[i!]!, hit.fromDistance);
    retreats[j!] = Math.max(retreats[j!]!, hit.toDistance);
  }

  const form = formOf(ends, corridorDegrees);
  if (form !== 'junction') {
    return { form, retreats: retreats.map(() => 0), corners, surface: [] };
  }

  return { form, retreats, corners, surface: buildSurface(node, retreats, corners) };
}

/**
 * The ring, from retreats that may since have been clamped.
 *
 * Split out because the retreats a node wants and the retreats it gets are not always the
 * same number — see `envelopesFor`.
 */
function buildSurface(
  node: NetworkNode,
  retreats: readonly number[],
  corners: readonly NodeCorner[],
): PlanePoint[] {
  // Walk the ends counter-clockwise: each contributes its retreated mouth, right kerb to
  // left kerb, and each gap contributes its corner where there is one.
  const surface: PlanePoint[] = [];
  for (let i = 0; i < node.ends.length; i++) {
    const end = node.ends[i]!;
    const u = unit(end.bearing);
    const nrm = leftOf(u);
    const r = retreats[i]!;
    const base = { x: node.position.x + r * u.x, y: node.position.y + r * u.y };
    surface.push({ x: base.x - end.halfRight * nrm.x, y: base.y - end.halfRight * nrm.y });
    surface.push({ x: base.x + end.halfLeft * nrm.x, y: base.y + end.halfLeft * nrm.y });
    const corner = corners.find((c) => c.fromEnd === i);
    if (corner?.point) surface.push(corner.point);
  }
  return surface;
}

/**
 * How far along the street each segment's usable pavement runs, once its ends have
 * retreated into their nodes.
 *
 * The replacement for cutting junction holes out of a ribbon with a polygon boolean. A
 * segment knows its own two ends, so it knows exactly where to start and stop, and that is
 * a subtraction rather than a boolean.
 */
export function segmentSpan(
  network: Network,
  segmentId: string,
  envelopes: Map<string, NodeEnvelope>,
): { fromStation: number; toStation: number } | null {
  const segment = network.segmentById.get(segmentId);
  if (!segment) return null;

  const retreatAt = (nodeId: string): number => {
    const node = network.nodeById.get(nodeId);
    const envelope = envelopes.get(nodeId);
    if (!node || !envelope) return 0;
    const index = node.ends.findIndex((end) => end.segmentId === segmentId);
    return index < 0 ? 0 : (envelope.retreats[index] ?? 0);
  };

  const from = segment.fromStation + retreatAt(segment.fromNodeId);
  const to = segment.toStation - retreatAt(segment.toNodeId);
  if (to - from <= EPS) return null;
  return { fromStation: from, toStation: to };
}

/**
 * Every node's envelope, keyed by node id, with short segments settled.
 *
 * A node works out its retreats from its own ends alone, which is right — it is the only
 * one that knows what meets there. But two nodes a short way apart can each demand more
 * road than lies between them, and the real I-75 data does exactly that: a twenty-two metre
 * link between two ramp terminals whose junctions between them wanted twenty-seven. Left
 * alone that leaves a gap where a road should be.
 *
 * Neither node is wrong, so neither gets to win. Both give way in proportion, keeping a
 * few metres of road visible between them. The junction geometry ends up tighter than the
 * kerbs strictly want and the two surfaces sit closer together than they should — which is
 * exactly what a cramped junction looks like on the ground, and it is honest about it
 * rather than pretending there is room.
 *
 * One pass is exact, not an approximation: every retreat belongs to exactly one segment
 * end, so no clamp can disturb another.
 */
export function envelopesFor(
  network: Network,
  options: EnvelopeOptions = {},
): Map<string, NodeEnvelope> {
  const envelopes = new Map(network.nodes.map((node) => [node.id, nodeEnvelope(node, options)]));
  const touched = new Set<string>();

  const indexOf = (nodeId: string, segmentId: string): number => {
    const node = network.nodeById.get(nodeId);
    return node ? node.ends.findIndex((end) => end.segmentId === segmentId) : -1;
  };

  for (const segment of network.segments) {
    const fromIndex = indexOf(segment.fromNodeId, segment.id);
    const toIndex = indexOf(segment.toNodeId, segment.id);
    const fromEnvelope = envelopes.get(segment.fromNodeId);
    const toEnvelope = envelopes.get(segment.toNodeId);
    if (!fromEnvelope || !toEnvelope || fromIndex < 0 || toIndex < 0) continue;

    const wanted = (fromEnvelope.retreats[fromIndex] ?? 0) + (toEnvelope.retreats[toIndex] ?? 0);
    const room = segment.lengthMeters - MIN_SEGMENT_METRES;
    if (wanted <= EPS || wanted <= room) continue;

    const scale = Math.max(0, room) / wanted;
    fromEnvelope.retreats[fromIndex] = (fromEnvelope.retreats[fromIndex] ?? 0) * scale;
    toEnvelope.retreats[toIndex] = (toEnvelope.retreats[toIndex] ?? 0) * scale;
    touched.add(segment.fromNodeId);
    touched.add(segment.toNodeId);
  }

  for (const nodeId of touched) {
    const envelope = envelopes.get(nodeId)!;
    if (envelope.form !== 'junction') continue;
    const node = network.nodeById.get(nodeId)!;
    envelopes.set(nodeId, {
      ...envelope,
      surface: buildSurface(node, envelope.retreats, envelope.corners),
    });
  }

  return envelopes;
}

/**
 * How many lanes arrive at a node, and how many leave.
 *
 * The question the street model could not answer, and the reason lane balance at an
 * interchange was guesswork. With ends in hand it is a count.
 */
export function laneBalance(
  node: NetworkNode,
  streets: readonly Street[],
): { inbound: number; outbound: number } {
  const byId = new Map(streets.map((street) => [street.id, street]));
  let inbound = 0;
  let outbound = 0;

  for (const end of node.ends) {
    const street = byId.get(end.streetId);
    if (!street) continue;
    const section = sectionAt(street.section, street.sectionChanges ?? [], end.stationMeters);
    for (const component of section.components) {
      // Direction is relative to the way the street was drawn; an end with sense -1 looks
      // back down the street, so the two swap.
      const towardNode =
        end.sense === 1 ? component.direction === 'backward' : component.direction === 'forward';
      if (component.direction === 'both') {
        inbound += 0.5;
        outbound += 0.5;
      } else if (towardNode) {
        inbound += 1;
      } else if (component.direction === 'forward' || component.direction === 'backward') {
        outbound += 1;
      }
    }
  }

  return { inbound, outbound };
}

/** Legs in the shape the existing intersection builder expects, from a node's ends. */
export function legsFromEnds(node: NetworkNode): JunctionLeg[] {
  return node.ends.map((end) => ({
    streetId: end.streetId,
    stationMeters: end.stationMeters,
    sense: end.sense,
    bearing: end.bearing,
    lengthMeters: end.lengthMeters,
    halfLeft: end.halfLeft,
    halfRight: end.halfRight,
    travelwayHalfLeft: end.travelwayHalf,
    travelwayHalfRight: end.travelwayHalf,
  }));
}

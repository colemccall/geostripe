import { dedupe, localPlane } from '../geo/crs';
import type { LngLat, PlanePoint } from '../geo/crs';
import { resolveCenterline, tessellate } from '../geo/curve';
import { PRIMITIVES } from '../library/primitives';
import type { Asset, LineAsset } from './asset';
import { isLineAsset } from './asset';
import {
  addNode,
  addSegment,
  newPatchId,
  nodeMap,
  segmentControlPoints,
  setElevation,
} from './doc';
import type { Doc, Patch, Segment } from './doc';
import { componentStarts, resolveAnchorOffset } from './section';
import { newId } from './types';
import type { SectionComponent } from './types';

/**
 * Exits and entrances: the part of a freeway that is not just two roads that happen to touch.
 *
 * Laying a ramp road so it starts on the mainline's centreline leaves the two overlapping for
 * a hundred metres, with lane lines drawn through one another, and nothing says where traffic
 * leaves. A real exit has four visible parts, and this builds all four:
 *
 *   1. a TAPER, a wedge of pavement that widens from nothing into a full lane beside the
 *      outer lane;
 *   2. the PARALLEL LANE, a stretch of mainline with one extra lane on that side (a
 *      deceleration lane for an exit, an acceleration lane for an entrance);
 *   3. the NOSE, where that lane stops being part of the mainline and becomes the ramp;
 *   4. the GORE, the painted wedge between mainline and ramp as they separate.
 *
 * The mainline is split into three roads; the middle one is given a derived asset (the
 * original plus the extra lane, pinned so the centreline does not shift). The ramp is an
 * ordinary one-way road whose first lane is in line with that extra lane, so the pavement is
 * continuous across the nose. Taper and gore are stored as patches.
 *
 * An entrance is the same shape run backwards: the ramp arrives at the nose, the added lane
 * runs alongside, and the taper is where that lane ends.
 *
 * All the arithmetic is in the metre plane at the exit (geo/crs.ts), in the frame of
 * travel: `u` along the direction traffic moves on the chosen side, `v` to its right.
 */

export type RampKind = 'exit' | 'entrance';

export interface RampOptions {
  kind: RampKind;
  /** Which side of the drawn line the ramp is on. */
  side: 'right' | 'left';
  /** Length of the parallel lane, in metres. */
  laneRunMetres?: number;
  /** Length over which the lane widens from nothing, in metres. */
  taperMetres?: number;
  /** How far the ramp stub extends from the nose, in metres. */
  rampLengthMetres?: number;
  /** How far sideways the end of the stub is from the lane, in metres. */
  rampSpreadMetres?: number;
}

export const RAMP_DEFAULTS = {
  laneRunMetres: 140,
  taperMetres: 60,
  rampLengthMetres: 170,
  rampSpreadMetres: 45,
} as const;

/** Where the painted gore stops being drawn: when ramp and mainline are this far apart. */
const GORE_WIDTH_METRES = 7;

/** How long the ramp runs parallel before it starts to bend away, in metres. */
const RAMP_HANDLE_METRES = 80;

export interface RampResult {
  doc: Doc;
  assets: Asset[];
  /** The new ramp road. */
  rampSegmentId: string;
  /** Its far end, free for the next road to be drawn from. */
  freeNodeId: string;
  /** For previews: the ramp centreline and the outline of every patch added. */
  preview: { ramp: LngLat[]; lane: LngLat[]; patches: LngLat[][] };
}

export type RampOutcome = RampResult | { error: string };

// ------------------------------------------------------------------- plane geometry

const sub = (a: PlanePoint, b: PlanePoint): PlanePoint => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: PlanePoint, b: PlanePoint): PlanePoint => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: PlanePoint, k: number): PlanePoint => ({ x: a.x * k, y: a.y * k });
const len = (a: PlanePoint) => Math.hypot(a.x, a.y);
const unit = (a: PlanePoint): PlanePoint => {
  const l = len(a);
  return l < 1e-12 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
};
/** Right-hand normal of a direction (y north, x east). */
const right = (t: PlanePoint): PlanePoint => ({ x: t.y, y: -t.x });

function cumulative(pts: readonly PlanePoint[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1]! + len(sub(pts[i]!, pts[i - 1]!)));
  return out;
}

/** The point at distance `s` along a polyline. */
function pointAt(pts: readonly PlanePoint[], cum: readonly number[], s: number): PlanePoint {
  const total = cum[cum.length - 1]!;
  const clamped = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < clamped) i++;
  const a = pts[i - 1]!;
  const b = pts[i]!;
  const span = cum[i]! - cum[i - 1]!;
  const t = span < 1e-12 ? 0 : (clamped - cum[i - 1]!) / span;
  return add(a, mul(sub(b, a), t));
}

/** Unit tangent at `s`, taken across a short window so a vertex does not kink it. */
function tangentAt(pts: readonly PlanePoint[], cum: readonly number[], s: number): PlanePoint {
  const total = cum[cum.length - 1]!;
  const lo = Math.max(0, s - 2);
  const hi = Math.min(total, s + 2);
  return unit(sub(pointAt(pts, cum, hi), pointAt(pts, cum, lo)));
}

/** Distance along the polyline of the point nearest `q`. */
function nearestS(pts: readonly PlanePoint[], cum: readonly number[], q: PlanePoint): number {
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const d = sub(b, a);
    const l2 = d.x * d.x + d.y * d.y;
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((q.x - a.x) * d.x + (q.y - a.y) * d.y) / l2));
    const p = add(a, mul(d, t));
    const dist = len(sub(q, p));
    if (dist < best) {
      best = dist;
      bestS = cum[i]! + t * Math.sqrt(l2);
    }
  }
  return bestS;
}

/** The part of a polyline between two distances, with exact ends. */
function slice(
  pts: readonly PlanePoint[],
  cum: readonly number[],
  s0: number,
  s1: number,
): PlanePoint[] {
  const out = [pointAt(pts, cum, s0)];
  for (let i = 0; i < pts.length; i++) {
    if (cum[i]! > s0 + 1e-6 && cum[i]! < s1 - 1e-6) out.push(pts[i]!);
  }
  out.push(pointAt(pts, cum, s1));
  return out;
}

/** Sample positions across a range: both ends, plus every vertex and a regular step between. */
function samples(cum: readonly number[], lo: number, hi: number, step = 6): number[] {
  const set = new Set<number>([lo, hi]);
  for (const c of cum) if (c > lo && c < hi) set.add(c);
  const n = Math.max(1, Math.ceil((hi - lo) / step));
  for (let i = 1; i < n; i++) set.add(lo + ((hi - lo) * i) / n);
  return [...set].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------- assets

/**
 * Whether a component carries traffic in a direction.
 *
 * Not the same as being paved: shoulders, barriers and medians are all "roadway" to the
 * renderer, but a lane is what a ramp peels off from, so it is the outermost LANE that sets
 * where the extra lane goes and which way traffic runs on that side.
 */
const isLane = (c: SectionComponent): boolean =>
  PRIMITIVES[c.componentType].isRoadway && (c.direction === 'forward' || c.direction === 'backward' || c.direction === 'both');

const laneIndexes = (asset: LineAsset): number[] =>
  asset.components.map((c, i) => (isLane(c) ? i : -1)).filter((i) => i >= 0);

/** Distance from the drawn line to the outer edge of the outermost lane on one side. */
function pavedEdge(asset: LineAsset, side: 'left' | 'right'): number | null {
  const starts = componentStarts(asset.components);
  const anchor = resolveAnchorOffset(asset);
  const lanes = laneIndexes(asset);
  if (lanes.length === 0) return null;
  if (side === 'right') {
    const i = lanes[lanes.length - 1]!;
    return starts[i]! + asset.components[i]!.widthMeters - anchor;
  }
  return anchor - starts[lanes[0]!]!;
}

/** The lanes that can be added beside a road's outermost lane. */
export type ExtraLane = 'decelerationLane' | 'accelerationLane' | 'turnPocket' | 'auxiliaryLane';

const LANE_NAMES: Record<ExtraLane, string> = {
  decelerationLane: 'exit lane',
  accelerationLane: 'entrance lane',
  turnPocket: 'turn lane',
  auxiliaryLane: 'auxiliary lane',
};

/** The asset with one more lane on a side, drawn along the same line as the original. */
function withLane(
  base: LineAsset,
  side: 'left' | 'right',
  type: ExtraLane,
  assets: Asset[],
): { asset: LineAsset; assets: Asset[] } {
  const id = `${base.id}~${type}-${side}`;
  const existing = assets.find((a) => a.id === id);
  if (existing && isLineAsset(existing)) return { asset: existing, assets };

  const width = PRIMITIVES[type].defaultWidthMeters;
  const lanes = laneIndexes(base);
  const outer = side === 'right' ? lanes[lanes.length - 1]! : lanes[0]!;
  const lane: SectionComponent = {
    id: newId('c'),
    componentType: type,
    widthMeters: width,
    direction: base.components[outer]!.direction === 'backward' ? 'backward' : 'forward',
  };

  const at = side === 'right' ? outer + 1 : outer;
  const components = [...base.components.slice(0, at), lane, ...base.components.slice(at)];
  const anchor = resolveAnchorOffset(base);
  const asset: LineAsset = {
    ...base,
    id,
    name: `${base.name} + ${LANE_NAMES[type]} (${side})`,
    components,
    // Pinned, so the drawn line stays where it was. Left-hand additions push the left edge out.
    anchorOffsetMeters: side === 'left' ? anchor + width : anchor,
  };
  delete asset.builtIn;
  return { asset, assets: [...assets, asset] };
}

/** A one-lane ramp with its shoulder on the outer side. */
function rampAsset(
  outerOnRight: boolean,
  width: number,
  assets: Asset[],
): { asset: LineAsset; assets: Asset[] } {
  const id = `${outerOnRight ? 'ramp-lane-right' : 'ramp-lane-left'}-${width.toFixed(2)}`;
  const existing = assets.find((a) => a.id === id);
  if (existing && isLineAsset(existing)) return { asset: existing, assets };

  const lane: SectionComponent = {
    id: newId('c'),
    componentType: 'rampLane',
    // The same width as the lane it continues, so the pavement does not step at the nose.
    widthMeters: width,
    direction: 'forward',
  };
  const shoulder: SectionComponent = {
    id: newId('c'),
    componentType: 'shoulder',
    widthMeters: 2.4,
    direction: 'none',
  };
  const asset: LineAsset = {
    id,
    name: 'Ramp lane',
    kind: 'line',
    family: 'highway',
    components: outerOnRight ? [lane, shoulder] : [shoulder, lane],
    anchorOffsetMeters: null,
  };
  return { asset, assets: [...assets, asset] };
}

// ------------------------------------------------------------------------- the build

const toLngLat = (plane: ReturnType<typeof localPlane>, pts: readonly PlanePoint[]): LngLat[] =>
  pts.map((p) => plane.toLngLat(p));

/**
 * Build an exit or entrance on a mainline road.
 *
 * `at` is where the NOSE goes: the point where the extra lane stops being the mainline's and
 * becomes the ramp's (for an exit) or where the ramp's lane starts running alongside (for an
 * entrance). Returns the new document, or says why it cannot.
 */
export function addRamp(
  doc: Doc,
  assets: readonly Asset[],
  mainSegmentId: string,
  at: LngLat,
  options: RampOptions,
): RampOutcome {
  const segment = doc.segments.find((s) => s.id === mainSegmentId);
  if (!segment) return { error: 'That road no longer exists.' };
  const base = assets.find((a) => a.id === segment.assetId);
  if (!base || !isLineAsset(base)) return { error: 'That road has no cross-section to add a lane to.' };

  const nodes = nodeMap(doc);
  const from = nodes.get(segment.fromNodeId);
  const to = nodes.get(segment.toNodeId);
  if (!from || !to) return { error: 'That road is missing an end.' };
  if ((from.elevation ?? 0) !== (to.elevation ?? 0)) {
    return { error: 'Ramps cannot be added to a road that climbs; use a level stretch.' };
  }

  const controls = segmentControlPoints(segment, nodes);
  if (!controls) return { error: 'That road is missing an end.' };
  const line = dedupe(resolveCenterline({ id: segment.id, centerline: controls, curve: segment.curve }));
  if (line.length < 2) return { error: 'That road is too short.' };

  const plane = localPlane(at);
  const pts = line.map((p) => plane.toPlane(p));
  const cum = cumulative(pts);
  const total = cum[cum.length - 1]!;

  const reversed = segment.reversed === true;
  const sigma = options.side === 'right' ? 1 : -1;
  const assetSide: 'left' | 'right' = sigma > 0 !== reversed ? 'right' : 'left';

  const e = pavedEdge(base, assetSide);
  if (e === null) return { error: 'That road has no traffic lanes.' };

  const lanes = laneIndexes(base);
  const outerComponent = base.components[assetSide === 'right' ? lanes[lanes.length - 1]! : lanes[0]!]!;
  // Which way traffic moves on this side, as a sign along the drawn line.
  const tau = (outerComponent.direction === 'backward' ? -1 : 1) * (reversed ? -1 : 1);
  const sideTravel = sigma * tau;

  const run = options.laneRunMetres ?? RAMP_DEFAULTS.laneRunMetres;
  const taper = options.taperMetres ?? RAMP_DEFAULTS.taperMetres;
  const rampLength = options.rampLengthMetres ?? RAMP_DEFAULTS.rampLengthMetres;
  const spread = options.rampSpreadMetres ?? RAMP_DEFAULTS.rampSpreadMetres;

  const isExit = options.kind === 'exit';
  const laneType = isExit ? 'decelerationLane' : 'accelerationLane';
  const wLane = PRIMITIVES[laneType].defaultWidthMeters;

  // Where the nose is, and the stretch with the extra lane.
  const nose = nearestS(pts, cum, plane.toPlane(at));
  const noseAtB = (isExit && tau > 0) || (!isExit && tau < 0);
  const a = noseAtB ? nose - run : nose;
  const b = noseAtB ? nose : nose + run;
  const wedgeLo = noseAtB ? a - taper : b;
  const wedgeHi = noseAtB ? a : b + taper;

  const lo = Math.min(a, wedgeLo);
  const hi = Math.max(b, wedgeHi);
  if (lo < 1 || hi > total - 1) {
    const needed = Math.round(hi - lo);
    return {
      error: `Not enough room on this stretch of road: the ${options.kind} needs ${needed} m clear of its ends and of other junctions, and this stretch is ${Math.round(total)} m. Choose a longer stretch or a spot further from its ends.`,
    };
  }

  // ---- assets
  const variant = withLane(base, assetSide, laneType, [...assets]);
  const ramp = rampAsset(sideTravel > 0, wLane, variant.assets);

  // ---- the frame at the nose, in travel terms
  const fNose = pointAt(pts, cum, nose);
  const tvec = mul(tangentAt(pts, cum, nose), tau);
  const rvec = right(tvec);
  const lambda0 = sideTravel * (e + wLane / 2);
  const laneCentre = add(fNose, mul(rvec, lambda0));

  const dir = isExit ? 1 : -1;
  const handle = add(laneCentre, mul(tvec, dir * RAMP_HANDLE_METRES));
  const farEnd = add(add(laneCentre, mul(tvec, dir * rampLength)), mul(rvec, sideTravel * spread));

  // ---- split the mainline into three roads
  let next: Doc = { ...doc, segments: doc.segments.filter((s) => s.id !== segment.id) };
  const elevation = from.elevation ?? 0;
  const mkNode = (p: PlanePoint, role?: 'rampNose') => {
    const added = addNode(next, plane.toLngLat(p));
    next = added.doc;
    if (elevation) next = setElevation(next, added.nodeId, elevation);
    if (role) {
      next = { ...next, nodes: next.nodes.map((n) => (n.id === added.nodeId ? { ...n, role } : n)) };
    }
    return added.nodeId;
  };

  const nodeA = mkNode(pointAt(pts, cum, a));
  const nodeB = mkNode(pointAt(pts, cum, b));

  const piece = (
    s0: number,
    s1: number,
    fromId: string,
    toId: string,
    assetId: string,
  ): Segment => {
    const mid = slice(pts, cum, s0, s1).slice(1, -1);
    const built = addSegment(next, {
      assetId,
      name: segment.name,
      fromNodeId: fromId,
      toNodeId: toId,
      shape: toLngLat(plane, mid),
      reversed: segment.reversed,
      visible: segment.visible,
    });
    next = built.doc;
    return next.segments.find((s) => s.id === built.segmentId)!;
  };
  piece(0, a, segment.fromNodeId, nodeA, base.id);
  piece(a, b, nodeA, nodeB, variant.asset.id);
  piece(b, total, nodeB, segment.toNodeId, base.id);

  // ---- the ramp road
  const noseId = mkNode(laneCentre, 'rampNose');
  const farId = mkNode(farEnd);
  const startId = isExit ? noseId : farId;
  const endId = isExit ? farId : noseId;
  const rampBuilt = addSegment(next, {
    assetId: ramp.asset.id,
    fromNodeId: startId,
    toNodeId: endId,
    shape: [plane.toLngLat(handle)],
    curve: { mode: 'bezier', radiusMeters: 12 },
  });
  next = rampBuilt.doc;
  const rampId = rampBuilt.segmentId;

  // ---- patches
  const deck = elevation < 0 ? -1 : elevation > 0 ? 1 : 0;
  const patches: Patch[] = [];
  const outlines: LngLat[][] = [];
  const addPatch = (kind: Patch['kind'], ring: PlanePoint[]) => {
    if (ring.length < 3) return;
    const lngLat = toLngLat(plane, ring);
    patches.push({ id: newPatchId(), kind, ring: lngLat, deck, ownerId: rampId });
    outlines.push(lngLat);
  };

  // The taper: a wedge that widens from nothing to a full lane at the end of the parallel lane.
  {
    const ss = samples(cum, wedgeLo, wedgeHi);
    const fraction = (s: number) => (noseAtB ? (s - wedgeLo) / taper : 1 - (s - wedgeLo) / taper);
    const frameN = (s: number) => right(tangentAt(pts, cum, s));
    const edgeA = ss.map((s) => add(pointAt(pts, cum, s), mul(frameN(s), sigma * e)));
    const edgeB = ss.map((s) =>
      add(pointAt(pts, cum, s), mul(frameN(s), sigma * (e + wLane * fraction(s)))),
    );
    addPatch('taper', [...edgeA, ...[...edgeB].reverse()]);

    // A thin white line along the slanted edge, where the lane line shifts out.
    const half = 0.075;
    const outer = ss.map((s, i) => add(edgeB[i]!, mul(frameN(s), sigma * half)));
    const inner = ss.map((s, i) => sub(edgeB[i]!, mul(frameN(s), sigma * half)));
    addPatch('paint', [...outer, ...[...inner].reverse()]);
  }

  // The gore: between the mainline's outer edge and the ramp's inner edge, from the nose
  // until they are far enough apart to leave unpainted.
  {
    const rampLine = tessellate(
      [plane.toLngLat(laneCentre), plane.toLngLat(handle), plane.toLngLat(farEnd)],
      { mode: 'bezier', radiusMeters: 12 },
    ).map((p) => plane.toPlane(p));

    const wr = wLane;
    const edgeRing: PlanePoint[] = [];
    const rampRing: PlanePoint[] = [];

    for (let i = 0; i < rampLine.length; i++) {
      const c = rampLine[i]!;
      const ahead = rampLine[Math.min(rampLine.length - 1, i + 1)]!;
      const behind = rampLine[Math.max(0, i - 1)]!;
      // Tangent in the direction of travel.
      const outward = unit(sub(ahead, behind));
      const travel = mul(outward, dir);
      const innerPoint = sub(c, mul(right(travel), sideTravel * (wr / 2)));
      const sq = nearestS(pts, cum, innerPoint);
      const edgePoint = add(pointAt(pts, cum, sq), mul(right(tangentAt(pts, cum, sq)), sigma * e));
      const gap = len(sub(innerPoint, edgePoint));
      edgeRing.push(edgePoint);
      rampRing.push(innerPoint);
      if (gap >= GORE_WIDTH_METRES) break;
    }
    addPatch('gore', [...edgeRing, ...[...rampRing].reverse()]);
  }

  next = { ...next, patches: [...next.patches, ...patches] };

  return {
    doc: next,
    assets: ramp.assets,
    rampSegmentId: rampId,
    freeNodeId: farId,
    preview: {
      ramp: tessellate(
        [plane.toLngLat(laneCentre), plane.toLngLat(handle), plane.toLngLat(farEnd)],
        { mode: 'bezier', radiusMeters: 12 },
      ),
      lane: toLngLat(plane, slice(pts, cum, a, b)),
      patches: outlines,
    },
  };
}

/**
 * Which side of a road's drawn line a point is on, for choosing the side a ramp goes.
 *
 * A point exactly on the line counts as the right.
 */
export function sideOfLine(
  doc: Doc,
  segmentId: string,
  point: LngLat,
): 'left' | 'right' | null {
  const segment = doc.segments.find((s) => s.id === segmentId);
  if (!segment) return null;
  const nodes = nodeMap(doc);
  const controls = segmentControlPoints(segment, nodes);
  if (!controls) return null;
  const line = dedupe(resolveCenterline({ id: segment.id, centerline: controls, curve: segment.curve }));
  if (line.length < 2) return null;

  const plane = localPlane(point);
  const pts = line.map((p) => plane.toPlane(p));
  const cum = cumulative(pts);
  const q = plane.toPlane(point);
  const s = nearestS(pts, cum, q);
  const t = tangentAt(pts, cum, s);
  const offset = sub(q, pointAt(pts, cum, s));
  return offset.x * right(t).x + offset.y * right(t).y >= 0 ? 'right' : 'left';
}

// ------------------------------------------------------------------ turn and auxiliary lanes

export interface LaneOptions {
  side: 'right' | 'left';
  /** A turn pocket belongs on an approach to a junction; an auxiliary lane can go anywhere. */
  laneType?: 'turnPocket' | 'auxiliaryLane';
  /** Length of the added lane, from the end of the road, in metres. */
  runMetres?: number;
  /** Length of the taper that leads into it, in metres. */
  taperMetres?: number;
}

export const LANE_DEFAULTS = { runMetres: 45, taperMetres: 25 } as const;

export interface LaneResult {
  doc: Doc;
  assets: Asset[];
  /** The stretch of road that now has the extra lane. */
  segmentId: string;
  preview: { lane: LngLat[]; patches: LngLat[][] };
}

export type LaneOutcome = LaneResult | { error: string };

/**
 * Add a lane to the end of a road: a turn pocket at an approach, or an auxiliary lane.
 *
 * `at` picks the end (the nearer one) and `side` the side. The road is split where the lane
 * starts; the end piece gets the derived asset with the extra lane, and a taper leads into
 * it from the road before, so the pavement widens rather than stepping.
 */
export function addLane(
  doc: Doc,
  assets: readonly Asset[],
  segmentId: string,
  at: LngLat,
  options: LaneOptions,
): LaneOutcome {
  const segment = doc.segments.find((s) => s.id === segmentId);
  if (!segment) return { error: 'That road no longer exists.' };
  const base = assets.find((a) => a.id === segment.assetId);
  if (!base || !isLineAsset(base)) return { error: 'That road has no cross-section to add a lane to.' };

  const nodes = nodeMap(doc);
  const fromNode = nodes.get(segment.fromNodeId);
  const toNode = nodes.get(segment.toNodeId);
  if (!fromNode || !toNode) return { error: 'That road is missing an end.' };
  if ((fromNode.elevation ?? 0) !== (toNode.elevation ?? 0)) {
    return { error: 'Lanes cannot be added to a road that climbs; use a level stretch.' };
  }
  const controls = segmentControlPoints(segment, nodes);
  if (!controls) return { error: 'That road is missing an end.' };
  const line = dedupe(resolveCenterline({ id: segment.id, centerline: controls, curve: segment.curve }));
  if (line.length < 2) return { error: 'That road is too short.' };

  const plane = localPlane(at);
  const pts = line.map((p) => plane.toPlane(p));
  const cum = cumulative(pts);
  const total = cum[cum.length - 1]!;

  const reversed = segment.reversed === true;
  const sigma = options.side === 'right' ? 1 : -1;
  const assetSide: 'left' | 'right' = sigma > 0 !== reversed ? 'right' : 'left';
  const e = pavedEdge(base, assetSide);
  if (e === null) return { error: 'That road has no traffic lanes.' };
  const lanes = laneIndexes(base);
  const outer = base.components[assetSide === 'right' ? lanes[lanes.length - 1]! : lanes[0]!]!;
  const tau = (outer.direction === 'backward' ? -1 : 1) * (reversed ? -1 : 1);

  const laneType = options.laneType ?? 'turnPocket';
  const run = options.runMetres ?? LANE_DEFAULTS.runMetres;
  const taper = options.taperMetres ?? LANE_DEFAULTS.taperMetres;
  const wLane = PRIMITIVES[laneType].defaultWidthMeters;

  const atEnd: 'from' | 'to' = nearestS(pts, cum, plane.toPlane(at)) < total / 2 ? 'from' : 'to';
  const arrivalEnd: 'from' | 'to' = tau > 0 ? 'to' : 'from';
  if (laneType === 'turnPocket' && atEnd !== arrivalEnd) {
    return {
      error:
        'Traffic on that side leaves this junction, so a turn lane goes at the other end of the road, or on the other side.',
    };
  }
  if (run + taper > total - 1) {
    return {
      error: `Not enough room: the lane and its taper need ${Math.round(run + taper)} m and this stretch of road is ${Math.round(total)} m.`,
    };
  }

  const variant = withLane(base, assetSide, laneType, [...assets]);

  // The lane's stretch, and the wedge before it (or after it, from the start end).
  const [laneLo, laneHi] = atEnd === 'to' ? [total - run, total] : [0, run];
  const [wedgeLo, wedgeHi] = atEnd === 'to' ? [laneLo - taper, laneLo] : [laneHi, laneHi + taper];
  const split = atEnd === 'to' ? laneLo : laneHi;

  let next: Doc = { ...doc, segments: doc.segments.filter((s) => s.id !== segment.id) };
  const elevation = fromNode.elevation ?? 0;
  const added = addNode(next, plane.toLngLat(pointAt(pts, cum, split)));
  next = added.doc;
  if (elevation) next = setElevation(next, added.nodeId, elevation);

  const make = (s0: number, s1: number, a: string, b: string, assetId: string): string => {
    const built = addSegment(next, {
      assetId,
      name: segment.name,
      fromNodeId: a,
      toNodeId: b,
      shape: toLngLat(plane, slice(pts, cum, s0, s1).slice(1, -1)),
      reversed: segment.reversed,
      visible: segment.visible,
    });
    next = built.doc;
    return built.segmentId;
  };

  let laneSegmentId: string;
  if (atEnd === 'to') {
    make(0, split, segment.fromNodeId, added.nodeId, base.id);
    laneSegmentId = make(split, total, added.nodeId, segment.toNodeId, variant.asset.id);
  } else {
    laneSegmentId = make(0, split, segment.fromNodeId, added.nodeId, variant.asset.id);
    make(split, total, added.nodeId, segment.toNodeId, base.id);
  }

  // The taper: nothing at its far end, a full lane where the lane begins.
  const deck = elevation < 0 ? -1 : elevation > 0 ? 1 : 0;
  const ss = samples(cum, wedgeLo, wedgeHi, 5);
  const fraction = (s: number) => (atEnd === 'to' ? (s - wedgeLo) / taper : 1 - (s - wedgeLo) / taper);
  const normalAt = (s: number) => right(tangentAt(pts, cum, s));
  const edgeA = ss.map((s) => add(pointAt(pts, cum, s), mul(normalAt(s), sigma * e)));
  const edgeB = ss.map((s) =>
    add(pointAt(pts, cum, s), mul(normalAt(s), sigma * (e + wLane * fraction(s)))),
  );
  const half = 0.075;
  const lineOuter = ss.map((s, i) => add(edgeB[i]!, mul(normalAt(s), sigma * half)));
  const lineInner = ss.map((s, i) => sub(edgeB[i]!, mul(normalAt(s), sigma * half)));

  const rings: [Patch['kind'], PlanePoint[]][] = [
    ['taper', [...edgeA, ...[...edgeB].reverse()]],
    ['paint', [...lineOuter, ...[...lineInner].reverse()]],
  ];
  const patches: Patch[] = rings.map(([kind, ring]) => ({
    id: newPatchId(),
    kind,
    ring: toLngLat(plane, ring),
    deck,
    ownerId: laneSegmentId,
  }));
  next = { ...next, patches: [...next.patches, ...patches] };

  return {
    doc: next,
    assets: variant.assets,
    segmentId: laneSegmentId,
    preview: {
      lane: toLngLat(plane, slice(pts, cum, laneLo, laneHi)),
      patches: patches.map((p) => p.ring),
    },
  };
}

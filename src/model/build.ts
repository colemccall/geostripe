import { splitBezierAt } from '../geo/curve';
import { resolveCenterline } from '../geo/curve';
import { dedupe, localPlane, originFor } from '../geo/projection';
import type { LngLat, LocalPlane, PlanePoint } from '../geo/projection';
import { distanceMeters } from '../geo/measure';
import {
  addSegment,
  newSegmentId,
  nodeMap,
  segmentControlPoints,
  segmentElevation,
  splitPointFor,
  splitSegment,
} from './doc';
import type { Doc, Segment } from './doc';

/**
 * Laying a road through whatever is already there.
 *
 * This is the move a road-building game makes that nothing here did, and it is the reason
 * building felt worse than drawing: crossing an existing road left the two merely
 * overlapping. You had to notice the crossing yourself and click exactly on it, which turns
 * the most ordinary thing you do — run a street across the grid — into an aiming exercise.
 *
 * A road drawn across another now splits both of them and shares a node, every time, with no
 * click needed at the crossing. Nothing here is a tolerance or a guess: the crossing point is
 * computed from the two lines and lies exactly on both, so this is not the old detector
 * coming back. It is the difference between "these two lines cross" — a fact — and "these
 * two roads were probably meant to meet", which is what the old model was guessing at.
 *
 * Roads at different heights pass each other untouched, which is what makes an overpass an
 * overpass. Since height lives on the node, the new road's height is whatever you were
 * building at, and there is no way for the two ends of a crossing to disagree about it.
 */

/** How finely the new road is sampled when looking for crossings. */
const SAMPLES = 96;

/** Two crossings closer together than this are the same place, and get one node. */
const MERGE_METRES = 2;

/** A crossing this close to the road's own end is that end, not a new node. */
const END_METRES = 2;

export interface LayRoadInput {
  assetId: string;
  fromNodeId: string;
  toNodeId: string;
  /** Bezier handles between the two ends. Empty for a straight road. */
  handles: LngLat[];
  curved: boolean;
  /** Height the new road is being built at, which its crossings must match to connect. */
  elevation: number;
}

export interface LayRoadResult {
  doc: Doc;
  segmentIds: string[];
  /** How many existing roads it cut through. Worth telling the user about. */
  crossings: number;
}

interface Crossing {
  /** Parameter along the new road, 0 at the start and 1 at the end. */
  t: number;
  point: LngLat;
  /** The segment being crossed, as it was before anything was split. */
  segmentId: string;
}

/** Where two planar edges properly cross, as parameters along each, or null. */
function edgeCrossing(
  a0: PlanePoint,
  a1: PlanePoint,
  b0: PlanePoint,
  b1: PlanePoint,
): { t: number; u: number } | null {
  const rx = a1.x - a0.x;
  const ry = a1.y - a0.y;
  const sx = b1.x - b0.x;
  const sy = b1.y - b0.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qpx = b0.x - a0.x;
  const qpy = b0.y - a0.y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** Sample the new road at even parameter steps, so each hit carries a usable `t`. */
function sampleRoad(controls: readonly PlanePoint[], curved: boolean): PlanePoint[] {
  if (!curved || controls.length < 3) return [...controls];
  const out: PlanePoint[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    out.push(pointOnBezier(controls, i / SAMPLES));
  }
  return out;
}

function pointOnBezier(points: readonly PlanePoint[], t: number): PlanePoint {
  let current = points.map((p) => ({ x: p.x, y: p.y }));
  while (current.length > 1) {
    const next: PlanePoint[] = [];
    for (let i = 0; i < current.length - 1; i++) {
      const a = current[i]!;
      const b = current[i + 1]!;
      next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    current = next;
  }
  return current[0]!;
}

/** Everything the new road crosses, in the order it meets them. */
function findCrossings(
  doc: Doc,
  plane: LocalPlane,
  samples: readonly PlanePoint[],
  sampleT: readonly number[],
  elevation: number,
  endpoints: readonly LngLat[],
): Crossing[] {
  const nodes = nodeMap(doc);
  const out: Crossing[] = [];

  for (const segment of doc.segments) {
    if (segment.visible === false) continue;
    // Roads at different heights pass each other. Nothing meets, nothing is cut.
    if (segmentElevation(segment, nodes) !== elevation) continue;

    const controls = segmentControlPoints(segment, nodes);
    if (!controls) continue;
    const line = dedupe(
      resolveCenterline({ id: segment.id, centerline: controls, curve: segment.curve }),
    );
    if (line.length < 2) continue;
    const planar = line.map((p) => plane.toPlane(p));

    for (let i = 0; i < samples.length - 1; i++) {
      for (let j = 0; j < planar.length - 1; j++) {
        const hit = edgeCrossing(samples[i]!, samples[i + 1]!, planar[j]!, planar[j + 1]!);
        if (!hit) continue;

        const a = samples[i]!;
        const b = samples[i + 1]!;
        const point = plane.toLngLat({
          x: a.x + (b.x - a.x) * hit.t,
          y: a.y + (b.y - a.y) * hit.t,
        });

        // A crossing at the road's own end is the node it already has.
        if (endpoints.some((e) => distanceMeters(e, point) < END_METRES)) continue;

        const t0 = sampleT[i]!;
        const t1 = sampleT[i + 1]!;
        out.push({ t: t0 + (t1 - t0) * hit.t, point, segmentId: segment.id });
      }
    }
  }

  out.sort((a, b) => a.t - b.t);

  // Three roads meeting within a metre produce several pairwise hits at one place. One node.
  const merged: Crossing[] = [];
  for (const crossing of out) {
    const previous = merged[merged.length - 1];
    if (previous && distanceMeters(previous.point, crossing.point) < MERGE_METRES) continue;
    merged.push(crossing);
  }
  return merged;
}

/**
 * Split a road at a point, following it through earlier splits.
 *
 * A road crossed twice is split twice, and the second cut belongs to whichever half now
 * contains it. Tracking the descendants is what keeps that straight — without it the second
 * split would look for a segment that no longer exists.
 */
function splitDescendant(
  doc: Doc,
  family: string[],
  position: LngLat,
): { doc: Doc; nodeId: string; family: string[] } | null {
  const nodes = nodeMap(doc);
  let best: { segment: Segment; shapeIndex: number; point: LngLat; distance: number } | null =
    null;

  for (const id of family) {
    const segment = doc.segments.find((s) => s.id === id);
    if (!segment) continue;
    const at = splitPointFor(segment, nodes, position);
    if (!at) continue;
    const distance = distanceMeters(at.point, position);
    if (!best || distance < best.distance) {
      best = { segment, shapeIndex: at.shapeIndex, point: at.point, distance };
    }
  }

  if (!best) return null;
  const split = splitSegment(doc, best.segment.id, position, best.shapeIndex);
  if (!split) return null;

  return {
    doc: split.doc,
    nodeId: split.nodeId,
    family: [...family.filter((id) => id !== best!.segment.id), ...split.segmentIds],
  };
}

/**
 * Lay one road, splitting it and everything it crosses.
 *
 * The new road comes out as a CHAIN of segments rather than one, which is the same thing
 * that happens to the roads it cuts through and for the same reason: a road that runs
 * through a junction without stopping there is not connected to it.
 */
export function layRoad(doc: Doc, input: LayRoadInput): LayRoadResult {
  const nodes = nodeMap(doc);
  const from = nodes.get(input.fromNodeId);
  const to = nodes.get(input.toNodeId);
  if (!from || !to) return { doc, segmentIds: [], crossings: 0 };

  const controls: LngLat[] = [from.position, ...input.handles, to.position];
  const curved = input.curved && input.handles.length > 0;
  const plane = localPlane(originFor(controls));
  const planarControls = controls.map((p) => plane.toPlane(p));

  const samples = sampleRoad(planarControls, curved);
  const sampleT = curved
    ? samples.map((_, i) => i / SAMPLES)
    : samples.map((_, i) => i / Math.max(1, samples.length - 1));

  const crossings = findCrossings(doc, plane, samples, sampleT, input.elevation, [
    from.position,
    to.position,
  ]);

  // Nothing in the way: one segment, the ordinary case.
  if (crossings.length === 0) {
    const built = addSegment(doc, {
      assetId: input.assetId,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      shape: input.handles,
      curve: curved ? { mode: 'bezier', radiusMeters: 12 } : undefined,
    });
    return { doc: built.doc, segmentIds: [built.segmentId], crossings: 0 };
  }

  // Cut every road that is in the way, keeping the node each cut produced.
  let next = doc;
  const families = new Map<string, string[]>();
  const nodeIds: string[] = [];

  for (const crossing of crossings) {
    const family = families.get(crossing.segmentId) ?? [crossing.segmentId];
    const split = splitDescendant(next, family, crossing.point);
    if (!split) {
      nodeIds.push('');
      continue;
    }
    next = split.doc;
    families.set(crossing.segmentId, split.family);
    nodeIds.push(split.nodeId);
  }

  // Cut the new road at the same places. Each split reparametrises what is left, so the
  // next cut is measured against the remainder rather than against the original curve.
  const pieces: PlanePoint[][] = [];
  let remaining = planarControls;
  let consumed = 0;

  for (const crossing of crossings) {
    const local = (crossing.t - consumed) / (1 - consumed);
    if (!(local > 0 && local < 1)) continue;
    if (curved) {
      const cut = splitBezierAt(remaining, local);
      pieces.push(cut.left);
      remaining = cut.right;
    } else {
      const point = pointOnBezier(remaining, local);
      pieces.push([remaining[0]!, point]);
      remaining = [point, remaining[remaining.length - 1]!];
    }
    consumed = crossing.t;
  }
  pieces.push(remaining);

  const chain = [input.fromNodeId, ...nodeIds.filter(Boolean), input.toNodeId];
  const segmentIds: string[] = [];

  pieces.forEach((piece, i) => {
    const startId = chain[i];
    const endId = chain[i + 1];
    if (!startId || !endId || startId === endId) return;

    const built = addSegment(next, {
      id: newSegmentId(),
      assetId: input.assetId,
      fromNodeId: startId,
      toNodeId: endId,
      // Interior control points only: the ends are the nodes.
      shape: piece.slice(1, -1).map((p) => plane.toLngLat(p)),
      curve: curved && piece.length > 2 ? { mode: 'bezier', radiusMeters: 12 } : undefined,
    });
    next = built.doc;
    segmentIds.push(built.segmentId);
  });

  return { doc: next, segmentIds, crossings: crossings.length };
}

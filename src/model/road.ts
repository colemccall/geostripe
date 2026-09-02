import type { CurveSettings } from '../geo/curve';
import type { LngLat } from '../geo/projection';
import type { CrossSection } from './types';
import { newId } from './types';

/**
 * The road network, the way a road-building game models one.
 *
 * GeoStripe's first model was a set of long polylines called streets, with junctions found
 * wherever two of them happened to cross, and junction geometry cut out of the ribbons
 * afterwards with polygon booleans. That model is why intersections have been a fight. It
 * cannot say a road ENDS somewhere. It cannot say two roads are joined — only that they
 * overlap. Two carriageways running side by side never meet because they never cross, and
 * five roads converging get boxed because a box is what you build when you have legs and no
 * idea what they are legs of.
 *
 * This is the other model, and it is not a refinement of the first one:
 *
 *   A NODE is a point you place. It owns the ground where roads meet.
 *   A SEGMENT is a road you draw between exactly two nodes. It owns nothing else.
 *
 * Both are authored. Nothing is detected, nothing is derived, and nothing is ever cut out
 * of anything. Two roads are joined when they share a node, and not otherwise — so joining
 * is something you do, visibly, rather than something the geometry guesses at. Drawing a
 * road onto the middle of an existing one SPLITS it at a new node, which is the move the
 * old model had no way to express and the reason ramps could never properly meet a freeway.
 *
 * A junction's shape then comes from the ends that meet there: each road stops short far
 * enough to clear its neighbours, and the ground between the stopped ends is the junction.
 * Built up from the roads rather than carved out of them, which is both faster and the
 * difference between a fork drawn as a fork and a fork drawn as a hole.
 */

/**
 * A point where roads meet, or where one stops.
 *
 * Position is authoritative: the segments' ends are AT the node, not near it, because they
 * are defined by it. Dragging a node moves every road that touches it, which is what makes
 * an intersection feel like one object.
 */
export interface RoadNode {
  id: string;
  name?: string;
  position: LngLat;
  /**
   * Kerb corner radius at this node, in metres. Absent takes the project default.
   *
   * Belongs to the node rather than to each corner because it is a property of the place —
   * and because a corner has no stable identity of its own once you can add a road to a
   * junction, which is exactly what this model makes easy.
   */
  radiusMeters?: number;
  /**
   * Override what kind of place this is, when the geometry reads it wrong.
   *
   * The forms mean the same thing they do in the geometry: `junction` builds a paved box
   * with kerb corners, `merge` leaves the roads to run into each other, `continuation`
   * joins two roads end to end. Absent works it out from the angles the roads arrive at.
   */
  form?: 'junction' | 'merge' | 'continuation';
}

/**
 * One road, running between exactly two nodes.
 *
 * The shape points are the bend in the middle — the two ends are the nodes and are not
 * repeated here, so moving a node cannot leave a segment behind. That is the invariant the
 * whole model rests on: a segment has no independent ends.
 */
export interface RoadSegment {
  id: string;
  name?: string;
  fromNodeId: string;
  toNodeId: string;
  /** Interior shape points, WGS84. Empty for a straight road. */
  shape: LngLat[];
  curve?: CurveSettings;
  section: CrossSection;
  /** Grade separation, as elsewhere: 0 at grade, +1 over, -1 under. */
  level?: number;
  visible: boolean;
}

export interface RoadNetworkDoc {
  nodes: RoadNode[];
  segments: RoadSegment[];
}

export const emptyRoadNetwork = (): RoadNetworkDoc => ({ nodes: [], segments: [] });

/**
 * What the pointer is over, when a click has to decide what to attach to.
 *
 * Resolved by whatever is doing the picking — the map knows what is under the cursor and
 * at what zoom, and a tolerance in metres would be wrong at every zoom but one. By the time
 * it reaches the model the question is already answered: this node, or partway along this
 * road, or neither.
 */
export type RoadSnap =
  | { kind: 'node'; nodeId: string }
  | { kind: 'segment'; segmentId: string; shapeIndex: number };

/**
 * Where along a road a click falls, as the index of the control edge it landed on.
 *
 * That index is exactly what splitSegment wants: splitting on edge i puts shape[0..i) on
 * the first half and shape[i..] on the second, so a split inherits the bend either side of
 * it rather than straightening the road.
 */
export function splitPointFor(
  segment: RoadSegment,
  nodes: ReadonlyMap<string, RoadNode>,
  position: LngLat,
): { shapeIndex: number; point: LngLat } | null {
  const controls = segmentControlPoints(segment, nodes);
  if (!controls || controls.length < 2) return null;

  const scale = Math.cos((position[1] * Math.PI) / 180);
  let best: { shapeIndex: number; point: LngLat; distance: number } | null = null;

  for (let i = 0; i < controls.length - 1; i++) {
    const a = controls[i]!;
    const b = controls[i + 1]!;
    const dx = (b[0] - a[0]) * scale;
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    const t =
      lenSq <= 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((position[0] - a[0]) * scale * dx + (position[1] - a[1]) * dy) / lenSq),
          );
    const point: LngLat = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const distance = Math.hypot((position[0] - point[0]) * scale, position[1] - point[1]);
    if (!best || distance < best.distance) best = { shapeIndex: i, point, distance };
  }

  return best ? { shapeIndex: best.shapeIndex, point: best.point } : null;
}

/** The full centerline of a segment: its start node, its shape, its end node. */
export function segmentControlPoints(
  segment: RoadSegment,
  nodes: ReadonlyMap<string, RoadNode>,
): LngLat[] | null {
  const from = nodes.get(segment.fromNodeId);
  const to = nodes.get(segment.toNodeId);
  if (!from || !to) return null;
  return [from.position, ...segment.shape, to.position];
}

/** Every segment end that arrives at a node, as (segment, which end). */
export function endsAt(
  nodeId: string,
  segments: readonly RoadSegment[],
): { segment: RoadSegment; end: 'from' | 'to' }[] {
  const out: { segment: RoadSegment; end: 'from' | 'to' }[] = [];
  for (const segment of segments) {
    if (segment.visible === false) continue;
    if (segment.fromNodeId === nodeId) out.push({ segment, end: 'from' });
    // A loop back to the same node contributes both ends, which is correct — it arrives
    // twice, from two directions.
    if (segment.toNodeId === nodeId) out.push({ segment, end: 'to' });
  }
  return out;
}

/** How many roads meet at each node. Nodes with none are orphans and can be swept up. */
export function degrees(doc: RoadNetworkDoc): Map<string, number> {
  const counts = new Map<string, number>(doc.nodes.map((node) => [node.id, 0]));
  for (const segment of doc.segments) {
    if (segment.visible === false) continue;
    counts.set(segment.fromNodeId, (counts.get(segment.fromNodeId) ?? 0) + 1);
    counts.set(segment.toNodeId, (counts.get(segment.toNodeId) ?? 0) + 1);
  }
  return counts;
}

export const newNodeId = (): string => newId('n');
export const newSegmentId = (): string => newId('s');

// -------------------------------------------------------------------------- editing

/**
 * Add a node.
 *
 * Returns a new document — nothing here mutates, so undo stays a matter of keeping the
 * previous object and the memoisation downstream can trust reference identity.
 */
export function addNode(doc: RoadNetworkDoc, position: LngLat, id = newNodeId()): {
  doc: RoadNetworkDoc;
  nodeId: string;
} {
  return { doc: { ...doc, nodes: [...doc.nodes, { id, position }] }, nodeId: id };
}

/** Join two nodes with a road. */
export function addSegment(
  doc: RoadNetworkDoc,
  segment: Omit<RoadSegment, 'id' | 'visible'> & { id?: string; visible?: boolean },
): { doc: RoadNetworkDoc; segmentId: string } {
  const id = segment.id ?? newSegmentId();
  const full: RoadSegment = { ...segment, id, visible: segment.visible ?? true };
  return { doc: { ...doc, segments: [...doc.segments, full] }, segmentId: id };
}

/**
 * Split a road in two at a new node.
 *
 * The move the old model could not make, and the reason a ramp could never properly meet a
 * freeway: joining meant crossing, and crossing meant cutting a hole. Here the freeway
 * genuinely becomes two roads that share a node, and the ramp is a third road at the same
 * node. That is what an interchange is.
 *
 * `t` is the fraction along the segment's control points, so a split inherits the shape on
 * either side of it rather than straightening the road.
 */
export function splitSegment(
  doc: RoadNetworkDoc,
  segmentId: string,
  position: LngLat,
  shapeIndex: number,
): { doc: RoadNetworkDoc; nodeId: string } | null {
  const segment = doc.segments.find((s) => s.id === segmentId);
  if (!segment) return null;

  const nodeId = newNodeId();
  const before = segment.shape.slice(0, shapeIndex);
  const after = segment.shape.slice(shapeIndex);

  const first: RoadSegment = {
    ...segment,
    id: newSegmentId(),
    toNodeId: nodeId,
    shape: before,
    section: { ...segment.section, id: newId('sec') },
  };
  const second: RoadSegment = {
    ...segment,
    id: newSegmentId(),
    fromNodeId: nodeId,
    shape: after,
    section: { ...segment.section, id: newId('sec') },
  };

  return {
    doc: {
      nodes: [...doc.nodes, { id: nodeId, position }],
      segments: [...doc.segments.filter((s) => s.id !== segmentId), first, second],
    },
    nodeId,
  };
}

/** Move a node. Every road that touches it follows, because their ends ARE the node. */
export function moveNode(
  doc: RoadNetworkDoc,
  nodeId: string,
  position: LngLat,
): RoadNetworkDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
  };
}

/**
 * Remove a road, and any node it leaves stranded.
 *
 * A node with nothing attached is not a place, it is a leftover. Sweeping them keeps the
 * document honest about what is actually there — otherwise deleting a few roads quietly
 * accumulates invisible handles that still catch clicks.
 */
export function removeSegment(doc: RoadNetworkDoc, segmentId: string): RoadNetworkDoc {
  const segments = doc.segments.filter((s) => s.id !== segmentId);
  const used = new Set<string>();
  for (const segment of segments) {
    used.add(segment.fromNodeId);
    used.add(segment.toNodeId);
  }
  return { nodes: doc.nodes.filter((node) => used.has(node.id)), segments };
}

/** Remove a node and every road that ran into it. */
export function removeNode(doc: RoadNetworkDoc, nodeId: string): RoadNetworkDoc {
  const segments = doc.segments.filter(
    (s) => s.fromNodeId !== nodeId && s.toNodeId !== nodeId,
  );
  const used = new Set<string>();
  for (const segment of segments) {
    used.add(segment.fromNodeId);
    used.add(segment.toNodeId);
  }
  return { nodes: doc.nodes.filter((node) => used.has(node.id)), segments };
}

/**
 * Merge one node into another, joining everything that met at either.
 *
 * How two roads drawn separately become connected — the thing the derived model could never
 * do for carriageways running side by side, because they never crossed. Here it is an edit:
 * point at one node, point at the other, and they are the same place.
 */
export function mergeNodes(
  doc: RoadNetworkDoc,
  keepId: string,
  absorbId: string,
): RoadNetworkDoc {
  if (keepId === absorbId) return doc;
  const segments = doc.segments
    .map((segment) => ({
      ...segment,
      fromNodeId: segment.fromNodeId === absorbId ? keepId : segment.fromNodeId,
      toNodeId: segment.toNodeId === absorbId ? keepId : segment.toNodeId,
    }))
    // A road whose two ends became the same node has collapsed to nothing.
    .filter((segment) => segment.fromNodeId !== segment.toNodeId);

  return { nodes: doc.nodes.filter((node) => node.id !== absorbId), segments };
}

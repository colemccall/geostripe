import type { CurveSettings } from '../geo/curve';
import type { LngLat } from '../geo/projection';
import { newId } from './types';

/**
 * The document: everything a project is.
 *
 * Two rules, and they are the whole design:
 *
 *   Everything here is AUTHORED. Nothing is detected, inferred, or reconstructed.
 *   Nothing is ever cut out of anything.
 *
 * The editor's first model broke both. Roads were long polylines, and a junction was
 * whatever the geometry noticed when two of them happened to overlap — so two roads could
 * be joined without anybody joining them, and could fail to be joined after being drawn to
 * meet. The shape of the junction was then subtracted out of both roads with polygon
 * booleans, which is slow, and which produces a hole where a fork was wanted.
 *
 * Here a NODE is a place you clicked and a SEGMENT is a road between exactly two nodes.
 * Two roads are joined when they share a node, and not otherwise. Drawing onto the middle
 * of an existing road splits it at a new node, which is the move that makes a ramp able to
 * meet a freeway. A junction has no geometry of its own to compute: the roads run into the
 * node and the node's paved ground is drawn on top of their ragged ends. Z-order does the
 * work a boolean used to.
 */

/**
 * A place where roads meet, or where one stops.
 *
 * The position is authoritative. A segment's ends are AT its nodes rather than near them,
 * because they are defined by them — which is what makes dragging a node move every road
 * that touches it, and makes it impossible for a road to be left behind.
 */
export interface Node {
  id: string;
  name?: string;
  position: LngLat;
  /**
   * Kerb radius here, in metres, overriding what the roads arriving ask for.
   *
   * On the node rather than per corner because a corner has no identity that survives
   * adding a road to the junction — and adding a road to a junction is one click now.
   */
  radiusMeters?: number;
  /** Painted crossings on the approaches, by segment id. Absent means none. */
  crossings?: string[];
}

/**
 * One road, path or trail, running between exactly two nodes.
 *
 * `shape` is the bend in the middle only: the two ends are the nodes and are deliberately
 * NOT repeated here, so there is no way for a segment to disagree with a node about where
 * it ends. That is the invariant everything else rests on.
 *
 * Note what is absent — any description of how wide it is or what it is made of. That lives
 * in the asset, and this only names it. A road is an instance of a type, which is what lets
 * "widen every arterial" be one edit instead of forty.
 */
export interface Segment {
  id: string;
  name?: string;
  assetId: string;
  fromNodeId: string;
  toNodeId: string;
  /** Interior shape points, WGS84. Empty for a straight road. */
  shape: LngLat[];
  curve?: CurveSettings;
  /**
   * Grade separation: 0 at grade, +1 an overpass, -1 a tunnel, and so on.
   *
   * Per segment rather than per road, which is the point. A road that climbs, crosses and
   * comes back down is three segments at three levels — the same way you build one in a
   * road-building game, and the same way one is actually built. There is no separate
   * profile to keep in step with the alignment, because the alignment is already cut into
   * the pieces that differ.
   */
  level?: number;
  /** Drawn against the from-to direction, which flips one-way markings and lane order. */
  reversed?: boolean;
  visible: boolean;
}

/**
 * A shape laid on the ground: a park, a plaza, water, a block of forest.
 *
 * Shares the curve machinery with segments — a park boundary curves for the same reasons a
 * road does — and nothing else.
 */
export interface AreaShape {
  id: string;
  name?: string;
  assetId: string;
  /**
   * Control points of a closed ring, WGS84, first point NOT repeated at the end. Closing
   * is a rendering concern; repeating it here would make every edit keep two copies of one
   * vertex in step.
   */
  ring: LngLat[];
  curve?: CurveSettings;
  visible: boolean;
}

export interface Doc {
  nodes: Node[];
  segments: Segment[];
  areas: AreaShape[];
}

export const emptyDoc = (): Doc => ({ nodes: [], segments: [], areas: [] });

export const newNodeId = (): string => newId('n');
export const newSegmentId = (): string => newId('s');
export const newAreaId = (): string => newId('area');

// --------------------------------------------------------------------------- reading

/** The full centerline of a segment: its start node, its shape, its end node. */
export function segmentControlPoints(
  segment: Segment,
  nodes: ReadonlyMap<string, Node>,
): LngLat[] | null {
  const from = nodes.get(segment.fromNodeId);
  const to = nodes.get(segment.toNodeId);
  if (!from || !to) return null;
  return [from.position, ...segment.shape, to.position];
}

export function nodeMap(doc: Doc): Map<string, Node> {
  return new Map(doc.nodes.map((node) => [node.id, node]));
}

/** Every segment end arriving at a node, as (segment, which end). */
export function endsAt(nodeId: string, segments: readonly Segment[]): {
  segment: Segment;
  end: 'from' | 'to';
}[] {
  const out: { segment: Segment; end: 'from' | 'to' }[] = [];
  for (const segment of segments) {
    if (segment.visible === false) continue;
    if (segment.fromNodeId === nodeId) out.push({ segment, end: 'from' });
    // A loop back to the same node arrives twice, from two directions. Both count.
    if (segment.toNodeId === nodeId) out.push({ segment, end: 'to' });
  }
  return out;
}

/** How many roads meet at each node. Nodes with none are leftovers and get swept. */
export function degrees(doc: Doc): Map<string, number> {
  const counts = new Map<string, number>(doc.nodes.map((node) => [node.id, 0]));
  for (const segment of doc.segments) {
    if (segment.visible === false) continue;
    counts.set(segment.fromNodeId, (counts.get(segment.fromNodeId) ?? 0) + 1);
    counts.set(segment.toNodeId, (counts.get(segment.toNodeId) ?? 0) + 1);
  }
  return counts;
}

/**
 * What the pointer is over, when a click has to decide what to attach to.
 *
 * Resolved by whoever is picking — the map knows what is under the cursor and at what
 * zoom, and a tolerance in metres would be wrong at every zoom but one. By the time it
 * reaches the model the question is already answered: this node, or partway along this
 * road, or open ground.
 */
export type Snap =
  | { kind: 'node'; nodeId: string }
  | { kind: 'segment'; segmentId: string; shapeIndex: number; position: LngLat };

// --------------------------------------------------------------------------- editing
//
// Nothing here mutates. Every operation returns a new document, so undo is a matter of
// keeping the previous one and the render layer can trust reference identity to decide
// what actually changed.

export function addNode(doc: Doc, position: LngLat, id = newNodeId()): {
  doc: Doc;
  nodeId: string;
} {
  return { doc: { ...doc, nodes: [...doc.nodes, { id, position }] }, nodeId: id };
}

export function addSegment(
  doc: Doc,
  segment: Omit<Segment, 'id' | 'visible'> & { id?: string; visible?: boolean },
): { doc: Doc; segmentId: string } {
  const id = segment.id ?? newSegmentId();
  const full: Segment = { ...segment, id, visible: segment.visible ?? true };
  return { doc: { ...doc, segments: [...doc.segments, full] }, segmentId: id };
}

/**
 * Split a road in two at a new node.
 *
 * The move the old model could not make, and the reason a ramp could never properly meet a
 * freeway: there, joining meant crossing and crossing meant cutting a hole. Here the road
 * genuinely becomes two roads sharing a node, and whatever arrives next is a third road at
 * the same node. That is what an interchange is made of, and it is also how a turn lane is
 * made — split fifty metres back and give the stub a different asset.
 *
 * `shapeIndex` is the control edge the click landed on, so each half inherits the bend on
 * its own side rather than being straightened.
 */
export function splitSegment(
  doc: Doc,
  segmentId: string,
  position: LngLat,
  shapeIndex: number,
): { doc: Doc; nodeId: string; segmentIds: [string, string] } | null {
  const segment = doc.segments.find((s) => s.id === segmentId);
  if (!segment) return null;

  const nodeId = newNodeId();
  const first: Segment = {
    ...segment,
    id: newSegmentId(),
    toNodeId: nodeId,
    shape: segment.shape.slice(0, shapeIndex),
  };
  const second: Segment = {
    ...segment,
    id: newSegmentId(),
    fromNodeId: nodeId,
    shape: segment.shape.slice(shapeIndex),
  };

  return {
    doc: {
      ...doc,
      nodes: [...doc.nodes, { id: nodeId, position }],
      segments: [...doc.segments.filter((s) => s.id !== segmentId), first, second],
    },
    nodeId,
    segmentIds: [first.id, second.id],
  };
}

/** Move a node. Every road touching it follows, because their ends ARE the node. */
export function moveNode(doc: Doc, nodeId: string, position: LngLat): Doc {
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
  };
}

/** Drop nodes nothing is attached to. A node with no roads is a leftover, not a place. */
function sweep(doc: Doc): Doc {
  const used = new Set<string>();
  for (const segment of doc.segments) {
    used.add(segment.fromNodeId);
    used.add(segment.toNodeId);
  }
  return { ...doc, nodes: doc.nodes.filter((node) => used.has(node.id)) };
}

export function removeSegment(doc: Doc, segmentId: string): Doc {
  return sweep({ ...doc, segments: doc.segments.filter((s) => s.id !== segmentId) });
}

/** Remove a node and every road that ran into it. */
export function removeNode(doc: Doc, nodeId: string): Doc {
  return sweep({
    ...doc,
    segments: doc.segments.filter((s) => s.fromNodeId !== nodeId && s.toNodeId !== nodeId),
  });
}

/**
 * Merge one node into another, joining everything that met at either.
 *
 * How two roads drawn separately become connected. The derived model could never do this
 * for carriageways running side by side, because they never crossed and crossing was the
 * only way it knew to notice anything. Here it is just an edit: this node and that node are
 * the same place.
 */
export function mergeNodes(doc: Doc, keepId: string, absorbId: string): Doc {
  if (keepId === absorbId) return doc;
  const segments = doc.segments
    .map((segment) => ({
      ...segment,
      fromNodeId: segment.fromNodeId === absorbId ? keepId : segment.fromNodeId,
      toNodeId: segment.toNodeId === absorbId ? keepId : segment.toNodeId,
    }))
    // A road whose two ends became the same node has collapsed to nothing.
    .filter((segment) => segment.fromNodeId !== segment.toNodeId);

  return { ...doc, nodes: doc.nodes.filter((node) => node.id !== absorbId), segments };
}

export function addArea(
  doc: Doc,
  area: Omit<AreaShape, 'id' | 'visible'> & { id?: string; visible?: boolean },
): { doc: Doc; areaId: string } {
  const id = area.id ?? newAreaId();
  const full: AreaShape = { ...area, id, visible: area.visible ?? true };
  return { doc: { ...doc, areas: [...doc.areas, full] }, areaId: id };
}

export function removeArea(doc: Doc, areaId: string): Doc {
  return { ...doc, areas: doc.areas.filter((a) => a.id !== areaId) };
}

/**
 * Where along a road a click falls, as the control edge it landed on.
 *
 * That index is exactly what splitSegment wants: splitting on edge i puts shape[0..i) on
 * the first half and shape[i..] on the second.
 */
export function splitPointFor(
  segment: Segment,
  nodes: ReadonlyMap<string, Node>,
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

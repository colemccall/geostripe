import { dedupe, localPlane, originFor } from '../geo/crs';
import type { LngLat, LocalPlane, PlanePoint } from '../geo/crs';
import { resolveCenterline } from '../geo/curve';
import { circle, difference, pointInRing, ringArea } from '../geo/region';
import type { Region, Ring } from '../geo/region';
import { isLineAsset } from './asset';
import type { Asset } from './asset';
import { nodeMap, segmentControlPoints, segmentElevation } from './doc';
import type { Doc, Segment } from './doc';
import { sectionExtent } from './section';

/**
 * City blocks: the ground enclosed by roads.
 *
 * Zoning a block by hand-tracing its outline is the slow part of land-use work, and the road
 * network already knows where every block is: they are the faces of the planar graph the
 * roads form. This finds them and, given a click, returns the ground of the block under it
 * with the roads themselves cut away, so a fill stops at the kerb rather than at the
 * centreline.
 *
 * Only roads at ground level bound a block. A bridge or a tunnel passes over or under one
 * and does not close it.
 */

interface HalfEdge {
  segment: Segment;
  from: string;
  to: string;
  /** The road's drawn line, oriented from `from` to `to`. */
  line: LngLat[];
  twin: HalfEdge | null;
  /** Bearing leaving `from`, radians, counter-clockwise from east. */
  angle: number;
  visited: boolean;
}

export interface Face {
  /** The face's boundary, running along road centrelines, counter-clockwise. */
  ring: LngLat[];
  /** Square metres inside the centrelines. */
  areaSquareMetres: number;
}

/** Direction a line leaves its start, taken a few metres along so a tight curve is stable. */
function leavingAngle(line: readonly LngLat[]): number {
  const plane = localPlane(line[0]!);
  for (let i = 1; i < line.length; i++) {
    const p = plane.toPlane(line[i]!);
    if (Math.hypot(p.x, p.y) >= 2 || i === line.length - 1) return Math.atan2(p.y, p.x);
  }
  return 0;
}

function halfEdges(doc: Doc, assets: ReadonlyMap<string, Asset>): HalfEdge[] {
  const nodes = nodeMap(doc);
  const out: HalfEdge[] = [];

  for (const segment of doc.segments) {
    if (segment.visible === false) continue;
    const asset = assets.get(segment.assetId);
    if (!asset || !isLineAsset(asset)) continue;
    if (segmentElevation(segment, nodes) !== 0) continue;
    if (segment.fromNodeId === segment.toNodeId) continue;
    const controls = segmentControlPoints(segment, nodes);
    if (!controls) continue;

    const line = dedupe(resolveCenterline({ id: segment.id, centerline: controls, curve: segment.curve }));
    if (line.length < 2) continue;
    const back = [...line].reverse();

    const forward: HalfEdge = {
      segment,
      from: segment.fromNodeId,
      to: segment.toNodeId,
      line,
      twin: null,
      angle: leavingAngle(line),
      visited: false,
    };
    const reverse: HalfEdge = {
      segment,
      from: segment.toNodeId,
      to: segment.fromNodeId,
      line: back,
      twin: forward,
      angle: leavingAngle(back),
      visited: false,
    };
    forward.twin = reverse;
    out.push(forward, reverse);
  }
  return out;
}

/** Every bounded face of the ground-level road graph. */
export function findFaces(doc: Doc, assets: ReadonlyMap<string, Asset>): Face[] {
  const edges = halfEdges(doc, assets);

  const around = new Map<string, HalfEdge[]>();
  for (const edge of edges) {
    const list = around.get(edge.from);
    if (list) list.push(edge);
    else around.set(edge.from, [edge]);
  }
  for (const list of around.values()) list.sort((a, b) => a.angle - b.angle);

  const faces: Face[] = [];

  for (const start of edges) {
    if (start.visited) continue;
    const points: LngLat[] = [];
    let edge: HalfEdge | null = start;
    let guard = edges.length + 2;

    while (edge && !edge.visited && guard-- > 0) {
      edge.visited = true;
      points.push(...edge.line.slice(0, -1));

      // The face stays on the left, so at the end of an edge turn onto the next road
      // clockwise from the one we arrived by.
      const here: HalfEdge[] = around.get(edge.to) ?? [];
      const index: number = here.indexOf(edge.twin!);
      if (index < 0 || here.length === 0) break;
      edge = here[(index - 1 + here.length) % here.length]!;
    }
    if (points.length < 3) continue;

    const plane = localPlane(originFor(points));
    const ring: Ring = points.map((p) => plane.toPlane(p));
    const signed = ringArea(ring);
    // Counter-clockwise is an inside; the one clockwise face is the unbounded outside.
    if (signed > 1) faces.push({ ring: points, areaSquareMetres: signed });
  }

  return faces;
}

const faceBounds = (ring: readonly LngLat[]) => {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return { minLng, minLat, maxLng, maxLat };
};

export interface Block {
  /** The block's ground, roads cut away, in `plane`. */
  shape: Region;
  plane: LocalPlane;
  face: Face;
}

/**
 * The block under a point, or null when it is not inside any block.
 *
 * `faces` is passed in so a caller hovering the map can compute them once per edit rather
 * than once per mouse move. Of the faces containing the point, the smallest is the block.
 */
export function blockAt(
  doc: Doc,
  assets: ReadonlyMap<string, Asset>,
  faces: readonly Face[],
  point: LngLat,
): Block | null {
  let best: Face | null = null;
  for (const face of faces) {
    const b = faceBounds(face.ring);
    if (point[0] < b.minLng || point[0] > b.maxLng || point[1] < b.minLat || point[1] > b.maxLat) continue;
    const plane = localPlane(originFor(face.ring));
    const ring = face.ring.map((p) => plane.toPlane(p));
    if (!pointInRing(plane.toPlane(point), ring)) continue;
    if (!best || face.areaSquareMetres < best.areaSquareMetres) best = face;
  }
  if (!best) return null;

  const plane = localPlane(originFor(best.ring));
  const outline: Ring = best.ring.map((p) => plane.toPlane(p));
  let shape: Region = [outline];

  // Cut every road that runs along the face out of it, to its kerb.
  const nodes = nodeMap(doc);
  const bounds = faceBounds(best.ring);
  const margin = 0.001; // about 100 m: enough to catch a wide road beside the face
  for (const segment of doc.segments) {
    if (segment.visible === false) continue;
    const asset = assets.get(segment.assetId);
    if (!asset || !isLineAsset(asset)) continue;
    if (segmentElevation(segment, nodes) !== 0) continue;
    const controls = segmentControlPoints(segment, nodes);
    if (!controls) continue;

    const line = dedupe(resolveCenterline({ id: segment.id, centerline: controls, curve: segment.curve }));
    if (line.length < 2) continue;
    const lb = faceBounds(line);
    if (
      lb.maxLng < bounds.minLng - margin ||
      lb.minLng > bounds.maxLng + margin ||
      lb.maxLat < bounds.minLat - margin ||
      lb.minLat > bounds.maxLat + margin
    ) {
      continue;
    }

    const extent = sectionExtent(asset);
    const half = Math.max(extent.left, extent.right);
    if (half <= 0) continue;
    const pts: PlanePoint[] = line.map((p) => plane.toPlane(p));

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const nx = (-(b.y - a.y) / len) * half;
      const ny = ((b.x - a.x) / len) * half;
      shape = difference(shape, [
        [
          { x: a.x + nx, y: a.y + ny },
          { x: b.x + nx, y: b.y + ny },
          { x: b.x - nx, y: b.y - ny },
          { x: a.x - nx, y: a.y - ny },
        ],
      ]);
      if (shape.length === 0) break;
    }
    // Round the joints and ends so a bend leaves no wedge of unzoned ground.
    for (const p of pts) shape = difference(shape, [circle(p, half, 16)]);
    if (shape.length === 0) break;
  }

  return shape.length > 0 ? { shape, plane, face: best } : null;
}

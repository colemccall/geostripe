import { localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';
import { addNode, addSegment, setElevation } from './doc';
import type { Doc } from './doc';

/**
 * A roundabout: a ring of one-way roads around a centre.
 *
 * It is built from the same parts as everything else, nodes and segments, so a road joined
 * to the ring is joined the ordinary way (landing on a ring node, or splitting an arc) and the
 * junction plates appear by themselves. Each arc is a quadratic Bezier whose handle sits where
 * the tangents at its two ends meet, which is what makes eight short arcs read as a circle
 * rather than as an octagon.
 *
 * The ring runs counter-clockwise, the way traffic circulates where cars drive on the right.
 */

export const MIN_SIDES = 6;

export interface RoundaboutResult {
  doc: Doc;
  nodeIds: string[];
  segmentIds: string[];
}

export function addRoundabout(
  doc: Doc,
  assetId: string,
  centre: LngLat,
  radiusMetres: number,
  options: { sides?: number; elevation?: number } = {},
): RoundaboutResult {
  const sides = Math.max(MIN_SIDES, options.sides ?? 8);
  const plane = localPlane(centre);
  const step = (2 * Math.PI) / sides;

  let next = doc;
  const nodeIds: string[] = [];
  for (let i = 0; i < sides; i++) {
    const t = i * step;
    const added = addNode(next, plane.toLngLat({ x: radiusMetres * Math.cos(t), y: radiusMetres * Math.sin(t) }));
    next = added.doc;
    nodeIds.push(added.nodeId);
    if (options.elevation) next = setElevation(next, added.nodeId, options.elevation);
  }

  // Tangents at the ends of an arc of angle `step` meet at radius R / cos(step / 2), on the
  // bisector.
  const handleRadius = radiusMetres / Math.cos(step / 2);
  const segmentIds: string[] = [];
  for (let i = 0; i < sides; i++) {
    const mid = i * step + step / 2;
    const handle = plane.toLngLat({ x: handleRadius * Math.cos(mid), y: handleRadius * Math.sin(mid) });
    const built = addSegment(next, {
      assetId,
      fromNodeId: nodeIds[i]!,
      toNodeId: nodeIds[(i + 1) % sides]!,
      shape: [handle],
      curve: { mode: 'bezier', radiusMeters: 12 },
    });
    next = built.doc;
    segmentIds.push(built.segmentId);
  }

  return { doc: next, nodeIds, segmentIds };
}

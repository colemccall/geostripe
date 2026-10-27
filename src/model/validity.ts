import { localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';
import { endsAt, nodeMap, segmentControlPoints } from './doc';
import type { Doc } from './doc';

/**
 * Whether a road may be laid, as data.
 *
 * Game road tools turn a road red before the click rather than failing after it. These are
 * the rules behind that colour, kept as a table so they can be read, tested and argued about
 * without reading the build tool. A planner can still draw a short stub or a sharp ramp
 * junction by lowering a limit; what they cannot do is do it by accident.
 */
export const ROAD_RULES = {
  /** A road shorter than this is a slip of the mouse, not a road. */
  minLengthMetres: 6,
  /** Two roads leaving one junction closer than this make an unusable sliver of ground. */
  minAngleDegrees: 20,
} as const;

export type RoadIssue = 'tooShort' | 'sameNode' | 'duplicate' | 'sharpAngle';

export const ROAD_ISSUE_TEXT: Record<RoadIssue, string> = {
  tooShort: `Too short: roads must be at least ${ROAD_RULES.minLengthMetres} m long.`,
  sameNode: 'A road cannot start and end at the same junction.',
  duplicate: 'There is already a road between these two junctions.',
  sharpAngle: `Too sharp: roads at a junction must be at least ${ROAD_RULES.minAngleDegrees}° apart.`,
};

export interface RoadEnd {
  position: LngLat;
  /** Present when this end lands on an existing junction. */
  nodeId?: string;
}

/** Which way each existing road leaves a node, as a point just along it. */
function leavingDirections(doc: Doc, nodeId: string): LngLat[] {
  const nodes = nodeMap(doc);
  const out: LngLat[] = [];
  for (const { segment, end } of endsAt(nodeId, doc.segments)) {
    const controls = segmentControlPoints(segment, nodes);
    if (!controls || controls.length < 2) continue;
    out.push(end === 'from' ? controls[1]! : controls[controls.length - 2]!);
  }
  return out;
}

/** Everything wrong with laying a road between two ends. Empty means it is fine. */
export function roadIssues(doc: Doc, from: RoadEnd, to: RoadEnd): RoadIssue[] {
  const issues: RoadIssue[] = [];

  if (from.nodeId && from.nodeId === to.nodeId) return ['sameNode'];

  const plane = localPlane(from.position);
  const a = plane.toPlane(from.position);
  const b = plane.toPlane(to.position);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < ROAD_RULES.minLengthMetres) issues.push('tooShort');

  if (
    from.nodeId &&
    to.nodeId &&
    doc.segments.some(
      (s) =>
        s.visible !== false &&
        ((s.fromNodeId === from.nodeId && s.toNodeId === to.nodeId) ||
          (s.fromNodeId === to.nodeId && s.toNodeId === from.nodeId)) &&
        s.shape.length === 0,
    )
  ) {
    issues.push('duplicate');
  }

  // Angle against what already leaves each end, measured in the plane at that end.
  const limit = (ROAD_RULES.minAngleDegrees * Math.PI) / 180;
  const sharp = (end: RoadEnd, other: LngLat): boolean => {
    if (!end.nodeId) return false;
    const p = localPlane(end.position);
    const mine = p.toPlane(other);
    const myLen = Math.hypot(mine.x, mine.y);
    if (myLen < 1e-6) return false;
    return leavingDirections(doc, end.nodeId).some((d) => {
      const theirs = p.toPlane(d);
      const theirLen = Math.hypot(theirs.x, theirs.y);
      if (theirLen < 1e-6) return false;
      const cos = (mine.x * theirs.x + mine.y * theirs.y) / (myLen * theirLen);
      return Math.acos(Math.max(-1, Math.min(1, cos))) < limit;
    });
  };
  if (sharp(from, to.position) || sharp(to, from.position)) issues.push('sharpAngle');

  return issues;
}

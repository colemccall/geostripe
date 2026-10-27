import { localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';
import { area, intersection } from '../geo/region';
import type { Region } from '../geo/region';
import { roadClearance } from '../geo/snapEngine';
import type { SnapIndex } from '../geo/snapEngine';
import { footprint } from './buildings';
import type { Building, Doc } from './doc';

/**
 * Whether a building may go where the ghost is.
 *
 * The ghost turns red with a reason before the click, the way a placement tool does. Two
 * things are refused: standing on a road (or closer than a setback to its edge), and
 * overlapping another building.
 */

/** Open ground required between a building and the paved edge of a road, in metres. */
export const SETBACK_METRES = 1;

export type PlacementIssue = 'onRoad' | 'overlapsBuilding';

export const PLACEMENT_TEXT: Record<PlacementIssue, string> = {
  onRoad: 'Too close to the road.',
  overlapsBuilding: 'Overlaps another building.',
};

type Candidate = Pick<Building, 'typeId' | 'position' | 'rotation'>;

/** Points around and across a footprint, enough to catch a road passing through it. */
function samples(corners: LngLat[], centre: LngLat): LngLat[] {
  const out: LngLat[] = [centre];
  const steps = 6;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  // A coarse grid inside, so a road crossing a large footprint without touching its edge is
  // still seen.
  for (const u of [0.25, 0.5, 0.75]) {
    for (const v of [0.25, 0.5, 0.75]) {
      const top: LngLat = [
        corners[0]![0] + (corners[1]![0] - corners[0]![0]) * u,
        corners[0]![1] + (corners[1]![1] - corners[0]![1]) * u,
      ];
      const bottom: LngLat = [
        corners[3]![0] + (corners[2]![0] - corners[3]![0]) * u,
        corners[3]![1] + (corners[2]![1] - corners[3]![1]) * u,
      ];
      out.push([top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v]);
    }
  }
  return out;
}

export function placementIssues(doc: Doc, index: SnapIndex, candidate: Candidate): PlacementIssue[] {
  const issues: PlacementIssue[] = [];
  const corners = footprint(candidate);

  if (samples(corners, candidate.position).some((p) => roadClearance(index, p, 60) < SETBACK_METRES)) {
    issues.push('onRoad');
  }

  const plane = localPlane(candidate.position);
  const mine: Region = [corners.map((c) => plane.toPlane(c))];
  for (const other of doc.buildings) {
    if (!other.visible) continue;
    const p = plane.toPlane(other.position);
    if (Math.hypot(p.x, p.y) > 250) continue;
    const theirs: Region = [footprint(other).map((c) => plane.toPlane(c))];
    if (area(intersection(mine, theirs)) > 0.5) {
      issues.push('overlapsBuilding');
      break;
    }
  }
  return issues;
}

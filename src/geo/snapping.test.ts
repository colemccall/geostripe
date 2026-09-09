import { describe, expect, it } from 'vitest';
import { directionGuidesAt, guideLine, snapToGuides } from './snapping';
import { addNode, addSegment, emptyDoc } from '../model/doc';
import type { Doc } from '../model/doc';
import { bearingDegrees, distanceMeters } from './measure';

/**
 * The guides are what stop a hand-drawn network looking hand-drawn. They are derived from
 * the roads already at a junction rather than from a global grid, because a real downtown
 * grid is rarely aligned to north and a fixed angular snap therefore helps with nothing.
 */

const AT: [number, number] = [-84.52, 39.1];

/** A junction with one road running due east out of it. */
function eastward(): { doc: Doc; nodeId: string } {
  let doc = emptyDoc();
  const centre = addNode(doc, AT);
  doc = centre.doc;
  const east = addNode(doc, [-84.51, 39.1]);
  doc = east.doc;
  doc = addSegment(doc, {
    assetId: 'a',
    fromNodeId: centre.nodeId,
    toNodeId: east.nodeId,
    shape: [],
  }).doc;
  return { doc, nodeId: centre.nodeId };
}

describe('the directions a junction implies', () => {
  it('offers carrying straight on, and the two square turns', () => {
    const { doc, nodeId } = eastward();
    const guides = directionGuidesAt(doc, nodeId);

    expect(guides).toHaveLength(3);
    expect(guides.filter((g) => g.kind === 'continue')).toHaveLength(1);
    expect(guides.filter((g) => g.kind === 'square')).toHaveLength(2);
  });

  it('points "continue" back the way the road came from', () => {
    const { doc, nodeId } = eastward();
    const guides = directionGuidesAt(doc, nodeId);
    const carry = guides.find((g) => g.kind === 'continue')!;

    // The road leaves east, so carrying on through the junction means heading west.
    const degrees = (carry.angle * 180) / Math.PI;
    expect(Math.abs(Math.abs(degrees) - 180)).toBeLessThan(1);
  });

  it('offers nothing at a node with no roads', () => {
    let doc = emptyDoc();
    const lone = addNode(doc, AT);
    doc = lone.doc;
    expect(directionGuidesAt(doc, lone.nodeId)).toEqual([]);
  });

  it('offers a set per road, so a crossroads implies both axes', () => {
    const { doc, nodeId } = eastward();
    const north = addNode(doc, [-84.52, 39.11]);
    const withNorth = addSegment(north.doc, {
      assetId: 'a',
      fromNodeId: nodeId,
      toNodeId: north.nodeId,
      shape: [],
    }).doc;

    expect(directionGuidesAt(withNorth, nodeId)).toHaveLength(6);
  });
});

describe('pulling the cursor onto a guide', () => {
  it('squares up a cursor that is a couple of degrees off', () => {
    const { doc, nodeId } = eastward();
    const guides = directionGuidesAt(doc, nodeId);

    // Aiming almost due north out of the junction — the square turn.
    const nearlyNorth: [number, number] = [-84.5203, 39.104];
    const snapped = snapToGuides(AT, nearlyNorth, guides);

    expect(snapped).not.toBeNull();
    expect(snapped!.guide.kind).toBe('square');
    expect(Math.abs(bearingDegrees(AT, snapped!.point))).toBeLessThan(0.5);
  });

  it('keeps how far out the cursor is, and only changes the direction', () => {
    const { doc, nodeId } = eastward();
    const guides = directionGuidesAt(doc, nodeId);
    const nearlyNorth: [number, number] = [-84.5203, 39.104];

    const before = distanceMeters(AT, nearlyNorth);
    const snapped = snapToGuides(AT, nearlyNorth, guides)!;

    // A snap that also moved the road's length would be deciding something unasked.
    expect(distanceMeters(AT, snapped.point)).toBeCloseTo(before, 1);
  });

  it('lets go once the cursor is clearly off the guide', () => {
    const { doc, nodeId } = eastward();
    const guides = directionGuidesAt(doc, nodeId);

    // Forty-five degrees is a direction somebody meant, not a slip.
    const diagonal: [number, number] = [-84.5165, 39.1035];
    expect(snapToGuides(AT, diagonal, guides)).toBeNull();
  });

  it('does not snap a cursor sitting on the junction itself', () => {
    const { doc, nodeId } = eastward();
    const guides = directionGuidesAt(doc, nodeId);
    expect(snapToGuides(AT, [-84.52000, 39.10001], guides)).toBeNull();
  });

  it('prefers carrying straight on when two guides are equally close', () => {
    // Placed symmetrically about wherever the cursor actually points, so the tie is exact
    // rather than a coordinate that happens to look balanced on paper.
    const cursor: [number, number] = [-84.515, 39.104];
    const bearing = (Math.atan2(39.104 - 39.1, (-84.515 + 84.52) * Math.cos((39.1 * Math.PI) / 180)) * 180) / Math.PI;
    const rad = (deg: number) => (deg * Math.PI) / 180;

    const guides = [
      { angle: rad(bearing + 4), kind: 'square' as const },
      { angle: rad(bearing - 4), kind: 'continue' as const },
    ];

    // Carrying on is the likelier intent, and the more obviously wrong when it is a degree
    // out, so it takes the tie.
    expect(snapToGuides(AT, cursor, guides)?.guide.kind).toBe('continue');
  });
});

describe('the guide line', () => {
  it('runs past the cursor on both sides, so it reads as a relationship', () => {
    const line = guideLine(AT, [-84.51, 39.1], 50);
    expect(line).toHaveLength(2);

    // It extends behind the origin and beyond the cursor.
    expect(distanceMeters(line[0]!, AT)).toBeGreaterThan(40);
    expect(distanceMeters(line[1]!, AT)).toBeGreaterThan(distanceMeters(AT, [-84.51, 39.1]));
  });

  it('is nothing when there is no direction to show', () => {
    expect(guideLine(AT, AT)).toEqual([]);
  });
});

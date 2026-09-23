import { describe, expect, it } from 'vitest';
import { addNode, addSegment, canDissolve, dissolveNode, emptyDoc } from './doc';
import type { Doc } from './doc';

/**
 * Removing a node that is not doing anything.
 *
 * The inverse of a split, and the operation whose absence made the graph a ratchet: every
 * crossing, retype and stray click left a node behind that could only be undone by deleting
 * both roads and drawing them again.
 */

const ASSET = 'a';

/** Three nodes in a line, joined by two roads — a seam in the middle. */
function chain(assetB = ASSET): { doc: Doc; west: string; middle: string; east: string } {
  let doc = emptyDoc();
  const west = addNode(doc, [-84.53, 39.1]);
  doc = west.doc;
  const middle = addNode(doc, [-84.52, 39.1]);
  doc = middle.doc;
  const east = addNode(doc, [-84.51, 39.1]);
  doc = east.doc;

  doc = addSegment(doc, {
    assetId: ASSET,
    fromNodeId: west.nodeId,
    toNodeId: middle.nodeId,
    shape: [],
  }).doc;
  doc = addSegment(doc, {
    assetId: assetB,
    fromNodeId: middle.nodeId,
    toNodeId: east.nodeId,
    shape: [],
  }).doc;

  return { doc, west: west.nodeId, middle: middle.nodeId, east: east.nodeId };
}

describe('dissolving a seam', () => {
  it('joins the two roads into one and drops the node', () => {
    const { doc, middle, west, east } = chain();
    const after = dissolveNode(doc, middle)!;

    expect(after).not.toBeNull();
    expect(after.segments).toHaveLength(1);
    expect(after.nodes).toHaveLength(2);

    const road = after.segments[0]!;
    expect([road.fromNodeId, road.toNodeId].sort()).toEqual([west, east].sort());
  });

  it('keeps the corner the node made, as a bend in the surviving road', () => {
    let doc = emptyDoc();
    const west = addNode(doc, [-84.53, 39.1]);
    doc = west.doc;
    // A middle node well off the straight line between the other two.
    const middle = addNode(doc, [-84.52, 39.11]);
    doc = middle.doc;
    const east = addNode(doc, [-84.51, 39.1]);
    doc = east.doc;
    doc = addSegment(doc, { assetId: ASSET, fromNodeId: west.nodeId, toNodeId: middle.nodeId, shape: [] }).doc;
    doc = addSegment(doc, { assetId: ASSET, fromNodeId: middle.nodeId, toNodeId: east.nodeId, shape: [] }).doc;

    const road = dissolveNode(doc, middle.nodeId)!.segments[0]!;

    // The road would spring straight without this, visibly moving when a node was removed.
    expect(road.shape).toContainEqual([-84.52, 39.11]);
  });

  it('keeps the bends both halves already had, in order', () => {
    let doc = emptyDoc();
    const west = addNode(doc, [-84.53, 39.1]);
    doc = west.doc;
    const middle = addNode(doc, [-84.52, 39.1]);
    doc = middle.doc;
    const east = addNode(doc, [-84.51, 39.1]);
    doc = east.doc;
    doc = addSegment(doc, {
      assetId: ASSET,
      fromNodeId: west.nodeId,
      toNodeId: middle.nodeId,
      shape: [[-84.525, 39.101]],
    }).doc;
    doc = addSegment(doc, {
      assetId: ASSET,
      fromNodeId: middle.nodeId,
      toNodeId: east.nodeId,
      shape: [[-84.515, 39.099]],
    }).doc;

    const road = dissolveNode(doc, middle.nodeId)!.segments[0]!;
    expect(road.shape).toEqual([[-84.525, 39.101], [-84.52, 39.1], [-84.515, 39.099]]);
  });

  it('refuses at a junction, where the node is a place rather than a seam', () => {
    const { doc, middle } = chain();
    const north = addNode(doc, [-84.52, 39.11]);
    const withThird = addSegment(north.doc, {
      assetId: ASSET,
      fromNodeId: middle,
      toNodeId: north.nodeId,
      shape: [],
    }).doc;

    expect(canDissolve(withThird, middle)).toBe(false);
    expect(dissolveNode(withThird, middle)).toBeNull();
  });

  it('refuses at a terminus, which is an end rather than a seam', () => {
    const { doc, west } = chain();
    expect(canDissolve(doc, west)).toBe(false);
    expect(dissolveNode(doc, west)).toBeNull();
  });

  it('refuses where the road changes type, because that seam is the point', () => {
    // A turn lane before a junction is expressed as a short stub of a different asset. A
    // dissolve there would silently throw one of the two away.
    const { doc, middle } = chain('different-asset');
    expect(canDissolve(doc, middle)).toBe(false);
    expect(dissolveNode(doc, middle)).toBeNull();
  });

  it('refuses to close a road into a ring with no ends', () => {
    let doc = emptyDoc();
    const a = addNode(doc, [-84.53, 39.1]);
    doc = a.doc;
    const b = addNode(doc, [-84.52, 39.1]);
    doc = b.doc;
    // Two roads between the same pair: dissolving b would join a road to itself.
    doc = addSegment(doc, { assetId: ASSET, fromNodeId: a.nodeId, toNodeId: b.nodeId, shape: [] }).doc;
    doc = addSegment(doc, {
      assetId: ASSET,
      fromNodeId: b.nodeId,
      toNodeId: a.nodeId,
      shape: [[-84.525, 39.105]],
    }).doc;

    expect(dissolveNode(doc, b.nodeId)).toBeNull();
  });

  it('is the inverse of a split, so the ratchet is gone', () => {
    const { doc, middle } = chain();
    const after = dissolveNode(doc, middle)!;

    // One road, two nodes — exactly what it would have been had the split never happened.
    expect(after.segments).toHaveLength(1);
    expect(after.segments[0]!.assetId).toBe(ASSET);
    expect(after.nodes.map((n) => n.id)).not.toContain(middle);
  });
});

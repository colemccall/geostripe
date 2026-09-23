import { describe, expect, it } from 'vitest';
import { layRoad } from './build';
import { addNode, addSegment, emptyDoc, nodeMap, segmentControlPoints, setElevation } from './doc';
import type { Doc } from './doc';
import { distanceMeters } from '../geo/measure';

/**
 * Laying a road through what is already there.
 *
 * This is the behaviour that separates a road-building tool from a drawing program, and it
 * is the one the editor was missing: crossing an existing road left the two merely
 * overlapping, so you had to aim at the crossing yourself. These tests are about the crossing
 * being found and both roads actually meeting there.
 */

const ASSET = 'test-asset';

/** An east-west road across the middle, for other roads to run into. */
function withEastWest(): { doc: Doc; westId: string; eastId: string } {
  let doc = emptyDoc();
  const west = addNode(doc, [-84.53, 39.1]);
  doc = west.doc;
  const east = addNode(doc, [-84.51, 39.1]);
  doc = east.doc;
  doc = addSegment(doc, {
    assetId: ASSET,
    fromNodeId: west.nodeId,
    toNodeId: east.nodeId,
    shape: [],
  }).doc;
  return { doc, westId: west.nodeId, eastId: east.nodeId };
}

/** Add a loose node, the way clicking open ground does. */
function at(doc: Doc, position: [number, number]): { doc: Doc; nodeId: string } {
  const added = addNode(doc, position);
  return { doc: added.doc, nodeId: added.nodeId };
}

describe('a road drawn across another', () => {
  it('splits both and shares one node', () => {
    const base = withEastWest();
    const north = at(base.doc, [-84.52, 39.11]);
    const south = at(north.doc, [-84.52, 39.09]);

    const result = layRoad(south.doc, {
      assetId: ASSET,
      fromNodeId: north.nodeId,
      toNodeId: south.nodeId,
      handles: [],
      curved: false,
      elevation: 0,
    });

    // One east-west road became two, the new north-south road is two, and the node in the
    // middle is shared by all four ends.
    expect(result.crossings).toBe(1);
    expect(result.doc.segments).toHaveLength(4);

    const degree = new Map<string, number>();
    for (const segment of result.doc.segments) {
      degree.set(segment.fromNodeId, (degree.get(segment.fromNodeId) ?? 0) + 1);
      degree.set(segment.toNodeId, (degree.get(segment.toNodeId) ?? 0) + 1);
    }
    expect([...degree.values()].filter((d) => d === 4)).toHaveLength(1);
  });

  it('puts the shared node exactly on both roads', () => {
    const base = withEastWest();
    const north = at(base.doc, [-84.52, 39.11]);
    const south = at(north.doc, [-84.52, 39.09]);

    const result = layRoad(south.doc, {
      assetId: ASSET,
      fromNodeId: north.nodeId,
      toNodeId: south.nodeId,
      handles: [],
      curved: false,
      elevation: 0,
    });

    const nodes = nodeMap(result.doc);
    const shared = result.doc.nodes.find(
      (n) => result.doc.segments.filter((s) => s.fromNodeId === n.id || s.toNodeId === n.id).length === 4,
    )!;

    // The crossing is computed, not guessed, so it lies on both lines rather than near them.
    expect(distanceMeters(shared.position, [-84.52, 39.1])).toBeLessThan(1);
    for (const segment of result.doc.segments) {
      const controls = segmentControlPoints(segment, nodes)!;
      expect(controls.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('handles crossing several roads in one stroke', () => {
    let doc = emptyDoc();
    // Three parallel east-west roads.
    for (const lat of [39.098, 39.1, 39.102]) {
      const a = addNode(doc, [-84.53, lat]);
      doc = a.doc;
      const b = addNode(doc, [-84.51, lat]);
      doc = b.doc;
      doc = addSegment(doc, {
        assetId: ASSET,
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
        shape: [],
      }).doc;
    }

    const north = at(doc, [-84.52, 39.105]);
    const south = at(north.doc, [-84.52, 39.095]);

    const result = layRoad(south.doc, {
      assetId: ASSET,
      fromNodeId: north.nodeId,
      toNodeId: south.nodeId,
      handles: [],
      curved: false,
      elevation: 0,
    });

    // Three crossings: each of the three roads becomes two, and the new road becomes four.
    expect(result.crossings).toBe(3);
    expect(result.doc.segments).toHaveLength(3 * 2 + 4);
    expect(result.segmentIds).toHaveLength(4);
  });

  it('leaves a road alone when it passes over at a different height', () => {
    const base = withEastWest();
    const north = at(base.doc, [-84.52, 39.11]);
    let doc = north.doc;
    const south = at(doc, [-84.52, 39.09]);
    doc = south.doc;
    // Both ends of the flyover are up, so the whole road is up.
    doc = setElevation(doc, north.nodeId, 1);
    doc = setElevation(doc, south.nodeId, 1);

    const result = layRoad(doc, {
      assetId: ASSET,
      fromNodeId: north.nodeId,
      toNodeId: south.nodeId,
      handles: [],
      curved: false,
      elevation: 1,
    });

    // Nothing is cut and nothing is shared: it flies over. That is the whole of grade
    // separation in this model, and it needs no rule beyond the heights not matching.
    expect(result.crossings).toBe(0);
    expect(result.doc.segments).toHaveLength(2);
  });

  it('does not split at a crossing that is really the road’s own end', () => {
    const base = withEastWest();
    // Start the new road ON the existing one's west node and run away from it.
    const south = at(base.doc, [-84.53, 39.09]);

    const result = layRoad(south.doc, {
      assetId: ASSET,
      fromNodeId: base.westId,
      toNodeId: south.nodeId,
      handles: [],
      curved: false,
      elevation: 0,
    });

    // Touching at a node you are already using is not a crossing.
    expect(result.crossings).toBe(0);
    expect(result.doc.segments).toHaveLength(2);
  });
});

describe('a curved road drawn across another', () => {
  it('splits and keeps its shape on both sides of the cut', () => {
    const base = withEastWest();
    const north = at(base.doc, [-84.525, 39.108]);
    const south = at(north.doc, [-84.515, 39.092]);

    const result = layRoad(south.doc, {
      assetId: ASSET,
      fromNodeId: north.nodeId,
      toNodeId: south.nodeId,
      handles: [[-84.528, 39.098]],
      curved: true,
      elevation: 0,
    });

    expect(result.crossings).toBe(1);
    // Both halves come back as curves. A split that straightened the road would be visible
    // immediately, so the subdivision has to be exact rather than a re-fit.
    const halves = result.segmentIds.map((id) => result.doc.segments.find((s) => s.id === id)!);
    expect(halves).toHaveLength(2);
    expect(halves.every((s) => s.curve?.mode === 'bezier')).toBe(true);
    expect(halves.every((s) => s.shape.length > 0)).toBe(true);
  });
});

describe('an ordinary road', () => {
  it('is one segment when it crosses nothing', () => {
    let doc = emptyDoc();
    const a = at(doc, [-84.53, 39.1]);
    doc = a.doc;
    const b = at(doc, [-84.52, 39.1]);

    const result = layRoad(b.doc, {
      assetId: ASSET,
      fromNodeId: a.nodeId,
      toNodeId: b.nodeId,
      handles: [],
      curved: false,
      elevation: 0,
    });

    expect(result.crossings).toBe(0);
    expect(result.doc.segments).toHaveLength(1);
    expect(result.segmentIds).toHaveLength(1);
  });
});

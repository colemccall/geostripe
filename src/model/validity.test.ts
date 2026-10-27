import { describe, expect, it } from 'vitest';
import { ROAD_RULES, roadIssues } from './validity';
import { addNode, addSegment, emptyDoc } from './doc';
import type { Doc } from './doc';
import { layRoad } from './build';
import { localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';

const plane = localPlane([-84.52, 39.1]);
const at = (x: number, y: number): LngLat => plane.toLngLat({ x, y });

function twoNodes(): { doc: Doc; a: string; b: string } {
  let doc = emptyDoc();
  const a = addNode(doc, at(0, 0));
  doc = a.doc;
  const b = addNode(doc, at(100, 0));
  doc = b.doc;
  doc = addSegment(doc, { assetId: 'x', fromNodeId: a.nodeId, toNodeId: b.nodeId, shape: [] }).doc;
  return { doc, a: a.nodeId, b: b.nodeId };
}

describe('road validity', () => {
  it('accepts an ordinary road', () => {
    const doc = emptyDoc();
    expect(roadIssues(doc, { position: at(0, 0) }, { position: at(80, 30) })).toEqual([]);
  });

  it('rejects a road shorter than the minimum', () => {
    const doc = emptyDoc();
    const issues = roadIssues(
      doc,
      { position: at(0, 0) },
      { position: at(ROAD_RULES.minLengthMetres - 1, 0) },
    );
    expect(issues).toEqual(['tooShort']);
  });

  it('rejects a road from a junction to itself', () => {
    const { doc, a } = twoNodes();
    expect(roadIssues(doc, { position: at(0, 0), nodeId: a }, { position: at(0, 0), nodeId: a })).toEqual(['sameNode']);
  });

  it('rejects a second straight road between the same two junctions', () => {
    const { doc, a, b } = twoNodes();
    expect(
      roadIssues(doc, { position: at(0, 0), nodeId: a }, { position: at(100, 0), nodeId: b }),
    ).toContain('duplicate');
  });

  it('rejects a road leaving a junction almost along an existing one', () => {
    const { doc, a } = twoNodes();
    // 5 degrees off the road that already runs east from the junction.
    const issues = roadIssues(
      doc,
      { position: at(0, 0), nodeId: a },
      { position: at(100, 100 * Math.tan((5 * Math.PI) / 180)) },
    );
    expect(issues).toContain('sharpAngle');
  });

  it('accepts a road leaving at a proper angle', () => {
    const { doc, a } = twoNodes();
    expect(roadIssues(doc, { position: at(0, 0), nodeId: a }, { position: at(0, 100) })).toEqual([]);
    expect(roadIssues(doc, { position: at(0, 0), nodeId: a }, { position: at(-100, 0) })).toEqual([]);
  });
});

describe('laying a road keeps its pieces and nodes in step', () => {
  it('chains a road drawn across three others into four pieces on four nodes', () => {
    let doc = emptyDoc();
    const ids: string[] = [];
    for (const x of [100, 200, 300]) {
      const s = addNode(doc, at(x, -100));
      doc = s.doc;
      const n = addNode(doc, at(x, 100));
      doc = n.doc;
      doc = addSegment(doc, { assetId: 'x', fromNodeId: s.nodeId, toNodeId: n.nodeId, shape: [] }).doc;
      ids.push(s.nodeId, n.nodeId);
    }
    const from = addNode(doc, at(0, 0));
    doc = from.doc;
    const to = addNode(doc, at(400, 0));
    doc = to.doc;

    const result = layRoad(doc, {
      assetId: 'x',
      fromNodeId: from.nodeId,
      toNodeId: to.nodeId,
      handles: [],
      curved: false,
      elevation: 0,
    });

    expect(result.crossings).toBe(3);
    expect(result.segmentIds).toHaveLength(4);

    // Every new piece begins where the last ended: a connected chain with no gap or repeat.
    const pieces = result.segmentIds.map((id) => result.doc.segments.find((s) => s.id === id)!);
    expect(pieces[0]!.fromNodeId).toBe(from.nodeId);
    expect(pieces[3]!.toNodeId).toBe(to.nodeId);
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i]!.fromNodeId).toBe(pieces[i - 1]!.toNodeId);
    }
    expect(new Set(pieces.map((p) => p.toNodeId)).size).toBe(4);
  });
});

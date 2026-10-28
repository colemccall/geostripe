import { describe, expect, it } from 'vitest';
import { addRoundabout } from './roundabout';
import { emptyDoc, nodeMap, segmentControlPoints } from './doc';
import { resolveCenterline } from '../geo/curve';
import { distanceMetres } from '../geo/crs';
import type { LngLat } from '../geo/crs';

const CENTRE: LngLat = [-84.52, 39.1];

describe('a roundabout', () => {
  const R = 20;
  const { doc, nodeIds, segmentIds } = addRoundabout(emptyDoc(), 'x', CENTRE, R);

  it('is a closed ring of nodes and arcs', () => {
    expect(nodeIds).toHaveLength(8);
    expect(segmentIds).toHaveLength(8);
    const around = doc.segments.map((s) => `${s.fromNodeId}>${s.toNodeId}`);
    for (let i = 0; i < 8; i++) expect(around).toContain(`${nodeIds[i]}>${nodeIds[(i + 1) % 8]}`);
  });

  it('puts every junction on the circle', () => {
    for (const node of doc.nodes) {
      expect(Math.abs(distanceMetres(CENTRE, node.position) - R)).toBeLessThan(0.05);
    }
  });

  it('draws arcs that stay on the circle, not along the chords', () => {
    const nodes = nodeMap(doc);
    for (const segment of doc.segments) {
      const line = resolveCenterline({
        id: segment.id,
        centerline: segmentControlPoints(segment, nodes)!,
        curve: segment.curve,
      });
      for (const point of line) {
        // A quadratic approximation of a 45 degree arc is within a fraction of a percent.
        expect(Math.abs(distanceMetres(CENTRE, point) - R) / R).toBeLessThan(0.01);
      }
    }
  });

  it('circulates counter-clockwise', () => {
    const nodes = nodeMap(doc);
    const a = nodes.get(nodeIds[0]!)!.position;
    const b = nodes.get(nodeIds[1]!)!.position;
    // Going from the east node to the next, latitude rises: anticlockwise seen from above.
    expect(b[1]).toBeGreaterThan(a[1]);
  });
});

describe('a roundabout with roads joined to it', () => {
  it('forms a junction at each entry and paints without error', async () => {
    const { layRoad } = await import('./build');
    const { addNode, endsAt } = await import('./doc');
    const { paintDoc } = await import('../map/paint');
    const { assetMap, builtInAssets, defaultLineAssetId } = await import('../library/assets');
    const { localPlane } = await import('../geo/crs');

    const palette = builtInAssets();
    const assetId = defaultLineAssetId(palette);
    const ring = addRoundabout(emptyDoc(), assetId, CENTRE, 22);
    let doc = ring.doc;
    const plane = localPlane(CENTRE);

    // Four roads in from the compass points, each ending on the ring node nearest it.
    for (const [index, [x, y]] of [[0, [200, 0]], [2, [0, 200]], [4, [-200, 0]], [6, [0, -200]]] as [number, [number, number]][]) {
      const far = addNode(doc, plane.toLngLat({ x, y }));
      doc = far.doc;
      doc = layRoad(doc, {
        assetId,
        fromNodeId: far.nodeId,
        toNodeId: ring.nodeIds[index]!,
        handles: [],
        curved: false,
        elevation: 0,
      }).doc;
    }

    for (const index of [0, 2, 4, 6]) {
      expect(endsAt(ring.nodeIds[index]!, doc.segments)).toHaveLength(3);
    }

    const painted = paintDoc(doc, assetMap(palette), { defaultRadiusMeters: 6 });
    const withPlate = new Set(painted.plates.features.map((f) => f.properties!.nodeId));
    for (const index of [0, 2, 4, 6]) expect(withPlate.has(ring.nodeIds[index]!)).toBe(true);
  });
});

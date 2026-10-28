import { describe, expect, it } from 'vitest';
import { blockAt, findFaces } from './blocks';
import { paintRegion } from './zones';
import { addNode, addSegment, emptyDoc, setElevation } from './doc';
import type { Doc } from './doc';
import { assetMap, builtInAssets, defaultLineAssetId } from '../library/assets';
import { area } from '../geo/region';
import { localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';
import { sectionExtent } from './section';
import type { LineAsset } from './asset';

const assets = assetMap(builtInAssets());
const roadAssetId = defaultLineAssetId(builtInAssets());
const road = assets.get(roadAssetId) as LineAsset;
const plane = localPlane([-84.52, 39.1]);
const at = (x: number, y: number): LngLat => plane.toLngLat({ x, y });

/** A `cols` x `rows` grid of blocks, each `size` metres between road centrelines. */
function grid(cols: number, rows: number, size = 100): Doc {
  let doc = emptyDoc();
  const ids: string[][] = [];
  for (let i = 0; i <= cols; i++) {
    ids.push([]);
    for (let j = 0; j <= rows; j++) {
      const n = addNode(doc, at(i * size, j * size));
      doc = n.doc;
      ids[i]!.push(n.nodeId);
    }
  }
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= rows; j++) {
      if (i < cols) doc = addSegment(doc, { assetId: roadAssetId, fromNodeId: ids[i]![j]!, toNodeId: ids[i + 1]![j]!, shape: [] }).doc;
      if (j < rows) doc = addSegment(doc, { assetId: roadAssetId, fromNodeId: ids[i]![j]!, toNodeId: ids[i]![j + 1]!, shape: [] }).doc;
    }
  }
  return doc;
}

describe('finding blocks', () => {
  it('finds one face per block in a grid, and not the outside', () => {
    const faces = findFaces(grid(3, 2), assets);
    expect(faces).toHaveLength(6);
    for (const face of faces) expect(Math.abs(face.areaSquareMetres - 10000) / 10000).toBeLessThan(0.01);
  });

  it('finds a single triangle', () => {
    let doc = emptyDoc();
    const a = addNode(doc, at(0, 0));
    doc = a.doc;
    const b = addNode(doc, at(200, 0));
    doc = b.doc;
    const c = addNode(doc, at(100, 150));
    doc = c.doc;
    for (const [f, t] of [[a, b], [b, c], [c, a]] as const) {
      doc = addSegment(doc, { assetId: roadAssetId, fromNodeId: f.nodeId, toNodeId: t.nodeId, shape: [] }).doc;
    }
    const faces = findFaces(doc, assets);
    expect(faces).toHaveLength(1);
    expect(Math.abs(faces[0]!.areaSquareMetres - 15000) / 15000).toBeLessThan(0.01);
  });

  it('is not fooled by a dead-end road poking into a block', () => {
    let doc = grid(1, 1);
    const stub = addNode(doc, at(50, 50));
    doc = stub.doc;
    doc = addSegment(doc, { assetId: roadAssetId, fromNodeId: doc.nodes[0]!.id, toNodeId: stub.nodeId, shape: [] }).doc;
    expect(findFaces(doc, assets)).toHaveLength(1);
  });

  it('does not let a bridge close a block', () => {
    let doc = grid(1, 1);
    // Raise the north road: it is no longer a wall of the block below it.
    const north = doc.segments.find((s) => {
      const a = doc.nodes.find((n) => n.id === s.fromNodeId)!;
      const b = doc.nodes.find((n) => n.id === s.toNodeId)!;
      const pa = plane.toPlane(a.position);
      const pb = plane.toPlane(b.position);
      return pa.y === pb.y && Math.abs(pa.y - 100) < 1;
    })!;
    doc = setElevation(doc, north.fromNodeId, 1);
    doc = setElevation(doc, north.toNodeId, 1);
    expect(findFaces(doc, assets)).toHaveLength(0);
  });
});

describe('the block under a point', () => {
  it('is the ground between the kerbs, roads cut away', () => {
    const doc = grid(2, 2);
    const faces = findFaces(doc, assets);
    const block = blockAt(doc, assets, faces, at(50, 50))!;
    expect(block).not.toBeNull();

    const half = Math.max(sectionExtent(road).left, sectionExtent(road).right);
    const expected = (100 - 2 * half) ** 2;
    // A little under the square because junction corners are rounded, never over it.
    expect(area(block.shape)).toBeLessThanOrEqual(expected * 1.01);
    expect(area(block.shape)).toBeGreaterThan(expected * 0.9);
  });

  it('is null outside every block', () => {
    const doc = grid(2, 2);
    expect(blockAt(doc, assets, findFaces(doc, assets), at(-300, -300))).toBeNull();
  });

  it('painting it zones the block and nothing beyond its kerbs', () => {
    const doc = grid(2, 2);
    const block = blockAt(doc, assets, findFaces(doc, assets), at(50, 50))!;
    const painted = paintRegion(doc, 'commercial', block.shape, block.plane);
    expect(painted.zones.length).toBe(1);

    // A point on the road centreline is not in the zone, a point mid-block is.
    const ring = painted.zones[0]!.rings[0]!.map((p) => plane.toPlane(p));
    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    const half = Math.max(sectionExtent(road).left, sectionExtent(road).right);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(half - 0.5);
    expect(Math.max(...xs)).toBeLessThanOrEqual(100 - half + 0.5);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(half - 0.5);
  });
});

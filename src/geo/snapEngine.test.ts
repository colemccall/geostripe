import { describe, expect, it } from 'vitest';
import { GridIndex, pointToSegment } from './spatial';
import { buildSnapIndex, findSnaps } from './snapEngine';
import { distanceMetres, localPlane } from './crs';
import type { LngLat } from './crs';
import { addArea, addNode, addSegment, emptyDoc } from '../model/doc';
import type { Doc } from '../model/doc';
import { assetMap, builtInAssets, defaultLineAssetId } from '../library/assets';
import { sectionExtent } from '../model/section';
import type { LineAsset } from '../model/asset';

const assets = assetMap(builtInAssets());
const roadAssetId = defaultLineAssetId(builtInAssets());
const road = assets.get(roadAssetId) as LineAsset;

/** Deterministic pseudo-random numbers so a failure can be reproduced. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ORIGIN: LngLat = [-84.52, 39.1];
const plane = localPlane(ORIGIN);
const at = (x: number, y: number): LngLat => plane.toLngLat({ x, y });

/** An east-west road 400 m long, with a junction in the middle. */
function cross(): { doc: Doc; west: string; mid: string; east: string; north: string } {
  let doc = emptyDoc();
  const w = addNode(doc, at(-200, 0));
  doc = w.doc;
  const m = addNode(doc, at(0, 0));
  doc = m.doc;
  const e = addNode(doc, at(200, 0));
  doc = e.doc;
  const n = addNode(doc, at(0, 200));
  doc = n.doc;
  for (const [from, to] of [
    [w.nodeId, m.nodeId],
    [m.nodeId, e.nodeId],
    [m.nodeId, n.nodeId],
  ] as const) {
    doc = addSegment(doc, { assetId: roadAssetId, fromNodeId: from, toNodeId: to, shape: [] }).doc;
  }
  return { doc, west: w.nodeId, mid: m.nodeId, east: e.nodeId, north: n.nodeId };
}

describe('the grid index', () => {
  it('returns what is near and leaves out what is far', () => {
    const grid = new GridIndex<string>(100);
    grid.insert({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 'near');
    grid.insert({ minX: 5000, minY: 5000, maxX: 5000, maxY: 5000 }, 'far');
    const found = grid.near(10, 10, 50);
    expect(found).toContain('near');
    expect(found).not.toContain('far');
  });

  it('finds an item that spans several cells from any of them, once', () => {
    const grid = new GridIndex<string>(10);
    grid.insert({ minX: 0, minY: 0, maxX: 95, maxY: 5 }, 'long');
    expect(grid.near(90, 0, 3)).toEqual(['long']);
    expect(grid.near(5, 0, 3)).toEqual(['long']);
  });

  it('measures the nearest point on a segment, clamped to its ends', () => {
    expect(pointToSegment(5, 3, 0, 0, 10, 0)).toMatchObject({ distance: 3, t: 0.5 });
    expect(pointToSegment(-4, 3, 0, 0, 10, 0)).toMatchObject({ distance: 5, t: 0 });
  });
});

describe('snapping to the model', () => {
  it('prefers a junction over the road it sits on', () => {
    const { doc, mid } = cross();
    const index = buildSnapIndex(doc, assets);
    const found = findSnaps(index, at(0.4, 0.3), 2, 'build');
    expect(found[0]!.kind).toBe('node');
    expect(found[0]!.snap).toEqual({ kind: 'node', nodeId: mid });
    // The road underneath is still offered, for cycling.
    expect(found.map((c) => c.kind)).toContain('centreline');
  });

  it('lands on the road, splitting at the nearest point, away from a junction', () => {
    const { doc } = cross();
    const index = buildSnapIndex(doc, assets);
    const found = findSnaps(index, at(120, 0.6), 2, 'build');
    expect(found[0]!.kind).toBe('centreline');
    expect(found[0]!.snap?.kind).toBe('segment');
    expect(distanceMetres(found[0]!.position, at(120, 0))).toBeLessThan(0.05);
  });

  it('measures its tolerance in metres, at the same latitude as the cursor', () => {
    const { doc } = cross();
    const index = buildSnapIndex(doc, assets);
    expect(findSnaps(index, at(120, 1.9), 2, 'build')).not.toHaveLength(0);
    expect(findSnaps(index, at(120, 2.2), 2, 'build')).toHaveLength(0);
  });

  it('finds nothing in open ground', () => {
    const { doc } = cross();
    const index = buildSnapIndex(doc, assets);
    expect(findSnaps(index, at(500, 500), 5, 'build')).toEqual([]);
  });

  it('can be told to ignore the node being dragged', () => {
    const { doc, mid } = cross();
    const index = buildSnapIndex(doc, assets);
    const found = findSnaps(index, at(0.2, 0.2), 3, 'select', { excludeNodeIds: new Set([mid]) });
    expect(found.find((c) => c.kind === 'node')).toBeUndefined();
  });

  it('snaps to a kerb for the ground tool, and never to a centreline', () => {
    const { doc } = cross();
    const index = buildSnapIndex(doc, assets);
    const extent = sectionExtent(road);
    // Just outside the north kerb of the east-west road.
    const found = findSnaps(index, at(120, extent.left + 0.4), 1.5, 'area');
    expect(found.some((c) => c.kind === 'centreline')).toBe(false);
    const kerb = found.find((c) => c.kind === 'edge');
    expect(kerb).toBeDefined();
    expect(Math.abs(plane.toPlane(kerb!.position).y)).toBeCloseTo(
      Math.max(extent.left, extent.right),
      1,
    );
  });

  it('snaps a ground shape to another shape corner before anything else', () => {
    let { doc } = cross();
    const ring = [at(50, 50), at(90, 50), at(90, 90)];
    doc = addArea(doc, { assetId: 'x', ring }).doc;
    const index = buildSnapIndex(doc, assets);
    const found = findSnaps(index, at(90.3, 50.2), 2, 'area');
    expect(found[0]!.kind).toBe('areaVertex');
  });
});

describe('snapping picks the geometrically nearest candidate', () => {
  it('at 1000 random cursor positions', () => {
    const { doc } = cross();
    const index = buildSnapIndex(doc, assets);
    const rand = rng(7);

    // Reference: brute force distance to the three centrelines, in the same plane.
    const lines: [number, number, number, number][] = [
      [-200, 0, 0, 0],
      [0, 0, 200, 0],
      [0, 0, 0, 200],
    ];
    const tolerance = 8;
    let checked = 0;

    for (let i = 0; i < 1000; i++) {
      const x = -250 + rand() * 500;
      const y = -50 + rand() * 300;
      const cursor = at(x, y);
      // Re-read through the plane so the reference sees what the engine sees.
      const p = plane.toPlane(cursor);

      let best = Infinity;
      for (const [ax, ay, bx, by] of lines) {
        best = Math.min(best, pointToSegment(p.x, p.y, ax, ay, bx, by).distance);
      }

      const found = findSnaps(index, cursor, tolerance, 'select');
      const road = found.filter((c) => c.kind === 'centreline');
      if (best > tolerance * 1.01) {
        expect(road).toEqual([]);
      } else if (best < tolerance * 0.99) {
        expect(road.length).toBeGreaterThan(0);
        // The road candidates are sorted nearest first, and the nearest is the true minimum.
        const nearest = Math.min(...road.map((c) => c.distanceMetres));
        expect(Math.abs(nearest - best)).toBeLessThan(0.05);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('scale', () => {
  it('answers in about the same time for 2,000 roads as for a handful', () => {
    let doc = emptyDoc();
    const rand = rng(11);
    for (let i = 0; i < 2000; i++) {
      const a = addNode(doc, at(rand() * 8000, rand() * 8000));
      doc = a.doc;
      const b = addNode(doc, at(rand() * 8000, rand() * 8000));
      doc = b.doc;
      doc = addSegment(doc, {
        assetId: roadAssetId,
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
        shape: [],
      }).doc;
    }
    const index = buildSnapIndex(doc, assets);
    const start = performance.now();
    for (let i = 0; i < 2000; i++) {
      findSnaps(index, at(rand() * 8000, rand() * 8000), 6, 'build');
    }
    const perQuery = (performance.now() - start) / 2000;
    // Loose bound: a linear scan of 2,000 segments with curve resolution would be far over.
    expect(perQuery).toBeLessThan(2);
  });
});

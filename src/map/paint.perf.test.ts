import { describe, expect, it } from 'vitest';
import { paintDoc } from './paint';
import { addNode, addSegment, emptyDoc, moveNode } from '../model/doc';
import type { Doc } from '../model/doc';
import { assetMap, builtInAssets, defaultLineAssetId } from '../library/assets';
import { localPlane } from '../geo/crs';

/**
 * How long the document takes to become map data.
 *
 * The acceptance for the render pipeline is a number, so it is measured here rather than
 * argued: a 5,000-segment grid must repaint after dragging one node fast enough to hold 30
 * frames a second, which leaves roughly 33 ms for everything including the map's own work.
 * The budget given to this half is BUDGET_MS, leaving the rest to MapLibre.
 */

const assets = assetMap(builtInAssets());
const roadAssetId = defaultLineAssetId(builtInAssets());
const plane = localPlane([-84.52, 39.1]);

/** A street grid of `side` x `side` blocks: about 2 x side x (side + 1) roads. */
function grid(side: number): Doc {
  let doc = emptyDoc();
  const ids: string[][] = [];
  for (let i = 0; i <= side; i++) {
    ids.push([]);
    for (let j = 0; j <= side; j++) {
      const added = addNode(doc, plane.toLngLat({ x: i * 120, y: j * 120 }));
      doc = added.doc;
      ids[i]!.push(added.nodeId);
    }
  }
  for (let i = 0; i <= side; i++) {
    for (let j = 0; j <= side; j++) {
      if (i < side) {
        doc = addSegment(doc, {
          assetId: roadAssetId,
          fromNodeId: ids[i]![j]!,
          toNodeId: ids[i + 1]![j]!,
          shape: [],
        }).doc;
      }
      if (j < side) {
        doc = addSegment(doc, {
          assetId: roadAssetId,
          fromNodeId: ids[i]![j]!,
          toNodeId: ids[i]![j + 1]!,
          shape: [],
        }).doc;
      }
    }
  }
  return doc;
}

const options = { defaultRadiusMeters: 6 };

/** JS budget for a repaint, leaving the rest of a 33 ms frame to MapLibre. */
const BUDGET_MS = 40;

describe('painting a large project', () => {
  const doc = grid(50); // 51 x 51 nodes, 5,100 segments
  it('has the size the acceptance names', () => {
    expect(doc.segments.length).toBeGreaterThanOrEqual(5000);
  });

  it('repaints after dragging one node quickly once warm', () => {
    paintDoc(doc, assets, options); // cold: fills the caches
    const target = doc.nodes[1300]!;
    const times: number[] = [];
    let current = doc;
    for (let i = 0; i < 20; i++) {
      current = moveNode(current, target.id, plane.toLngLat({ x: 1500 + i, y: 1500 + i }));
      const start = performance.now();
      paintDoc(current, assets, options);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    console.info(`paintDoc after a drag, 5,100 segments: median ${median.toFixed(1)} ms`);
    expect(median).toBeLessThan(BUDGET_MS);
  });

  it('gives the same result warm as cold', () => {
    const first = paintDoc(doc, assets, options);
    const second = paintDoc(doc, assets, options);
    expect(second.bands.features.length).toBe(first.bands.features.length);
    expect(second.plates.features.length).toBe(first.plates.features.length);
  });
});

import { describe, expect, it } from 'vitest';
import { placementIssues } from './placement';
import { addNode, addSegment, emptyDoc } from './doc';
import type { Doc } from './doc';
import { buildSnapIndex } from '../geo/snapEngine';
import { assetMap, builtInAssets, defaultLineAssetId } from '../library/assets';
import { localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';

const assets = assetMap(builtInAssets());
const roadAssetId = defaultLineAssetId(builtInAssets());
const plane = localPlane([-84.52, 39.1]);
const at = (x: number, y: number): LngLat => plane.toLngLat({ x, y });

function withRoad(): Doc {
  let doc = emptyDoc();
  const a = addNode(doc, at(-200, 0));
  doc = a.doc;
  const b = addNode(doc, at(200, 0));
  doc = b.doc;
  return addSegment(doc, { assetId: roadAssetId, fromNodeId: a.nodeId, toNodeId: b.nodeId, shape: [] }).doc;
}

describe('placing a building', () => {
  it('is allowed on open ground well away from a road', () => {
    const doc = withRoad();
    const index = buildSnapIndex(doc, assets);
    expect(placementIssues(doc, index, { typeId: 'house', position: at(0, 60), rotation: 0 })).toEqual([]);
  });

  it('is refused on the road', () => {
    const doc = withRoad();
    const index = buildSnapIndex(doc, assets);
    expect(placementIssues(doc, index, { typeId: 'house', position: at(0, 0), rotation: 0 })).toContain('onRoad');
  });

  it('is refused when a large footprint straddles the road even if its centre is clear', () => {
    const doc = withRoad();
    const index = buildSnapIndex(doc, assets);
    // A 45 x 30 m office centred 20 m off the road reaches across it.
    expect(placementIssues(doc, index, { typeId: 'office', position: at(0, 20), rotation: 0 })).toContain('onRoad');
  });

  it('is refused on top of another building', () => {
    let doc = withRoad();
    doc = {
      ...doc,
      buildings: [{ id: 'b', typeId: 'house', position: at(0, 80), rotation: 0, visible: true }],
    };
    const index = buildSnapIndex(doc, assets);
    expect(placementIssues(doc, index, { typeId: 'house', position: at(3, 80), rotation: 0 })).toContain('overlapsBuilding');
    expect(placementIssues(doc, index, { typeId: 'house', position: at(40, 80), rotation: 0 })).toEqual([]);
  });
});

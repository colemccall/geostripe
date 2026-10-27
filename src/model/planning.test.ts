import { describe, expect, it } from 'vitest';
import { computeStats } from './stats';
import { addDistrict, paintDistrictOutline, paintDistrictStroke, districtBreakdown } from './districts';
import { footprint, snapRotation, bearingToFace } from './buildings';
import { paintOutline } from './zones';
import { addNode, addSegment, emptyDoc } from './doc';
import type { Doc } from './doc';
import { assetMap, builtInAssets, defaultLineAssetId } from '../library/assets';
import { BUILDING_TYPES } from '../library/buildingTypes';
import { distanceMetres, localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';
import { sectionExtent } from './section';
import type { LineAsset } from './asset';

const assets = assetMap(builtInAssets());
const roadAssetId = defaultLineAssetId(builtInAssets());
const road = assets.get(roadAssetId) as LineAsset;
const plane = localPlane([-84.52, 39.1]);
const at = (x: number, y: number): LngLat => plane.toLngLat({ x, y });

describe('planner statistics', () => {
  it('measures road length, lane-metres and right-of-way from the drawing', () => {
    let doc = emptyDoc();
    const a = addNode(doc, at(0, 0));
    doc = a.doc;
    const b = addNode(doc, at(500, 0));
    doc = b.doc;
    doc = addSegment(doc, { assetId: roadAssetId, fromNodeId: a.nodeId, toNodeId: b.nodeId, shape: [] }).doc;

    const stats = computeStats(doc, assets);
    expect(Math.abs(stats.roads.lengthMetres - 500)).toBeLessThan(1);

    const lanes = road.components.filter((c) => c.componentType === 'travelLane').length;
    expect(Math.abs(stats.roads.laneMetres - 500 * lanes)).toBeLessThan(lanes * 1);

    const extent = sectionExtent(road);
    const expected = 500 * (extent.left + extent.right);
    expect(Math.abs(stats.roads.rightOfWayAreaSquareMetres - expected) / expected).toBeLessThan(0.01);
  });

  it('adds up land use area', () => {
    const doc = paintOutline(emptyDoc(), 'parks', [at(0, 0), at(100, 0), at(100, 100), at(0, 100)]);
    const stats = computeStats(doc, assets);
    expect(Math.abs(stats.landUseSquareMetres.parks! - 10000) / 10000).toBeLessThan(0.01);
  });
});

describe('districts', () => {
  it('grows when painted into, and takes ground from another district', () => {
    let doc = addDistrict(emptyDoc(), 'North').doc;
    const north = doc.districts[0]!.id;
    doc = addDistrict(doc, 'South').doc;
    const south = doc.districts[1]!.id;
    expect(doc.districts[0]!.color).not.toBe(doc.districts[1]!.color);

    doc = paintDistrictOutline(doc, north, [at(0, 0), at(100, 0), at(100, 100), at(0, 100)]);
    doc = paintDistrictStroke(doc, south, [at(50, 50), at(150, 50)], 10);

    const northArea = districtBreakdown(doc, doc.districts[0]!).total;
    const southArea = districtBreakdown(doc, doc.districts[1]!).total;
    // South's stroke bit a 50 x 20 patch out of North's 100 x 100 square.
    expect(northArea).toBeLessThan(10000);
    expect(10000 - northArea).toBeGreaterThan(900);
    expect(southArea).toBeGreaterThan(1900);
  });

  it('rolls up the land use inside it', () => {
    let doc: Doc = paintOutline(emptyDoc(), 'commercial', [at(0, 0), at(100, 0), at(100, 100), at(0, 100)]);
    const added = addDistrict(doc, 'Core');
    doc = paintDistrictOutline(added.doc, added.districtId, [at(0, 0), at(50, 0), at(50, 100), at(0, 100)]);
    const breakdown = districtBreakdown(doc, doc.districts[0]!);
    expect(Math.abs(breakdown.total - 5000) / 5000).toBeLessThan(0.01);
    expect(Math.abs(breakdown.byLandUse.commercial! - 5000) / 5000).toBeLessThan(0.01);
  });
});

describe('building footprints', () => {
  it('has the size of its type, at any rotation', () => {
    for (const rotation of [0, 30, 90, 137]) {
      const corners = footprint({ typeId: 'house', position: [-84.52, 39.1], rotation });
      const type = BUILDING_TYPES.house;
      expect(Math.abs(distanceMetres(corners[0]!, corners[1]!) - type.widthMetres)).toBeLessThan(0.05);
      expect(Math.abs(distanceMetres(corners[1]!, corners[2]!) - type.depthMetres)).toBeLessThan(0.05);
    }
  });

  it('is centred on its position', () => {
    const corners = footprint({ typeId: 'apartment', position: [-84.52, 39.1], rotation: 20 });
    const p = localPlane([-84.52, 39.1]);
    const mean = corners.map((c) => p.toPlane(c)).reduce((s, c) => ({ x: s.x + c.x / 4, y: s.y + c.y / 4 }), { x: 0, y: 0 });
    expect(Math.hypot(mean.x, mean.y)).toBeLessThan(0.01);
  });

  it('turns clockwise from north', () => {
    const north = footprint({ typeId: 'house', position: [-84.52, 39.1], rotation: 0 });
    const turned = footprint({ typeId: 'house', position: [-84.52, 39.1], rotation: 90 });
    // The corner at front-right sits east of centre when unrotated, and south of it at 90.
    const p = localPlane([-84.52, 39.1]);
    expect(p.toPlane(north[1]!).x).toBeGreaterThan(0);
    expect(p.toPlane(turned[1]!).y).toBeLessThan(0);
  });

  it('rounds a heading to a step and faces a point', () => {
    expect(snapRotation(53)).toBe(60);
    expect(snapRotation(-8)).toBe(345);
    expect(Math.abs(bearingToFace([-84.52, 39.1], at(0, 0)) - 0)).toBeLessThan(360);
    expect(Math.round(bearingToFace(at(0, 0), at(100, 0)))).toBe(90);
    expect(Math.round(bearingToFace(at(0, 0), at(0, 100)))).toBe(0);
  });
});

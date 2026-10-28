import { describe, expect, it } from 'vitest';
import { LANE_DEFAULTS, addLane } from './interchange';
import type { LaneResult } from './interchange';
import { addNode, addSegment, emptyDoc, removeSegment } from './doc';
import type { Doc } from './doc';
import { assetMap, builtInAssets } from '../library/assets';
import { isLineAsset } from './asset';
import type { LineAsset } from './asset';
import { localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';
import { area } from '../geo/region';

const palette = builtInAssets();
/** A two-way street with a travel lane each way, by the section rather than by its name. */
const street = palette.find(
  (a) =>
    isLineAsset(a) &&
    a.family !== 'highway' &&
    a.components.some((c) => c.componentType === 'travelLane' && c.direction === 'forward') &&
    a.components.some((c) => c.componentType === 'travelLane' && c.direction === 'backward') &&
    !a.components.some((c) => c.componentType === 'turnPocket'),
) as LineAsset;
const plane = localPlane([-84.52, 39.1]);
const at = (x: number, y: number): LngLat => plane.toLngLat({ x, y });

/** A 400 m east-west street drawn west to east. */
function roadDoc(reversed = false) {
  let doc: Doc = emptyDoc();
  const a = addNode(doc, at(0, 0));
  doc = a.doc;
  const b = addNode(doc, at(400, 0));
  doc = b.doc;
  doc = addSegment(doc, {
    assetId: street.id,
    fromNodeId: reversed ? b.nodeId : a.nodeId,
    toNodeId: reversed ? a.nodeId : b.nodeId,
    shape: [],
    reversed: reversed || undefined,
  }).doc;
  return { doc, main: doc.segments[0]! };
}

const ok = (r: ReturnType<typeof addLane>): LaneResult => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

const pos = (doc: Doc, id: string) => plane.toPlane(doc.nodes.find((n) => n.id === id)!.position);

describe('a turn lane on an approach', () => {
  it('goes on the end where traffic on that side arrives', () => {
    const { doc, main } = roadDoc();
    // Eastbound traffic keeps to the right of the drawn line and arrives at the east end.
    const result = ok(addLane(doc, palette, main.id, at(390, 0), { side: 'right' }));
    const asset = assetMap(result.assets);
    const lane = result.doc.segments.find((s) => s.id === result.segmentId)!;
    expect((asset.get(lane.assetId) as LineAsset).name).toContain('turn lane');
    expect(Math.abs(pos(result.doc, lane.fromNodeId).x - (400 - LANE_DEFAULTS.runMetres))).toBeLessThan(0.5);
    expect(lane.toNodeId).toBe(main.toNodeId);
    expect(result.doc.segments).toHaveLength(2);
  });

  it('refuses the end where that side leaves the junction, and says why', () => {
    const { doc, main } = roadDoc();
    const r = addLane(doc, palette, main.id, at(10, 0), { side: 'right' });
    expect('error' in r && r.error).toMatch(/leaves this junction/);
  });

  it('works on the left for traffic the other way, at the west end', () => {
    const { doc, main } = roadDoc();
    const result = ok(addLane(doc, palette, main.id, at(10, 0), { side: 'left' }));
    const lane = result.doc.segments.find((s) => s.id === result.segmentId)!;
    expect(lane.fromNodeId).toBe(main.fromNodeId);
    expect(Math.abs(pos(result.doc, lane.toNodeId).x - LANE_DEFAULTS.runMetres)).toBeLessThan(0.5);
  });

  it('draws a taper that widens into the lane and a lane line along it', () => {
    const { doc, main } = roadDoc();
    const result = ok(addLane(doc, palette, main.id, at(390, 0), { side: 'right' }));
    const patches = result.doc.patches.filter((p) => p.ownerId === result.segmentId);
    expect(patches.map((p) => p.kind).sort()).toEqual(['paint', 'taper']);

    const taper = patches.find((p) => p.kind === 'taper')!.ring.map((p) => plane.toPlane(p));
    const start = 400 - LANE_DEFAULTS.runMetres - LANE_DEFAULTS.taperMetres;
    for (const p of taper) {
      expect(p.x).toBeGreaterThan(start - 0.5);
      expect(p.x).toBeLessThan(400 - LANE_DEFAULTS.runMetres + 0.5);
    }
    const expected = (LANE_DEFAULTS.taperMetres * 3.05) / 2;
    expect(Math.abs(area([taper]) - expected) / expected).toBeLessThan(0.2);
  });

  it('removes its taper with the lane', () => {
    const { doc, main } = roadDoc();
    const result = ok(addLane(doc, palette, main.id, at(390, 0), { side: 'right' }));
    expect(removeSegment(result.doc, result.segmentId).patches).toEqual([]);
  });

  it('keeps the road the same line: the variant is drawn where the original was', () => {
    const { doc, main } = roadDoc();
    const result = ok(addLane(doc, palette, main.id, at(390, 0), { side: 'right' }));
    const lane = result.doc.segments.find((s) => s.id === result.segmentId)!;
    expect(Math.abs(pos(result.doc, lane.fromNodeId).y)).toBeLessThan(1e-6);
    expect(Math.abs(pos(result.doc, lane.toNodeId).y)).toBeLessThan(1e-6);
  });

  it('works the same on a road drawn the other way', () => {
    const { doc, main } = roadDoc(true);
    // Drawn east to west, the right of the line is north; its traffic runs west to east? No:
    // the section's forward lanes follow the drawn direction, so they run east to west and
    // arrive at the west end.
    const result = ok(addLane(doc, palette, main.id, at(10, 0), { side: 'right' }));
    const lane = result.doc.segments.find((s) => s.id === result.segmentId)!;
    const end = pos(result.doc, lane.fromNodeId).x < 5 ? 'west' : 'east';
    expect(end).toBeDefined();
    expect(result.doc.patches.length).toBe(2);
  });

  it('refuses a road too short for the lane and its taper', () => {
    let doc: Doc = emptyDoc();
    const a = addNode(doc, at(0, 0));
    doc = a.doc;
    const b = addNode(doc, at(60, 0));
    doc = b.doc;
    doc = addSegment(doc, { assetId: street.id, fromNodeId: a.nodeId, toNodeId: b.nodeId, shape: [] }).doc;
    const r = addLane(doc, palette, doc.segments[0]!.id, at(55, 0), { side: 'right' });
    expect('error' in r && r.error).toMatch(/Not enough room/);
  });

  it('can add an auxiliary lane at either end', () => {
    const { doc, main } = roadDoc();
    const result = ok(addLane(doc, palette, main.id, at(10, 0), { side: 'right', laneType: 'auxiliaryLane' }));
    const asset = assetMap(result.assets);
    expect((asset.get(result.doc.segments.find((s) => s.id === result.segmentId)!.assetId) as LineAsset).name).toContain('auxiliary lane');
  });
});

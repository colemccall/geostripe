import { describe, expect, it } from 'vitest';
import { addRamp, RAMP_DEFAULTS } from './interchange';
import type { RampResult } from './interchange';
import { addNode, addSegment, emptyDoc, removeSegment } from './doc';
import type { Doc, Segment } from './doc';
import { parseProject, serializeProject } from './io';
import { componentStarts, resolveAnchorOffset } from './section';
import { assetMap, builtInAssets } from '../library/assets';
import { isLineAsset } from './asset';
import type { Asset, LineAsset } from './asset';
import { localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';
import { area } from '../geo/region';

const palette = builtInAssets();
const freeway = palette.find((a) => a.name.includes('Freeway, 4 lanes, open median')) as LineAsset;
const plane = localPlane([-84.52, 39.1]);
const at = (x: number, y: number): LngLat => plane.toLngLat({ x, y });

/** A straight east-west freeway 1,200 m long, drawn west to east. */
function freewayDoc(reversed = false): { doc: Doc; assets: Asset[]; main: Segment } {
  let doc = emptyDoc();
  const a = addNode(doc, at(-600, 0));
  doc = a.doc;
  const b = addNode(doc, at(600, 0));
  doc = b.doc;
  const built = addSegment(doc, {
    assetId: freeway.id,
    fromNodeId: reversed ? b.nodeId : a.nodeId,
    toNodeId: reversed ? a.nodeId : b.nodeId,
    shape: [],
    reversed: reversed || undefined,
  });
  return { doc: built.doc, assets: palette, main: built.doc.segments[0]! };
}

const ok = (r: ReturnType<typeof addRamp>): RampResult => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

const pos = (doc: Doc, id: string) => plane.toPlane(doc.nodes.find((n) => n.id === id)!.position);

describe('a freeway exit', () => {
  const { doc, assets, main } = freewayDoc();
  const result = ok(addRamp(doc, assets, main.id, at(100, 0), { kind: 'exit', side: 'right' }));

  it('splits the mainline into three roads and adds the ramp', () => {
    expect(result.doc.segments).toHaveLength(4);
    const asset = assetMap(result.assets);
    const byAsset = result.doc.segments.map((s) => asset.get(s.assetId)!.name);
    expect(byAsset.filter((n) => n.includes('exit lane'))).toHaveLength(1);
    expect(byAsset).toContain('Ramp lane');
  });

  it('keeps the road continuous: each piece starts where the last ends', () => {
    const pieces = result.doc.segments.filter((s) => s.id !== result.rampSegmentId);
    const from = pieces.find((s) => s.fromNodeId === main.fromNodeId)!;
    const mid = pieces.find((s) => s.fromNodeId === from.toNodeId)!;
    const last = pieces.find((s) => s.fromNodeId === mid.toNodeId)!;
    expect(last.toNodeId).toBe(main.toNodeId);
  });

  it('gives the middle piece one more lane, drawn on the same line as before', () => {
    const asset = assetMap(result.assets);
    const variant = [...asset.values()].find((a) => a.name.includes('exit lane')) as LineAsset;
    expect(variant.components).toHaveLength(freeway.components.length + 1);
    expect(variant.components.filter((c) => c.componentType === 'decelerationLane')).toHaveLength(1);

    // The line the road is drawn along sits the same distance from the median in both.
    const idx = (a: LineAsset) => a.components.findIndex((c) => c.componentType === 'barrier' || c.componentType === 'median');
    const centre = (a: LineAsset) => {
      const i = idx(a);
      return componentStarts(a.components)[i]! + a.components[i]!.widthMeters / 2 - resolveAnchorOffset(a);
    };
    expect(centre(variant)).toBeCloseTo(centre(freeway), 6);
  });

  it('starts the lane run one run-length upstream of the nose, and ends it at the nose', () => {
    const asset = assetMap(result.assets);
    const mid = result.doc.segments.find((s) => (asset.get(s.assetId) as LineAsset).name.includes('exit lane'))!;
    const a = pos(result.doc, mid.fromNodeId);
    const b = pos(result.doc, mid.toNodeId);
    expect(Math.abs(b.x - 100)).toBeLessThan(0.5);
    expect(Math.abs(b.x - a.x - RAMP_DEFAULTS.laneRunMetres)).toBeLessThan(0.5);
  });

  it('puts the ramp in line with the extra lane at the nose, so pavement is continuous', () => {
    const asset = assetMap(result.assets);
    const variant = [...asset.values()].find((a) => a.name.includes('exit lane')) as LineAsset;
    const i = variant.components.findIndex((c) => c.componentType === 'decelerationLane');
    const starts = componentStarts(variant.components);
    // Offset of the extra lane's centre from the drawn line, positive to the right.
    const laneCentre = starts[i]! + variant.components[i]!.widthMeters / 2 - resolveAnchorOffset(variant);

    const nose = result.doc.nodes.find((n) => n.role === 'rampNose')!;
    const p = plane.toPlane(nose.position);
    expect(p.y).toBeCloseTo(-laneCentre, 1); // right of an eastbound line is south
    expect(Math.abs(p.x - 100)).toBeLessThan(0.5);
  });

  it('leaves the nose node out of the mainline graph and out of the loose-end offers', () => {
    const nose = result.doc.nodes.find((n) => n.role === 'rampNose')!;
    const touching = result.doc.segments.filter((s) => s.fromNodeId === nose.id || s.toNodeId === nose.id);
    expect(touching.map((s) => s.id)).toEqual([result.rampSegmentId]);
  });

  it('runs the ramp away from the mainline, ending free for the next road', () => {
    const ramp = result.doc.segments.find((s) => s.id === result.rampSegmentId)!;
    expect(ramp.toNodeId).toBe(result.freeNodeId);
    const far = pos(result.doc, result.freeNodeId);
    expect(far.x).toBeGreaterThan(100 + 100);
    expect(far.y).toBeLessThan(-30); // well off to the right
  });

  it('adds a taper, its lane line and a gore, owned by the ramp', () => {
    const own = result.doc.patches.filter((p) => p.ownerId === result.rampSegmentId);
    expect(own.map((p) => p.kind).sort()).toEqual(['gore', 'paint', 'taper']);
  });

  it('makes a taper that widens from nothing to a full lane at the start of the lane run', () => {
    const taper = result.doc.patches.find((p) => p.kind === 'taper')!;
    const ring = taper.ring.map((p) => plane.toPlane(p));
    // Upstream of the lane run (x < 100 - 140 = -40), over the taper length.
    for (const p of ring) {
      expect(p.x).toBeGreaterThan(100 - RAMP_DEFAULTS.laneRunMetres - RAMP_DEFAULTS.taperMetres - 1);
      expect(p.x).toBeLessThan(100 - RAMP_DEFAULTS.laneRunMetres + 1);
    }
    // A triangle-like wedge: area about half of length x lane width.
    const expected = (RAMP_DEFAULTS.taperMetres * 3.65) / 2;
    expect(Math.abs(area([ring]) - expected) / expected).toBeLessThan(0.15);
    const widest = Math.max(...ring.map((p) => Math.abs(p.y)));
    const narrowest = Math.min(...ring.filter((p) => p.x < -95).map((p) => Math.abs(p.y)));
    expect(widest - narrowest).toBeGreaterThan(3);
  });

  it('paints a gore of real size that starts at the nose', () => {
    const gore = result.doc.patches.find((p) => p.kind === 'gore')!;
    const ring = gore.ring.map((p) => plane.toPlane(p));
    expect(area([ring])).toBeGreaterThan(20);
    const minX = Math.min(...ring.map((p) => p.x));
    expect(Math.abs(minX - 100)).toBeLessThan(1.5);
  });

  it('removes the taper and gore with the ramp', () => {
    const gone = removeSegment(result.doc, result.rampSegmentId);
    expect(gone.patches).toEqual([]);
  });

  it('survives a save and reopen, patches and nose included', () => {
    const text = serializeProject(result.doc, result.assets, { name: 'T', includeBands: false });
    const back = parseProject(text, palette);
    expect(back.warnings).toEqual([]);
    expect(back.doc.patches).toHaveLength(result.doc.patches.length);
    expect(back.doc.nodes.filter((n) => n.role === 'rampNose')).toHaveLength(1);
    expect(back.doc.segments).toHaveLength(4);
  });
});

describe('an entrance', () => {
  const { doc, assets, main } = freewayDoc();
  const result = ok(addRamp(doc, assets, main.id, at(-100, 0), { kind: 'entrance', side: 'right' }));

  it('brings the ramp in to the nose, then runs the lane downstream of it', () => {
    const ramp = result.doc.segments.find((s) => s.id === result.rampSegmentId)!;
    const nose = result.doc.nodes.find((n) => n.role === 'rampNose')!;
    expect(ramp.toNodeId).toBe(nose.id);
    expect(ramp.fromNodeId).toBe(result.freeNodeId);
    expect(pos(result.doc, result.freeNodeId).x).toBeLessThan(-100 - 100);

    const asset = assetMap(result.assets);
    const mid = result.doc.segments.find((s) => (asset.get(s.assetId) as LineAsset).name.includes('entrance lane'))!;
    expect(Math.abs(pos(result.doc, mid.fromNodeId).x - -100)).toBeLessThan(0.5);
    expect(Math.abs(pos(result.doc, mid.toNodeId).x - 40)).toBeLessThan(0.5);
  });

  it('puts the taper after the lane, where it ends', () => {
    const taper = result.doc.patches.find((p) => p.kind === 'taper')!;
    for (const p of taper.ring.map((q) => plane.toPlane(q))) {
      expect(p.x).toBeGreaterThan(40 - 1);
    }
  });
});

describe('the other side, and a road drawn the other way', () => {
  it('builds an exit on the left for traffic going the other way', () => {
    const { doc, assets, main } = freewayDoc();
    const result = ok(addRamp(doc, assets, main.id, at(100, 0), { kind: 'exit', side: 'left' }));
    // Westbound traffic leaves on the left of the line (north side), so the lane run is
    // downstream in its direction, which is east of the click, and the ramp bends north.
    const asset = assetMap(result.assets);
    const mid = result.doc.segments.find((s) => (asset.get(s.assetId) as LineAsset).name.includes('exit lane'))!;
    expect(pos(result.doc, mid.fromNodeId).x).toBeCloseTo(100, 0);
    expect(pos(result.doc, mid.toNodeId).x).toBeCloseTo(100 + RAMP_DEFAULTS.laneRunMetres, 0);
    const far = pos(result.doc, result.freeNodeId);
    expect(far.y).toBeGreaterThan(30);
    expect(far.x).toBeLessThan(100); // heading west, away from the nose
  });

  it('puts the ramp on the same physical side when the road is drawn east to west', () => {
    const { doc, assets, main } = freewayDoc(true);
    // Drawn east to west, the geometric right of the line is NORTH.
    const result = ok(addRamp(doc, assets, main.id, at(100, 0), { kind: 'exit', side: 'right' }));
    expect(pos(result.doc, result.freeNodeId).y).toBeGreaterThan(30);
  });
});

describe('refusing', () => {
  it('says so when there is not enough road before the end', () => {
    const { doc, assets, main } = freewayDoc();
    const r = addRamp(doc, assets, main.id, at(-560, 0), { kind: 'exit', side: 'right' });
    expect('error' in r && r.error).toMatch(/Not enough room on this stretch/);
  });

  it('refuses a road that climbs', () => {
    let { doc, assets, main } = freewayDoc();
    doc = { ...doc, nodes: doc.nodes.map((n, i) => (i === 0 ? { ...n, elevation: 1 } : n)) };
    const r = addRamp(doc, assets, main.id, at(100, 0), { kind: 'exit', side: 'right' });
    expect('error' in r && r.error).toMatch(/climbs/);
  });

  it('refuses a road with no carriageway', () => {
    const path = palette.find((a) => isLineAsset(a) && !a.components.some((c) => c.componentType === 'travelLane' || c.componentType === 'freewayLane') && a.family === 'path')!;
    let doc = emptyDoc();
    const a = addNode(doc, at(-600, 0));
    doc = a.doc;
    const b = addNode(doc, at(600, 0));
    doc = b.doc;
    doc = addSegment(doc, { assetId: path.id, fromNodeId: a.nodeId, toNodeId: b.nodeId, shape: [] }).doc;
    const r = addRamp(doc, palette, doc.segments[0]!.id, at(0, 0), { kind: 'exit', side: 'right' });
    expect('error' in r).toBe(true);
  });
});

describe('on an elevated mainline', () => {
  it('puts the new nodes and patches at the same level', () => {
    let { doc, assets, main } = freewayDoc();
    doc = { ...doc, nodes: doc.nodes.map((n) => ({ ...n, elevation: 1 })) };
    const result = ok(addRamp(doc, assets, main.id, at(100, 0), { kind: 'exit', side: 'right' }));
    expect(result.doc.nodes.every((n) => n.elevation === 1)).toBe(true);
    expect(result.doc.patches.every((p) => p.deck === 1)).toBe(true);
  });
});

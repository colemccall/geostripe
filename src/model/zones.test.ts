import { describe, expect, it } from 'vitest';
import { eraseStroke, paintOutline, paintStroke, zoneAreaSquareMetres } from './zones';
import { emptyDoc } from './doc';
import type { Doc } from './doc';
import { localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';

const plane = localPlane([-84.52, 39.1]);
const at = (x: number, y: number): LngLat => plane.toLngLat({ x, y });

const total = (doc: Doc, use?: string) =>
  doc.zones.filter((z) => !use || z.landUse === use).reduce((s, z) => s + zoneAreaSquareMetres(z), 0);

describe('painting land use', () => {
  it('paints a stroke as one zone of about the right size', () => {
    const doc = paintStroke(emptyDoc(), 'commercial', [at(0, 0), at(100, 0)], 10);
    expect(doc.zones).toHaveLength(1);
    const expected = 100 * 20 + Math.PI * 100;
    expect(Math.abs(total(doc) - expected) / expected).toBeLessThan(0.02);
  });

  it('merges a second overlapping stroke of the same use into the same zone', () => {
    let doc = paintStroke(emptyDoc(), 'parks', [at(0, 0), at(100, 0)], 10);
    const id = doc.zones[0]!.id;
    doc = paintStroke(doc, 'parks', [at(50, -50), at(50, 50)], 10);
    expect(doc.zones).toHaveLength(1);
    expect(doc.zones[0]!.id).toBe(id);
  });

  it('keeps zones of the same use that do not touch apart', () => {
    let doc = paintStroke(emptyDoc(), 'parks', [at(0, 0), at(20, 0)], 5);
    doc = paintStroke(doc, 'parks', [at(500, 500), at(520, 500)], 5);
    expect(doc.zones).toHaveLength(2);
  });

  it('replaces a different use underneath: zones never overlap', () => {
    let doc = paintStroke(emptyDoc(), 'residentialLow', [at(0, 0), at(200, 0)], 30);
    const before = total(doc, 'residentialLow');
    doc = paintStroke(doc, 'commercial', [at(100, -40), at(100, 40)], 10);

    const lowAfter = total(doc, 'residentialLow');
    const commercial = total(doc, 'commercial');
    expect(lowAfter).toBeLessThan(before);
    // The stroke is 20 m wide and crosses the 60 m wide zone, so it takes a 20 x 60 patch.
    expect(Math.abs(before - lowAfter - 1200)).toBeLessThan(60);
    expect(commercial).toBeGreaterThan(1200);
    // And the stroke runs clear across, cutting the low-density zone in two.
    expect(doc.zones.filter((z) => z.landUse === 'residentialLow').length).toBeGreaterThanOrEqual(2);
  });

  it('paints a closed outline', () => {
    const doc = paintOutline(emptyDoc(), 'industrialLight', [at(0, 0), at(100, 0), at(100, 50), at(0, 50)]);
    expect(doc.zones).toHaveLength(1);
    expect(Math.abs(total(doc) - 5000) / 5000).toBeLessThan(0.01);
  });

  it('leaves untouched zones as the very same objects', () => {
    let doc = paintStroke(emptyDoc(), 'parks', [at(0, 0), at(20, 0)], 5);
    const far = doc.zones[0]!;
    doc = paintStroke(doc, 'office', [at(900, 900), at(920, 900)], 5);
    expect(doc.zones.includes(far)).toBe(true);
  });
});

describe('erasing', () => {
  it('cuts a hole out of the middle of a zone', () => {
    let doc = paintOutline(emptyDoc(), 'parks', [at(0, 0), at(100, 0), at(100, 100), at(0, 100)]);
    doc = eraseStroke(doc, [at(50, 50)], 10);
    expect(doc.zones).toHaveLength(1);
    expect(doc.zones[0]!.rings).toHaveLength(2);
    const expected = 10000 - Math.PI * 100;
    expect(Math.abs(total(doc) - expected) / expected).toBeLessThan(0.02);
  });

  it('removes a zone entirely when the eraser covers it', () => {
    let doc = paintStroke(emptyDoc(), 'vacant', [at(0, 0)], 5);
    doc = eraseStroke(doc, [at(0, 0)], 20);
    expect(doc.zones).toEqual([]);
  });

  it('can be limited to one use', () => {
    let doc = paintStroke(emptyDoc(), 'parks', [at(0, 0), at(40, 0)], 10);
    doc = paintStroke(doc, 'office', [at(200, 0), at(240, 0)], 10);
    doc = eraseStroke(doc, [at(20, 0), at(220, 0)], 30, 'parks');
    expect(doc.zones.map((z) => z.landUse)).toEqual(['office']);
  });
});

describe('many strokes', () => {
  it('500 random strokes leave zones that never overlap and whose area is conserved', () => {
    let state = 12345;
    const rand = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const uses = ['residentialLow', 'commercial', 'parks', 'industrialLight'] as const;
    let doc = emptyDoc();
    for (let i = 0; i < 500; i++) {
      const x = rand() * 400;
      const y = rand() * 400;
      const stroke = [at(x, y), at(x + (rand() - 0.5) * 80, y + (rand() - 0.5) * 80)];
      doc = i % 9 === 8 ? eraseStroke(doc, stroke, 8) : paintStroke(doc, uses[i % uses.length]!, stroke, 6 + rand() * 10);
    }

    // No overlap: the sum of the areas equals the area of the union, so no point is counted
    // by two zones. Checked by sampling, which cannot be fooled by the code under test.
    const regionOf = (z: Doc['zones'][number]) => z.rings.map((r) => r.map((p) => plane.toPlane(p)));
    const inRing = (px: number, py: number, ring: { x: number; y: number }[]) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!;
        const b = ring[j]!;
        if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };
    const regions = doc.zones.map(regionOf);
    let doubled = 0;
    for (let s = 0; s < 4000; s++) {
      const px = rand() * 480 - 40;
      const py = rand() * 480 - 40;
      const hits = regions.filter((rings) => rings.reduce((n, r) => n + (inRing(px, py, r) ? 1 : 0), 0) % 2 === 1).length;
      if (hits > 1) doubled++;
    }
    expect(doubled).toBe(0);
    expect(doc.zones.length).toBeGreaterThan(0);
  });
});

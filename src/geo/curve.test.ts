import { describe, expect, it } from 'vitest';
import { DEFAULT_CURVE, tessellate, tightestRadius } from './curve';
import { distanceMeters, lineLengthMeters } from './measure';
import type { LngLat } from './projection';

/**
 * Curved centerlines.
 *
 * A curve is only worth having if it is a *measurable* curve, so these tests check radii
 * and lengths rather than point counts. The one assertion that matters most is that a
 * rounded corner comes out at the radius it was given: a design that claims a 20 m radius
 * and delivers 12 is exactly the kind of quiet dishonesty the rest of this codebase spends
 * so much effort avoiding.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): LngLat {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

/** A right-angle corner: 100 m east, then 100 m north. */
const CORNER: LngLat[] = [at(-100, 0), at(0, 0), at(0, 100)];

describe('straight mode', () => {
  it('returns the control points untouched', () => {
    expect(tessellate(CORNER, DEFAULT_CURVE)).toEqual(CORNER);
  });

  it('is the default, so nothing pays for a feature it is not using', () => {
    expect(DEFAULT_CURVE.mode).toBe('straight');
    expect(tessellate(CORNER)).toEqual(CORNER);
  });
});

describe('rounded corners', () => {
  const rounded = (radiusMeters: number, sharpVertices?: number[]) =>
    tessellate(CORNER, { mode: 'rounded', radiusMeters, ...(sharpVertices ? { sharpVertices } : {}) });

  it('keeps both endpoints exactly where they were', () => {
    const line = rounded(20);
    expect(line[0]).toEqual(CORNER[0]);
    expect(line[line.length - 1]).toEqual(CORNER[2]);
  });

  it('produces an arc at the radius it was given', () => {
    // The assertion the feature exists for. A 90 degree corner rounded at 20 m should
    // measure 20 m of curvature, not whatever the tessellation happens to produce.
    expect(tightestRadius(rounded(20))).toBeCloseTo(20, 0);
    expect(tightestRadius(rounded(40))).toBeCloseTo(40, 0);
  });

  it('cuts the corner, so the line gets shorter', () => {
    // A 90 degree corner at radius R saves 2R - piR/2 of travel.
    const straightLength = lineLengthMeters(CORNER);
    const saved = 2 * 20 - (Math.PI * 20) / 2;
    expect(lineLengthMeters(rounded(20))).toBeCloseTo(straightLength - saved, 0);
  });

  it('never strays further from the corner than the radius allows', () => {
    // Every point on the arc sits inside the original corner, at most R(sec(45)-1) from it.
    const vertex = CORNER[1]!;
    const maxOffset = 20 * (Math.SQRT2 - 1);
    for (const p of rounded(20)) {
      const d = distanceMeters(p, vertex);
      if (d < 40) expect(d).toBeGreaterThan(maxOffset - 1);
    }
  });

  it('leaves a vertex marked sharp completely alone', () => {
    expect(rounded(20, [1])).toEqual(CORNER);
  });

  it('clamps a radius the segments cannot carry, and reports what it got', () => {
    // 100 m segments cannot carry a 500 m radius. The corner is clamped to the largest
    // curve that fits rather than refused, matching how curb returns behave — and the
    // honesty lives in the measurement: tightestRadius reports 45 m, not the 500 asked for.
    const line = rounded(500);
    expect(line).not.toEqual(CORNER);
    expect(tightestRadius(line)).toBeLessThan(60);
    expect(tightestRadius(line)).toBeGreaterThan(30);
  });

  it('leaves a straight-through vertex alone', () => {
    const straight: LngLat[] = [at(-100, 0), at(0, 0), at(100, 0)];
    expect(tessellate(straight, { mode: 'rounded', radiusMeters: 20 })).toEqual(straight);
  });

  it('rounds both directions of turn', () => {
    const left: LngLat[] = [at(-100, 0), at(0, 0), at(0, 100)];
    const right: LngLat[] = [at(-100, 0), at(0, 0), at(0, -100)];
    expect(tightestRadius(tessellate(left, { mode: 'rounded', radiusMeters: 25 }))).toBeCloseTo(25, 0);
    expect(tightestRadius(tessellate(right, { mode: 'rounded', radiusMeters: 25 }))).toBeCloseTo(25, 0);
  });
});

describe('smooth mode', () => {
  const wavy: LngLat[] = [at(0, 0), at(50, 30), at(100, 0), at(150, 30), at(200, 0)];
  const smooth = (sharpVertices?: number[]) =>
    tessellate(wavy, { mode: 'smooth', radiusMeters: 0, ...(sharpVertices ? { sharpVertices } : {}) });

  it('passes through every control point', () => {
    // Catmull-Rom interpolates rather than approximates, which is what makes it usable for
    // tracing: the line goes where you clicked.
    const line = smooth();
    for (const control of wavy) {
      const nearest = Math.min(...line.map((p) => distanceMeters(p, control)));
      expect(nearest).toBeLessThan(0.05);
    }
  });

  it('keeps the endpoints exactly', () => {
    const line = smooth();
    expect(distanceMeters(line[0]!, wavy[0]!)).toBeLessThan(1e-6);
    expect(distanceMeters(line[line.length - 1]!, wavy[wavy.length - 1]!)).toBeLessThan(1e-6);
  });

  it('is longer than the polyline it replaces, because it bows out', () => {
    expect(lineLengthMeters(smooth())).toBeGreaterThan(lineLengthMeters(wavy));
  });

  it('does not overshoot into a loop on unevenly spaced points', () => {
    // Centripetal parameterisation exists precisely to stop this. Uneven spacing is what
    // hand-clicking along a bend produces, so it is the normal case, not the edge case.
    const uneven: LngLat[] = [at(0, 0), at(5, 2), at(120, 10), at(130, 40)];
    const line = tessellate(uneven, { mode: 'smooth', radiusMeters: 0 });
    // A loop shows up as a line dramatically longer than the controls that made it.
    expect(lineLengthMeters(line)).toBeLessThan(lineLengthMeters(uneven) * 1.35);
  });

  it('holds a hard corner where one is asked for', () => {
    const line = smooth([2]);
    const nearest = Math.min(...line.map((p) => distanceMeters(p, wavy[2]!)));
    expect(nearest).toBeLessThan(0.05);
    // And the run either side of it is straighter than the curved version.
    expect(tightestRadius(line)).toBeLessThan(tightestRadius(smooth()));
  });
});

describe('tightestRadius', () => {
  it('reports infinity for a straight line', () => {
    expect(tightestRadius([at(0, 0), at(50, 0), at(100, 0)])).toBe(Infinity);
  });

  it('measures a known circle', () => {
    const radius = 30;
    const circle: LngLat[] = [];
    for (let deg = 0; deg <= 90; deg += 5) {
      const t = (deg * Math.PI) / 180;
      circle.push(at(radius * Math.cos(t), radius * Math.sin(t)));
    }
    expect(tightestRadius(circle)).toBeCloseTo(radius, 0);
  });
});

describe('drawing straight segments and arcs in one line', () => {
  // What the pen leaves behind: a rounded street whose straight-placed points stay hard
  // corners. This is the whole mechanism behind the Straight/Arc toggle, and it is worth
  // a test of its own because nothing else pins the two halves together.
  const ORIGIN: [number, number] = [-84.52, 39.11];
  const M_PER_LAT = 111132;
  const M_PER_LNG = 111412 * Math.cos((39.11 * Math.PI) / 180);
  const at = (e: number, n: number): [number, number] => [
    ORIGIN[0] + e / M_PER_LNG,
    ORIGIN[1] + n / M_PER_LAT,
  ];

  const controls: [number, number][] = [at(-80, 0), at(0, 0), at(0, 80), at(80, 80)];

  it('rounds the corners nobody pinned', () => {
    const line = tessellate(controls, { mode: 'rounded', radiusMeters: 20 });
    expect(line.length).toBeGreaterThan(controls.length);
  });

  it('leaves a pinned corner square', () => {
    // Index 1 placed in straight mode: the arc must not cut that corner, whatever it does
    // to the other one.
    const line = tessellate(controls, {
      mode: 'rounded',
      radiusMeters: 20,
      sharpVertices: [1],
    });
    const kept = line.some(
      (point) => distanceMeters(point, controls[1]!) < 0.01,
    );
    expect(kept).toBe(true);

    // And the corner that was NOT pinned is gone, replaced by an arc.
    const rounded = line.some((point) => distanceMeters(point, controls[2]!) < 0.01);
    expect(rounded).toBe(false);
  });

  it('is identical to a plain polyline when every point was placed straight', () => {
    // What the editor stores as `mode: 'straight'` rather than carrying an inert setting.
    const all = controls.map((_, index) => index);
    const line = tessellate(controls, { mode: 'rounded', radiusMeters: 20, sharpVertices: all });
    expect(line).toEqual(controls);
  });
});

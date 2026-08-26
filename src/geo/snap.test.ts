import { describe, expect, it } from 'vitest';
import { snapPoint } from './snap';
import { distanceMeters } from './measure';
import { componentsFromSpecs } from '../library/templates';
import type { Area, Street } from '../model/types';

/**
 * Snapping while drawing.
 *
 * More than a convenience here, because junctions are derived from where centerlines
 * actually meet. A vertex that lands forty centimetres off the line it was aimed at still
 * makes a junction — the detector's tolerance is a street's width — but it makes it at the
 * projection of a loose endpoint, and every corner radius and taper downstream is built
 * from that instead of from what somebody meant.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

function street(id: string, centerline: [number, number][]): Street {
  return {
    id,
    name: id,
    centerline,
    visible: true,
    section: {
      id: `sec-${id}`,
      name: id,
      anchorOffsetMeters: null,
      components: componentsFromSpecs([
        ['travelLane', 'backward'],
        ['travelLane', 'forward'],
      ]),
    },
  };
}

const MAIN = street('main', [at(-100, 0), at(100, 0)]);

describe('snapping to what is already drawn', () => {
  it('lands exactly on a control point that is near enough', () => {
    const result = snapPoint({
      cursor: at(100.8, 0.6),
      streets: [MAIN],
      toleranceMeters: 5,
    });
    expect(result.kind).toBe('vertex');
    expect(result.targetId).toBe('main');
    expect(distanceMeters(result.point, at(100, 0))).toBeLessThan(0.01);
  });

  it('lands on the line itself when no control point is near', () => {
    const result = snapPoint({
      cursor: at(20, 1.5),
      streets: [MAIN],
      toleranceMeters: 5,
    });
    expect(result.kind).toBe('edge');
    // Snapped across to the line, and not moved along it.
    expect(distanceMeters(result.point, at(20, 0))).toBeLessThan(0.01);
  });

  it('prefers a control point to a nearer point on a segment', () => {
    // A vertex is a decision somebody made; a point on a segment is not. Ranking them by
    // distance alone would step off the end of a street by a few centimetres and leave the
    // two endpoints not quite joined, which is the exact failure snapping exists to stop.
    const result = snapPoint({
      cursor: at(99.6, 0.4),
      streets: [MAIN],
      toleranceMeters: 3,
    });
    expect(result.kind).toBe('vertex');
  });

  it('leaves the cursor alone when nothing is close', () => {
    const result = snapPoint({ cursor: at(20, 40), streets: [MAIN], toleranceMeters: 5 });
    expect(result.kind).toBe('none');
    expect(result.point).toEqual(at(20, 40));
  });

  it('ignores a hidden street, and anything explicitly excluded', () => {
    const hidden = { ...MAIN, visible: false };
    expect(snapPoint({ cursor: at(20, 1), streets: [hidden], toleranceMeters: 5 }).kind).toBe('none');

    expect(
      snapPoint({
        cursor: at(20, 1),
        streets: [MAIN],
        toleranceMeters: 5,
        exclude: new Set(['main']),
      }).kind,
    ).toBe('none');
  });

  it('snaps to a land-cover ring, including its closing edge', () => {
    const area: Area = {
      id: 'park',
      name: 'Park',
      landcover: 'grass',
      // Deliberately not closed: the ring wraps, and the segment from the last vertex back
      // to the first is a real edge that a naive loop over pairs would miss.
      ring: [at(0, 20), at(30, 20), at(30, 50), at(0, 50)],
      visible: true,
    };
    const result = snapPoint({
      cursor: at(15, 19),
      streets: [],
      areas: [area],
      toleranceMeters: 4,
    });
    expect(result.kind).toBe('edge');
    expect(result.targetId).toBe('park');
  });

  it('follows a curve rather than the control polygon it was drawn with', () => {
    // A curved street is where its curve goes. Snapping to the control polygon would put
    // the vertex off the pavement — by metres, on a real bend.
    const curved: Street = {
      ...street('bend', [at(-40, 0), at(0, 0), at(0, 40)]),
      curve: { mode: 'rounded', radiusMeters: 20 },
    };
    // A point sitting ON the control polygon, inside the corner the 20 m radius cuts. The
    // arc has already left the straight by here, so there is nothing to snap to.
    const offArc = snapPoint({ cursor: at(-8, 0), streets: [curved], toleranceMeters: 2 });
    expect(offArc.kind).toBe('none');

    // And a point on the arc itself, which the control polygon comes nowhere near.
    const onArc = snapPoint({ cursor: at(-6, 6), streets: [curved], toleranceMeters: 2 });
    expect(onArc.kind).toBe('edge');
  });
});

describe('angle snapping', () => {
  const from = at(0, 0);

  it('is off unless a step is asked for', () => {
    const free = snapPoint({ cursor: at(50, 2), streets: [], from, toleranceMeters: 3 });
    expect(free.kind).toBe('none');
  });

  it('pulls a nearly-straight run onto the increment', () => {
    const result = snapPoint({
      cursor: at(50, 2),
      streets: [],
      from,
      toleranceMeters: 3,
      angleStepDegrees: 15,
    });
    expect(result.kind).toBe('angle');
    // Due east, and the same distance out: snapping the bearing must not change the length.
    expect(Math.abs(result.point[1] - from[1])).toBeLessThan(1e-9);
    expect(distanceMeters(from, result.point)).toBeCloseTo(distanceMeters(from, at(50, 2)), 3);
  });

  it('leaves a bearing between increments alone', () => {
    // The magnet is gentle on purpose. Tracing a real street means most bearings are not
    // multiples of fifteen degrees, and quantising them all would fight the tracing.
    const result = snapPoint({
      cursor: at(50, 20),
      streets: [],
      from,
      toleranceMeters: 3,
      angleStepDegrees: 15,
    });
    expect(result.kind).toBe('none');
  });

  it('never overrides a real target', () => {
    // Landing on the street you are joining matters more than a tidy bearing.
    const result = snapPoint({
      cursor: at(50, 1),
      streets: [MAIN],
      from: at(0, 30),
      toleranceMeters: 3,
      angleStepDegrees: 15,
    });
    expect(result.kind).toBe('edge');
  });
});

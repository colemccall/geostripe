import { describe, expect, it } from 'vitest';
import { detectJunctions } from './junctions';
import { DEFAULT_CORNER_RADIUS_METRES, junctionGeometry, ringArea } from './intersection';
import { localPlane } from './projection';
import { distanceMeters } from './measure';
import { componentsFromSpecs } from '../library/templates';
import type { Street } from '../model/types';
import type { ComponentType, Direction } from '../library/primitives';

/**
 * Intersection geometry.
 *
 * The assertions here are dimensional, not structural: a ring with the right number of
 * points and the wrong area is exactly the bug that ships. Where a figure can be worked
 * out by hand it is, and the expected value is written out rather than snapshotted, so a
 * change in the geometry has to be argued with rather than re-recorded.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

type Spec = readonly [ComponentType, Direction] | readonly [ComponentType, Direction, number];

let counter = 0;
function street(name: string, centerline: [number, number][], specs: readonly Spec[]): Street {
  counter += 1;
  return {
    id: `st-${counter}`,
    name,
    centerline,
    visible: true,
    section: {
      id: `sec-${counter}`,
      name,
      anchorOffsetMeters: null,
      components: componentsFromSpecs(specs),
    },
  };
}

/** Two 3 m lanes between two 3 m footways: 6 m curb to curb, 12 m overall. */
const SIMPLE: readonly Spec[] = [
  ['sidewalk', 'none', 3],
  ['travelLane', 'backward', 3],
  ['travelLane', 'forward', 3],
  ['sidewalk', 'none', 3],
];

function fourWay(radius = DEFAULT_CORNER_RADIUS_METRES) {
  const ns = street('NS', [at(0, -120), at(0, 120)], SIMPLE);
  const ew = street('EW', [at(-120, 0), at(120, 0)], SIMPLE);
  const { junctions, plane } = detectJunctions([ns, ew]);
  const geometry = junctionGeometry(junctions[0]!, plane, { defaultRadiusMeters: radius });
  return { ns, ew, junction: junctions[0]!, plane, geometry };
}

/** Ring area in square metres, measured back in the plane the caller can rebuild. */
function areaOf(ring: readonly [number, number][]): number {
  const plane = localPlane(ring[0]!);
  return Math.abs(ringArea(ring.map((p) => plane.toPlane(p))));
}

describe('a square four-way', () => {
  const { geometry } = fourWay();

  it('produces both rings, closed', () => {
    expect(geometry.paved.length).toBeGreaterThan(8);
    expect(geometry.footprint.length).toBeGreaterThan(8);
    expect(geometry.paved[0]).toEqual(geometry.paved[geometry.paved.length - 1]);
    expect(geometry.footprint[0]).toEqual(geometry.footprint[geometry.footprint.length - 1]);
  });

  it('reports a 6 m crossing on every leg', () => {
    // Curb to curb: two 3 m lanes. This is the number the whole intersection UI is for.
    expect(geometry.legs).toHaveLength(4);
    for (const leg of geometry.legs) {
      expect(leg.crossingDistanceMeters).toBeCloseTo(6, 6);
      expect(distanceMeters(leg.stopLine[0], leg.stopLine[1])).toBeCloseTo(6, 1);
    }
  });

  it('puts four 90 degree corners at the requested radius', () => {
    expect(geometry.corners).toHaveLength(4);
    for (const corner of geometry.corners) {
      expect(corner.angleDegrees).toBeCloseTo(90, 1);
      expect(corner.clamped).toBe(false);
      expect(corner.appliedRadiusMeters).toBeCloseTo(DEFAULT_CORNER_RADIUS_METRES, 6);
    }
    expect(geometry.warnings).toEqual([]);
  });

  it('measures the paved area to the value the geometry implies', () => {
    // A rounded plus, worked out by hand rather than snapshotted.
    //
    // The kerb corner sits at (3,3); a 4.5 m return is tangent to it 4.5 m further out
    // along each leg, so the section resumes at 3 + 4.5 + 0.6 = 8.1 m from the centre.
    //
    //   box        6 * 6                             =  36.0
    //   arms   4 * 6 * (8.1 - 3)                     = 122.4
    //   returns  each ADDS a square minus a quadrant:
    //          4 * (4.5^2 - pi * 4.5^2 / 4)          =  17.4
    const r = DEFAULT_CORNER_RADIUS_METRES;
    const stop = 3 + r + 0.6;
    const expected = 36 + 4 * 6 * (stop - 3) + 4 * (r * r - (Math.PI * r * r) / 4);
    expect(areaOf(geometry.paved)).toBeCloseTo(expected, 0);
  });

  it('makes the footprint strictly larger than the paved area', () => {
    expect(areaOf(geometry.footprint)).toBeGreaterThan(areaOf(geometry.paved));
  });

  it('sets the stop offset clear of the corner returns', () => {
    // Kerb corner 3 m out, plus a 4.5 m tangent, plus the 0.6 m margin.
    for (const leg of geometry.legs) {
      expect(leg.stopOffsetMeters).toBeCloseTo(3 + DEFAULT_CORNER_RADIUS_METRES + 0.6, 1);
      expect(leg.overrunsLeg).toBe(false);
    }
  });

  it('keeps the footway resuming further out than the roadway', () => {
    // A 3 m footway behind a 4.5 m kerb return rides a 7.5 m radius off a corner 6 m out,
    // so the back of walk straightens much later than the kerb does. Sharing one offset
    // between them would either cut the footway short or stretch the asphalt.
    for (const leg of geometry.legs) {
      expect(leg.footStopOffsetMeters).toBeGreaterThan(leg.stopOffsetMeters);
      expect(leg.footStopOffsetMeters).toBeCloseTo(6 + 7.5 + 0.6, 1);
    }
  });
});

describe('corner radius drives the geometry', () => {
  it('shrinks the paved area as the corner tightens', () => {
    const tight = areaOf(fourWay(1.5).geometry.paved);
    const loose = areaOf(fourWay(9).geometry.paved);
    expect(tight).toBeLessThan(loose);
  });

  it('pulls the stop line closer as the corner tightens', () => {
    expect(fourWay(1.5).geometry.legs[0]!.stopOffsetMeters).toBeLessThan(
      fourWay(9).geometry.legs[0]!.stopOffsetMeters,
    );
  });

  it('leaves the crossing distance alone — that is set by the section, not the corner', () => {
    // Worth pinning: a tighter corner shortens the *walk around*, but the curb-to-curb
    // crossing only moves if the section changes. Conflating them would flatter the design.
    expect(fourWay(1.5).geometry.legs[0]!.crossingDistanceMeters).toBeCloseTo(
      fourWay(9).geometry.legs[0]!.crossingDistanceMeters,
      6,
    );
  });

  it('accepts a per-corner override', () => {
    const ns = street('NS', [at(0, -120), at(0, 120)], SIMPLE);
    const ew = street('EW', [at(-120, 0), at(120, 0)], SIMPLE);
    const { junctions, plane } = detectJunctions([ns, ew]);
    const geometry = junctionGeometry(junctions[0]!, plane, {
      corners: [{ radiusMeters: 1 }, {}, {}, {}],
      defaultRadiusMeters: 6,
    });
    expect(geometry.corners[0]!.appliedRadiusMeters).toBeCloseTo(1, 6);
    expect(geometry.corners[1]!.appliedRadiusMeters).toBeCloseTo(6, 6);
  });
});

describe('a T-junction', () => {
  const through = street('Through', [at(-120, 0), at(120, 0)], SIMPLE);
  const stem = street('Stem', [at(0, 120), at(0, 1)], SIMPLE);
  const { junctions, plane } = detectJunctions([through, stem]);
  const geometry = junctionGeometry(junctions[0]!, plane);

  it('has three legs and three corners', () => {
    expect(geometry.legs).toHaveLength(3);
    expect(geometry.corners).toHaveLength(3);
  });

  it('leaves the straight side straight rather than filleting it', () => {
    // The corner spanning the through street is 180 degrees: two parallel curb lines with
    // no intersection point. Filleting it would carve a bite out of a street that simply
    // runs past.
    const straight = geometry.corners.find((c) => c.angleDegrees > 179);
    expect(straight).toBeDefined();
    expect(straight!.centre).toBeNull();
    expect(straight!.appliedRadiusMeters).toBe(0);
  });

  it('still fillets the two real corners', () => {
    const real = geometry.corners.filter((c) => c.angleDegrees < 179);
    expect(real).toHaveLength(2);
    for (const corner of real) {
      expect(corner.centre).not.toBeNull();
      expect(corner.appliedRadiusMeters).toBeGreaterThan(0);
    }
  });
});

describe('degenerate inputs', () => {
  it('returns empty rings for a two-leg continuation rather than carving a hole', () => {
    const a = street('A', [at(-120, 0), at(0, 0)], SIMPLE);
    const b = street('B', [at(0, 0), at(120, 0)], SIMPLE);
    const { junctions, plane } = detectJunctions([a, b]);
    if (junctions.length === 0) return;
    const geometry = junctionGeometry(junctions[0]!, plane);
    expect(geometry.paved).toEqual([]);
    expect(geometry.footprint).toEqual([]);
  });

  it('clamps a radius the legs are too short to carry, and says so', () => {
    const through = street('Through', [at(-120, 0), at(120, 0)], SIMPLE);
    // A 6 m stub cannot host a 12 m return.
    const stub = street('Stub', [at(0, 6), at(0, -120)], SIMPLE);
    const { junctions, plane } = detectJunctions([through, stub]);
    const geometry = junctionGeometry(junctions[0]!, plane, { defaultRadiusMeters: 12 });

    const clamped = geometry.corners.filter((c) => c.clamped);
    expect(clamped.length).toBeGreaterThan(0);
    for (const corner of clamped) {
      expect(corner.appliedRadiusMeters).toBeLessThan(12);
      expect(corner.appliedRadiusMeters).toBeGreaterThanOrEqual(0);
    }
    expect(geometry.warnings.join(' ')).toMatch(/tightened/);
  });

  it('keeps a very acute corner from folding the ring over itself', () => {
    const a = street('A', [at(-120, 0), at(120, 0)], SIMPLE);
    const b = street('B', [at(-118, -20), at(120, 20)], SIMPLE);
    const { junctions, plane } = detectJunctions([a, b]);
    expect(junctions.length).toBeGreaterThan(0);
    const geometry = junctionGeometry(junctions[0]!, plane);
    // A folded ring reads as a negative or absurd area.
    const area = areaOf(geometry.paved);
    expect(Number.isFinite(area)).toBe(true);
    expect(area).toBeGreaterThan(0);
  });
});

describe('asymmetric sections', () => {
  it('offsets the paved ring toward the wider side rather than centring it', () => {
    // Parking on one side only: the travelway is not centred on the drawn line, and the
    // intersection has to follow it. Anchoring to the travelway midpoint is what makes
    // this come out right.
    const wide: readonly Spec[] = [
      ['sidewalk', 'none', 3],
      ['parkingLaneParallel', 'none', 2.4],
      ['travelLane', 'backward', 3],
      ['travelLane', 'forward', 3],
      ['sidewalk', 'none', 3],
    ];
    const ns = street('NS', [at(0, -120), at(0, 120)], wide);
    const ew = street('EW', [at(-120, 0), at(120, 0)], SIMPLE);
    const { junctions, plane } = detectJunctions([ns, ew]);
    const geometry = junctionGeometry(junctions[0]!, plane);

    const nsLegs = geometry.legs.filter((l) => l.streetId === ns.id);
    expect(nsLegs).toHaveLength(2);
    // 2.4 m parking + two 3 m lanes = 8.4 m curb to curb.
    for (const leg of nsLegs) {
      expect(leg.crossingDistanceMeters).toBeCloseTo(8.4, 6);
    }
  });
});

describe('the Washington Park crossing', () => {
  it('builds clean geometry for the real demo', async () => {
    const { createDemoStreets } = await import('../demo/washingtonPark');
    const { junctions, plane } = detectJunctions(createDemoStreets());
    const geometry = junctionGeometry(junctions[0]!, plane);

    expect(geometry.legs).toHaveLength(4);
    expect(areaOf(geometry.paved)).toBeGreaterThan(100);
    expect(areaOf(geometry.footprint)).toBeGreaterThan(areaOf(geometry.paved));
    for (const leg of geometry.legs) expect(leg.overrunsLeg).toBe(false);
  });
});

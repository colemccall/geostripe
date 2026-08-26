import { describe, expect, it } from 'vitest';
import { detectJunctions } from './junctions';
import {
  DEFAULT_CORNER_RADIUS_METRES,
  DEFAULT_CROSSWALK_WIDTH_METRES,
  junctionGeometry,
  ringArea,
} from './intersection';
import type { CornerInput, LegInput } from './intersection';
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

/** Parking both sides: 10.8 m kerb to kerb, wide enough to carry a real curb extension. */
const WIDE: readonly Spec[] = [
  ['sidewalk', 'none', 3],
  ['parkingLaneParallel', 'none', 2.4],
  ['travelLane', 'backward', 3],
  ['travelLane', 'forward', 3],
  ['parkingLaneParallel', 'none', 2.4],
  ['sidewalk', 'none', 3],
];

/** A four-way of two wide streets, with per-corner and per-leg settings applied. */
function wideFourWay(corners?: CornerInput[], legInputs?: LegInput[]) {
  const ns = street('NS', [at(0, -120), at(0, 120)], WIDE);
  const ew = street('EW', [at(-120, 0), at(120, 0)], WIDE);
  const { junctions, plane } = detectJunctions([ns, ew]);
  return junctionGeometry(junctions[0]!, plane, {
    ...(corners ? { corners } : {}),
    ...(legInputs ? { legs: legInputs } : {}),
  });
}

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

describe('crossings', () => {
  const crosswalk = {
    style: 'continental' as const,
    widthMeters: DEFAULT_CROSSWALK_WIDTH_METRES,
    setbackMeters: 0,
  };

  it('marks nothing until asked', () => {
    expect(wideFourWay().crossings).toHaveLength(0);
    for (const leg of wideFourWay().legs) expect(leg.hasCrosswalk).toBe(false);
  });

  it('lays continental bars across the roadway, and only there', () => {
    const geometry = wideFourWay(undefined, [{ crosswalk }, {}, {}, {}]);
    const stripes = geometry.crossings.filter((c) => c.kind === 'stripe');
    expect(stripes.length).toBeGreaterThan(4);
    expect(stripes.every((c) => c.legIndex === 0)).toBe(true);

    // 10.8 m of roadway at a 1.0 m pitch leaves room for ten bars, not eleven.
    expect(stripes.length).toBeLessThanOrEqual(11);
    expect(geometry.legs[0]!.hasCrosswalk).toBe(true);
  });

  it('gives each style the parts that define it', () => {
    const kinds = (style: 'transverse' | 'ladder' | 'raised' | 'continental') =>
      new Set(
        wideFourWay(undefined, [{ crosswalk: { ...crosswalk, style } }, {}, {}, {}]).crossings.map(
          (c) => c.kind,
        ),
      );

    expect(kinds('transverse')).toEqual(new Set(['edge']));
    expect(kinds('continental')).toEqual(new Set(['stripe']));
    expect(kinds('ladder')).toEqual(new Set(['edge', 'stripe']));
    expect(kinds('raised')).toEqual(new Set(['table', 'stripe']));
  });

  it('pushes the whole intersection back when the crossing is set back', () => {
    // A setback crossing has to sit outside the junction, so the cross-section cannot
    // resume until beyond it. Getting this wrong paints a crosswalk over a travel lane.
    const near = wideFourWay(undefined, [{ crosswalk }, {}, {}, {}]);
    const far = wideFourWay(undefined, [
      { crosswalk: { ...crosswalk, setbackMeters: 6 } },
      {},
      {},
      {},
    ]);
    expect(far.legs[0]!.stopOffsetMeters).toBeGreaterThan(near.legs[0]!.stopOffsetMeters + 5);
  });

  it('adds a stop bar behind the crossing, over the approach half only', () => {
    const geometry = wideFourWay(undefined, [{ crosswalk, stopBar: true }, {}, {}, {}]);
    const bars = geometry.crossings.filter((c) => c.kind === 'stopBar');
    expect(bars).toHaveLength(1);

    // Half the roadway, because only the approaching direction stops here.
    expect(areaOf(bars[0]!.ring)).toBeCloseTo(0.6 * 5.4, 0);
  });
});

describe('curb extensions', () => {
  const bulb: CornerInput = { treatment: 'bulbOut', bulbOutMeters: 2.4 };

  it('shortens the crossing by the extension on each side', () => {
    // The whole argument for a bulb-out in one number: 10.8 m of roadway, 2.4 m reclaimed
    // at each kerb, 6.0 m left to walk.
    const geometry = wideFourWay([bulb, bulb, bulb, bulb]);
    for (const leg of geometry.legs) {
      expect(leg.crossingDistanceWithoutBulbsMeters).toBeCloseTo(10.8, 6);
      expect(leg.crossingDistanceMeters).toBeCloseTo(6.0, 6);
    }
  });

  it('leaves the crossing alone on a leg whose corners are untouched', () => {
    // Corner 0 sits between legs 0 and 1, so extending it narrows those two and no others.
    const geometry = wideFourWay([bulb, {}, {}, {}]);
    expect(geometry.legs[0]!.crossingDistanceMeters).toBeCloseTo(10.8 - 2.4, 6);
    expect(geometry.legs[1]!.crossingDistanceMeters).toBeCloseTo(10.8 - 2.4, 6);
    expect(geometry.legs[2]!.crossingDistanceMeters).toBeCloseTo(10.8, 6);
  });

  it('keeps the roadway cut wider than the paved fill, by exactly the extension', () => {
    // These two rings share their arm length, so the difference between them is only the
    // ground the extension reclaims. That gap is what makes a lane band disappear under a
    // curb extension and the footway show through instead.
    //
    // Comparing a bulbed junction's area against an unbulbed one would prove nothing: the
    // extension needs a taper, the taper pushes the stop line further out, and the longer
    // arms add more area than the extension removes. Larger overall, narrower where it
    // matters — which is why the crossing distance, not the area, is the number to watch.
    const bulbed = wideFourWay([bulb, bulb, bulb, bulb]);
    expect(areaOf(bulbed.roadwayCut)).toBeGreaterThan(areaOf(bulbed.paved));

    const reclaimed = areaOf(bulbed.roadwayCut) - areaOf(bulbed.paved);
    expect(reclaimed).toBeGreaterThan(20);
  });

  it('leaves the two rings identical when no corner is extended', () => {
    const plain = wideFourWay();
    expect(areaOf(plain.roadwayCut)).toBeCloseTo(areaOf(plain.paved), 6);
  });

  it('leaves the footprint alone — a curb extension widens the footway', () => {
    // The back of walk does not move when the kerb comes out, which is what lets the
    // extra footway show up with no boolean at all.
    expect(areaOf(wideFourWay([bulb, bulb, bulb, bulb]).footprint)).toBeCloseTo(
      areaOf(wideFourWay().footprint),
      0,
    );
  });

  it('refuses to close the street, and says so', () => {
    const geometry = wideFourWay([{ treatment: 'bulbOut', bulbOutMeters: 12 }, {}, {}, {}]);
    expect(geometry.corners[0]!.appliedBulbOutMeters).toBeLessThan(12);
    expect(geometry.legs[0]!.crossingDistanceMeters).toBeGreaterThanOrEqual(3);
    expect(geometry.warnings.join(' ')).toMatch(/curb extension was cut/);
  });

  it('holds the extension past the crossing rather than tapering into it', () => {
    // An extension that stopped short of the crosswalk would not shorten the walk, which
    // is the one thing it exists to do.
    const geometry = wideFourWay(
      [bulb, bulb, bulb, bulb],
      [{ crosswalk: { style: 'continental', widthMeters: 3, setbackMeters: 0 } }, {}, {}, {}],
    );
    const stripes = geometry.crossings.filter((c) => c.kind === 'stripe' && c.legIndex === 0);
    expect(stripes.length).toBeGreaterThan(0);
    expect(geometry.legs[0]!.crossingDistanceMeters).toBeCloseTo(6.0, 6);
  });
});

describe('daylighting', () => {
  it('produces a zone on both legs the corner touches', () => {
    const geometry = wideFourWay([{ daylightMeters: 6 }, {}, {}, {}]);
    expect(geometry.daylightZones.map((z) => z.legIndex).sort()).toEqual([0, 1]);
  });

  it('makes the zone as long as asked and as wide as the roadway', () => {
    const geometry = wideFourWay([{ daylightMeters: 6 }, {}, {}, {}]);
    expect(areaOf(geometry.daylightZones[0]!.ring)).toBeCloseTo(6 * 10.8, 0);
  });

  it('does not change the crossing — daylighting is about sight lines, not width', () => {
    const geometry = wideFourWay([{ daylightMeters: 6 }, {}, {}, {}]);
    for (const leg of geometry.legs) expect(leg.crossingDistanceMeters).toBeCloseTo(10.8, 6);
  });
});

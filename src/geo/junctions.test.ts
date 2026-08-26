import { describe, expect, it } from 'vitest';
import { STUB_METRES, cornerAngle, detectJunctions } from './junctions';
import { distanceMeters } from './measure';
import { componentsFromSpecs } from '../library/templates';
import type { Street } from '../model/types';
import { createDemoStreets } from '../demo/washingtonPark';

/**
 * Junction detection.
 *
 * The gate on everything intersection-related. Corner radii, crosswalks and trimming all
 * hang off the leg list, so a leg counted twice or missed entirely is not a cosmetic bug —
 * it silently carves the wrong hole out of a street.
 *
 * Coordinates here are around Cincinnati (39.11 N), deliberately: longitude degrees are
 * only 0.777 as long as latitude degrees there, so any code that treats them as
 * interchangeable produces non-perpendicular legs and fails the bearing assertions.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;

/** Metres per degree at the test origin, close enough for laying out test fixtures. */
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

/** Build a point `east` metres east and `north` metres north of the test origin. */
function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

let counter = 0;
function street(name: string, centerline: [number, number][], widthMeters = 12): Street {
  counter += 1;
  const lanes = Math.max(1, Math.round(widthMeters / 3));
  return {
    id: `st-${counter}-${name.replace(/\W/g, '')}`,
    name,
    centerline,
    visible: true,
    section: {
      id: `sec-${counter}`,
      name,
      anchorOffsetMeters: null,
      components: componentsFromSpecs(
        Array.from({ length: lanes }, () => ['travelLane', 'forward'] as const),
      ),
    },
  };
}

const DEG = 180 / Math.PI;
const bearings = (junction: { legs: { bearing: number }[] }) =>
  junction.legs.map((l) => Math.round(l.bearing * DEG));

describe('a simple four-way crossing', () => {
  const ns = street('North–South', [at(0, -100), at(0, 100)]);
  const ew = street('East–West', [at(-100, 0), at(100, 0)]);
  const { junctions } = detectJunctions([ns, ew]);

  it('finds exactly one junction', () => {
    expect(junctions).toHaveLength(1);
  });

  it('lands it on the crossing point', () => {
    expect(distanceMeters(junctions[0]!.position, at(0, 0))).toBeLessThan(0.1);
  });

  it('gives it four legs, one per arm', () => {
    expect(junctions[0]!.legs).toHaveLength(4);
    expect(junctions[0]!.kind).toBe('crossing');
  });

  it('sorts the legs by bearing, east then north then west then south', () => {
    // The cos(latitude) test: without it the north-south legs come out off-axis.
    expect(bearings(junctions[0]!)).toEqual([0, 90, 180, 270]);
  });

  it('reports each leg 100 m long', () => {
    for (const leg of junctions[0]!.legs) {
      expect(leg.lengthMeters).toBeCloseTo(100, 0);
    }
    expect(junctions[0]!.hasStub).toBe(false);
  });

  it('puts a 90 degree corner between each adjacent pair', () => {
    for (let i = 0; i < 4; i++) {
      expect(cornerAngle(junctions[0]!.legs, i) * DEG).toBeCloseTo(90, 1);
    }
  });
});

describe('a T-junction', () => {
  const through = street('Through', [at(-100, 0), at(100, 0)]);
  // Ends a little short of the through street, the way a hand-drawn centerline does.
  const stem = street('Stem', [at(0, 80), at(0, 2)]);
  const { junctions } = detectJunctions([through, stem]);

  it('detects it even though the centerlines never actually touch', () => {
    expect(junctions).toHaveLength(1);
    expect(junctions[0]!.kind).toBe('tee');
  });

  it('has three legs, not four', () => {
    expect(junctions[0]!.legs).toHaveLength(3);
    expect(bearings(junctions[0]!)).toEqual([0, 90, 180]);
  });

  it('squares the junction onto the through street rather than the loose endpoint', () => {
    // The stem stops 2 m short; the junction still sits on the through centerline.
    expect(distanceMeters(junctions[0]!.position, at(0, 0))).toBeLessThan(0.5);
  });
});

describe('streets that do not meet', () => {
  it('finds nothing between parallel streets', () => {
    const a = street('A', [at(-100, 0), at(100, 0)]);
    const b = street('B', [at(-100, 40), at(100, 40)]);
    expect(detectJunctions([a, b]).junctions).toHaveLength(0);
  });

  it('finds nothing when an endpoint stops well clear', () => {
    const through = street('Through', [at(-100, 0), at(100, 0)]);
    const shy = street('Shy', [at(0, 80), at(0, 30)]);
    expect(detectJunctions([through, shy]).junctions).toHaveLength(0);
  });

  it('ignores hidden streets', () => {
    const ns = street('NS', [at(0, -100), at(0, 100)]);
    const ew = { ...street('EW', [at(-100, 0), at(100, 0)]), visible: false };
    expect(detectJunctions([ns, ew]).junctions).toHaveLength(0);
  });
});

describe('three streets through one point', () => {
  // A six-way. The three pairwise crossings land a metre or two apart and must merge.
  const a = street('A', [at(-100, 0), at(100, 0)]);
  const b = street('B', [at(0, -100), at(0, 100)]);
  const c = street('C', [at(-70, -70), at(70, 70)]);
  const { junctions } = detectJunctions([a, b, c]);

  it('is one junction, not three', () => {
    expect(junctions).toHaveLength(1);
  });

  it('has six legs', () => {
    expect(junctions[0]!.legs).toHaveLength(6);
    expect(junctions[0]!.streetIds).toHaveLength(3);
  });

  it('still sorts them counter-clockwise', () => {
    const list = junctions[0]!.legs.map((l) => l.bearing);
    for (let i = 1; i < list.length; i++) expect(list[i]!).toBeGreaterThan(list[i - 1]!);
  });
});

describe('a pair that crosses twice', () => {
  const straight = street('Straight', [at(0, -200), at(0, 200)]);
  // A street that weaves across it: west, east, west.
  const weave = street('Weave', [at(-40, -150), at(40, -50), at(-40, 50), at(40, 150)]);
  const { junctions } = detectJunctions([straight, weave]);

  it('finds both crossings', () => {
    expect(junctions.length).toBeGreaterThanOrEqual(2);
  });

  it('gives them distinct keys ordered along the first street', () => {
    const keys = junctions.map((j) => j.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((k) => k.endsWith('#0'))).toBe(true);
    expect(keys.some((k) => k.endsWith('#1'))).toBe(true);
  });
});

describe('key stability', () => {
  // The whole point of keying by street set: customisation must survive editing.
  const ns = street('NS', [at(0, -100), at(0, 100)]);
  const ew = street('EW', [at(-100, 0), at(100, 0)]);
  const before = detectJunctions([ns, ew]).junctions[0]!;

  it('survives inserting a vertex, which changes every index', () => {
    const withVertex: Street = {
      ...ns,
      centerline: [at(0, -100), at(0, -50), at(0, 100)],
    };
    const after = detectJunctions([withVertex, ew]).junctions[0]!;
    expect(after.key).toBe(before.key);
  });

  it('survives moving the crossing somewhere else entirely', () => {
    const moved: Street = { ...ew, centerline: [at(-100, 60), at(100, 60)] };
    const movedNs: Street = { ...ns, centerline: [at(0, -40), at(0, 160)] };
    const after = detectJunctions([movedNs, moved]).junctions[0]!;
    expect(after.key).toBe(before.key);
    expect(distanceMeters(after.position, at(0, 60))).toBeLessThan(0.5);
  });

  it('does not depend on the order the streets are listed in', () => {
    const swapped = detectJunctions([ew, ns]).junctions[0]!;
    expect(swapped.key).toBe(before.key);
  });

  it('does not depend on the direction a centerline was drawn', () => {
    const reversed: Street = { ...ns, centerline: [at(0, 100), at(0, -100)] };
    const after = detectJunctions([reversed, ew]).junctions[0]!;
    expect(after.key).toBe(before.key);
    expect(after.legs).toHaveLength(4);
    expect(bearings(after)).toEqual([0, 90, 180, 270]);
  });
});

describe('leg orientation', () => {
  it('reports half-widths in an outward frame, so both legs of a street agree', () => {
    // An asymmetric section: 3 lanes, anchor at the travelway centre, so left and right
    // extents differ. The two legs must mirror each other.
    const wide = street('Wide', [at(0, -100), at(0, 100)], 21);
    const cross = street('Cross', [at(-100, 0), at(100, 0)]);
    const junction = detectJunctions([wide, cross]).junctions[0]!;

    const arms = junction.legs.filter((l) => l.streetId === wide.id);
    expect(arms).toHaveLength(2);
    expect(arms[0]!.halfLeft).toBeCloseTo(arms[1]!.halfRight, 6);
    expect(arms[0]!.halfRight).toBeCloseTo(arms[1]!.halfLeft, 6);
  });
});

describe('the Washington Park demo', () => {
  const { junctions } = detectJunctions(createDemoStreets());

  it('finds the Race Street / West 12th crossing', () => {
    expect(junctions).toHaveLength(1);
    expect(junctions[0]!.legs).toHaveLength(4);
  });

  it('measures the short Race Street arm south of the crossing', () => {
    // Race Street begins south of West 12th, so one leg is far shorter than the rest —
    // about 28 m. Short, but comfortably longer than a corner return plus a crosswalk,
    // so it is not flagged as a stub.
    const lengths = junctions[0]!.legs.map((l) => l.lengthMeters).sort((a, b) => a - b);
    expect(lengths[0]).toBeGreaterThan(20);
    expect(lengths[0]).toBeLessThan(40);
    expect(lengths[1]).toBeGreaterThan(100);
    expect(junctions[0]!.hasStub).toBe(false);
  });
});

describe('stub legs', () => {
  it('flags a leg too short to fit a corner and a crossing', () => {
    const through = street('Through', [at(-100, 0), at(100, 0)]);
    // Ends 8 m past the crossing: not enough room for a return plus a crosswalk.
    const clipped = street('Clipped', [at(0, 80), at(0, -8)]);
    const junction = detectJunctions([through, clipped]).junctions[0]!;

    expect(junction.hasStub).toBe(true);
    expect(Math.min(...junction.legs.map((l) => l.lengthMeters))).toBeLessThan(STUB_METRES);
  });
});

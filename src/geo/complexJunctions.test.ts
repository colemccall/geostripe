import { beforeEach, describe, expect, it } from 'vitest';
import { deriveProject, resetDerivedCaches } from './derived';
import type { JunctionOverride } from './derived';
import { cornerAngle, detectJunctions } from './junctions';
import { componentsFromSpecs } from '../library/templates';
import type { ComponentType, Direction } from '../library/primitives';
import type { Street } from '../model/types';

/**
 * Junctions that are not a tidy four-way.
 *
 * Every intersection feature so far was built and checked against a crossroads, which is
 * the one shape where almost every sign error cancels. The cases that actually turn up on
 * a map are the ones here: a five-way where two legs are nearly collinear, a six-way where
 * no corner is square, and — the common one nobody models — a staggered intersection,
 * which is two T-junctions close enough that a driver reads them as one place.
 *
 * The staggered case is the interesting design decision. Merging the pair would give one
 * junction with six legs and a single centre sitting between the two side streets, drawing
 * both of them from somewhere neither of them is. So they stay two junctions, and the
 * pipeline reports the overlap and suppresses the paint that would land inside the
 * neighbour.
 */

const ORIGIN_LNG = -84.52;
const ORIGIN_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [ORIGIN_LNG + east / M_PER_LNG, ORIGIN_LAT + north / M_PER_LAT];
}

type Spec = readonly [ComponentType, Direction] | readonly [ComponentType, Direction, number];

const TWO_WAY: readonly Spec[] = [
  ['sidewalk', 'none', 3],
  ['travelLane', 'backward', 3.3],
  ['travelLane', 'forward', 3.3],
  ['sidewalk', 'none', 3],
];

function street(id: string, centerline: [number, number][], specs: readonly Spec[] = TWO_WAY): Street {
  return {
    id,
    name: id,
    centerline,
    visible: true,
    section: {
      id: `sec-${id}`,
      name: id,
      anchorOffsetMeters: null,
      components: componentsFromSpecs(specs),
    },
  };
}

/** A point on a circle of radius `r` at a compass-free bearing, in degrees CCW from east. */
function ray(degrees: number, metres: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return at(Math.cos(radians) * metres, Math.sin(radians) * metres);
}

beforeEach(() => resetDerivedCaches());

describe('a five-way junction', () => {
  // Three streets through one point at 0, 60 and 120 degrees gives six legs; ending one of
  // them short of the centre gives five. The 60-degree spacing is deliberately tighter than
  // anything a crossroads exercises.
  const streets = [
    street('a', [ray(180, 110), ray(0, 110)]),
    street('b', [ray(240, 110), ray(60, 110)]),
    street('c', [ray(300, 110), ray(120, 110)]),
  ];

  const { junctions } = detectJunctions(streets);

  it('finds one junction, not three pairwise ones', () => {
    // Three streets meeting at a point produce three pairwise crossings a fraction of a
    // metre apart. Clustering has to fuse them or the map grows three overlapping boxes.
    expect(junctions).toHaveLength(1);
  });

  it('gives it six legs sorted by bearing', () => {
    const junction = junctions[0]!;
    expect(junction.legs).toHaveLength(6);
    const bearings = junction.legs.map((leg) => leg.bearing);
    expect([...bearings].sort((x, y) => x - y)).toEqual(bearings);
  });

  it('has corners that add up to a full turn', () => {
    // The invariant that says the ring closes. If corner angles do not sum to 2 pi the
    // walk that builds the paved area either doubles back or leaves a gap.
    const junction = junctions[0]!;
    const total = junction.legs.reduce((sum, _, i) => sum + cornerAngle(junction.legs, i), 0);
    expect(total).toBeCloseTo(Math.PI * 2, 6);
  });

  it('produces a single closed paved area for it', () => {
    const derived = deriveProject(streets);
    expect(derived.junctionGeometry).toHaveLength(1);

    const paved = derived.junctionGeometry[0]!.paved;
    expect(paved.length).toBeGreaterThan(6);
    expect(paved[0]).toEqual(paved[paved.length - 1]);
  });
});

describe('a genuinely five-legged junction', () => {
  // Two through streets plus one that ends at the crossing: five legs, and one corner far
  // wider than a right angle where the fifth leg is missing.
  const streets = [
    street('main', [ray(180, 110), ray(0, 110)]),
    street('cross', [ray(270, 110), ray(90, 110)]),
    street('spur', [at(0, 0), ray(135, 90)]),
  ];
  const { junctions } = detectJunctions(streets);

  it('counts five legs', () => {
    expect(junctions).toHaveLength(1);
    expect(junctions[0]!.legs).toHaveLength(5);
  });

  it('still closes, and splits one right angle into two acute corners', () => {
    // The spur comes in at 135 degrees, between the legs at 90 and 180. It does not create
    // a wide corner — it halves an existing one, leaving two 45-degree corners. That is
    // what makes an odd-legged junction hard: an acute corner cannot carry a normal kerb
    // radius, and the fillet gets clamped.
    const junction = junctions[0]!;
    const angles = junction.legs.map((_, i) => (cornerAngle(junction.legs, i) * 180) / Math.PI);
    expect(angles.reduce((a, b) => a + b, 0)).toBeCloseTo(360, 4);
    expect(angles.filter((a) => Math.abs(a - 45) < 1)).toHaveLength(2);
    expect(Math.min(...angles)).toBeLessThan(60);
  });

  it('takes a normal kerb radius at 45 degrees as long as the legs are long', () => {
    // Worth pinning, because it is the opposite of the intuition. What clamps a corner
    // return is not the angle but the room: a 45-degree corner needs a tangent of
    // R / tan(22.5 degrees), which is two and a half times the radius, and a long leg has
    // it to spare.
    const derived = deriveProject(streets);
    for (const corner of derived.junctionGeometry[0]!.corners) {
      expect(corner.clamped).toBe(false);
    }
  });

  it('clamps and reports the same corner when the spur is short', () => {
    const short = [
      street('main', [ray(180, 110), ray(0, 110)]),
      street('cross', [ray(270, 110), ray(90, 110)]),
      street('spur', [at(0, 0), ray(135, 15)]),
    ];
    const derived = deriveProject(short);
    const corners = derived.junctionGeometry[0]!.corners;

    expect(corners.some((corner) => corner.clamped)).toBe(true);
    expect(derived.junctionWarnings.join(' ')).toMatch(/too short or too sharp/);
    for (const corner of corners) {
      expect(corner.appliedRadiusMeters).toBeLessThanOrEqual(corner.radiusMeters + 1e-9);
    }
  });
});

describe('a staggered intersection', () => {
  /** A through street with two side streets meeting it `stagger` metres apart. */
  function staggered(stagger: number): Street[] {
    return [
      street('main', [at(-150, 0), at(150, 0)]),
      street('north', [at(-stagger / 2, 90), at(-stagger / 2, 0)]),
      street('south', [at(stagger / 2, -90), at(stagger / 2, 0)]),
    ];
  }

  it('stays two junctions rather than being averaged into one', () => {
    const { junctions } = detectJunctions(staggered(24));
    expect(junctions).toHaveLength(2);
    for (const junction of junctions) expect(junction.legs).toHaveLength(3);
  });

  it('reports the pair, with the stagger measured', () => {
    const derived = deriveProject(staggered(18));
    expect(derived.offsetPairs).toHaveLength(1);

    const pair = derived.offsetPairs[0]!;
    expect(pair.separationMeters).toBeCloseTo(18, 0);
    expect(pair.overlapMeters).toBeGreaterThan(0);
    expect(pair.sharedStreetIds).toEqual(['main']);
    expect(derived.junctionWarnings.join(' ')).toContain('staggered');
  });

  it('says nothing about two junctions that merely fit side by side', () => {
    // Far enough apart that neither reaches the other. Warning about this pair would train
    // the reader to ignore the warning that matters.
    const derived = deriveProject(staggered(70));
    expect(derived.junctions).toHaveLength(2);
    expect(derived.offsetPairs).toHaveLength(0);
  });

  it('suppresses the crossings that would land inside the other junction', () => {
    const streets = staggered(20);
    const { junctions } = detectJunctions(streets);

    // A crosswalk on every leg of both junctions. The legs facing each other along the
    // through street have their crossings inside the neighbouring box.
    const overrides: Record<string, JunctionOverride> = {};
    for (const junction of junctions) {
      overrides[junction.key] = {
        legs: junction.legs.map(() => ({
          crosswalk: { style: 'continental' as const, widthMeters: 3, setbackMeters: 0 },
          stopBar: true,
        })),
      };
    }

    const together = deriveProject(streets, { overrides });

    // The same junctions pulled far apart keep every crossing, so the difference is the
    // suppression rather than some other effect of the override.
    resetDerivedCaches();
    const apartStreets = staggered(80);
    const apart = detectJunctions(apartStreets);
    const apartOverrides: Record<string, JunctionOverride> = {};
    for (const junction of apart.junctions) {
      apartOverrides[junction.key] = {
        legs: junction.legs.map(() => ({
          crosswalk: { style: 'continental' as const, widthMeters: 3, setbackMeters: 0 },
          stopBar: true,
        })),
      };
    }
    const separate = deriveProject(apartStreets, { overrides: apartOverrides });

    expect(together.crossings.length).toBeLessThan(separate.crossings.length);
    expect(together.crossings.length).toBeGreaterThan(0);
  });

  it('can be fused into one junction when that is what it really is', () => {
    // The knob exists because the geometry cannot tell a staggered pair from a plaza. A
    // generous slack says "this is one place"; the default says "these are two".
    const streets = staggered(20);
    expect(detectJunctions(streets).junctions).toHaveLength(2);
    expect(detectJunctions(streets, { mergeSlackMeters: 25 }).junctions).toHaveLength(1);
  });

  it('can be prised apart when the automatic radius fused it wrongly', () => {
    // Five metres apart on a thirteen-metre-wide street reads as one junction to the
    // detector, and it is usually right. Negative slack is how you say it is not.
    const tight = staggered(5);
    expect(detectJunctions(tight).junctions).toHaveLength(1);
    expect(detectJunctions(tight, { mergeSlackMeters: -4 }).junctions.length).toBeGreaterThan(1);
  });
});

describe('an approach flare', () => {
  const streets = () => [
    street('main', [at(-150, 0), at(150, 0)]),
    street('cross', [at(0, -150), at(0, 150)]),
  ];

  /** The override that adds a right-turn pocket to one named leg. */
  function withPocket(key: string, legIndex: number): Record<string, JunctionOverride> {
    return {
      [key]: {
        legs: Array.from({ length: 4 }, (_, i) =>
          i === legIndex
            ? {
                flare: {
                  side: 'right' as const,
                  componentType: 'turnPocket' as ComponentType,
                  widthMeters: 3.0,
                  storageMeters: 30,
                  taperMeters: 12,
                  movements: ['right' as const],
                },
              }
            : null,
        ),
      },
    };
  }

  it('draws the pocket as a band of its own', () => {
    const list = streets();
    const key = detectJunctions(list).junctions[0]!.key;
    const derived = deriveProject(list, { overrides: withPocket(key, 0) });

    expect(derived.flares).toHaveLength(1);
    expect(derived.flares[0]!.properties?.componentType).toBe('turnPocket');
  });

  it('lengthens the crossing on the leg it widens, and leaves the others alone', () => {
    // The honest cost of a turn pocket, and the reason it is applied to the leg before any
    // geometry is built rather than drawn over the top afterwards: a wider approach is a
    // longer walk, and the tool should say so without being asked.
    const list = streets();
    const key = detectJunctions(list).junctions[0]!.key;

    const plain = deriveProject(list).junctionGeometry[0]!;
    resetDerivedCaches();
    const flared = deriveProject(list, { overrides: withPocket(key, 0) }).junctionGeometry[0]!;

    expect(flared.legs[0]!.crossingDistanceMeters).toBeCloseTo(
      plain.legs[0]!.crossingDistanceMeters + 3.0,
      3,
    );
    for (const i of [1, 2, 3]) {
      expect(flared.legs[i]!.crossingDistanceMeters).toBeCloseTo(
        plain.legs[i]!.crossingDistanceMeters,
        3,
      );
    }
  });

  it('puts the pocket on the approaching driver\'s right, not the leg\'s', () => {
    // A leg points AWAY from the junction, so the driver's right is the leg's outward
    // left. Confusing the two is a mirror-image bug that looks perfectly plausible.
    const list = streets();
    const junction = detectJunctions(list).junctions[0]!;
    const leg = junction.legs[0]!;
    const derived = deriveProject(list, { overrides: withPocket(junction.key, 0) });

    const ring = (derived.flares[0]!.geometry as unknown as { coordinates: [number, number][][] })
      .coordinates[0]!;
    const plane = derived.plane;
    const origin = plane.toPlane(junction.position);
    const d = { x: Math.cos(leg.bearing), y: Math.sin(leg.bearing) };
    const n = { x: -d.y, y: d.x };

    for (const point of ring) {
      const local = plane.toPlane(point);
      const across = (local.x - origin.x) * n.x + (local.y - origin.y) * n.y;
      // Every vertex on the leg's outward-left side, which is the driver's right.
      expect(across).toBeGreaterThan(-1e-6);
    }
  });

  it('stamps the pocket with the arrow for the movement it serves', () => {
    const list = streets();
    const key = detectJunctions(list).junctions[0]!.key;
    const derived = deriveProject(list, { overrides: withPocket(key, 0) });

    const arrows = derived.approachStamps.filter((f) => f.properties?.glyph === 'arrowRight');
    expect(arrows).toHaveLength(1);
  });
});

describe('lane assignment on a real crossing', () => {
  const list = [
    street('main', [at(-150, 0), at(150, 0)], [
      ['sidewalk', 'none', 3],
      ['travelLane', 'backward', 3.3],
      ['travelLane', 'backward', 3.3],
      ['travelLane', 'forward', 3.3],
      ['travelLane', 'forward', 3.3],
      ['sidewalk', 'none', 3],
    ]),
    street('cross', [at(0, -150), at(0, 150)]),
  ];

  it('marks each approach in its own lanes and never in the oncoming ones', () => {
    const junction = detectJunctions(list).junctions[0]!;
    const overrides: Record<string, JunctionOverride> = {
      [junction.key]: {
        legs: junction.legs.map((leg) =>
          leg.streetId === 'main'
            ? {
                lanes:
                  leg.sense === 1
                    ? [null, ['left'], ['through'], null, null, null]
                    : [null, null, null, ['through'], ['right'], null],
              }
            : null,
        ),
      },
    };

    const derived = deriveProject(list, { overrides });
    const glyphs = derived.approachStamps.map((f) => f.properties?.glyph).sort();
    expect(glyphs).toEqual(['arrowLeft', 'arrowRight', 'arrowThrough', 'arrowThrough']);
  });
});

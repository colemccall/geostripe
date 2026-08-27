import { beforeEach, describe, expect, it } from 'vitest';
import { planInterchange } from './interchange';
import { detectJunctions } from './junctions';
import { deriveProject, resetDerivedCaches } from './derived';
import { levelAt, levelsMeet, stationAt } from './grade';
import { distanceMeters, lineLengthMeters } from './measure';
import { resolveCenterline } from './curve';
import { componentsFromSpecs } from '../library/templates';
import type { Street } from '../model/types';

/**
 * An interchange assembled from parts that already existed.
 *
 * The tests are about the *arrangement*, not about the curve shapes. What matters is that
 * the pieces land where the machinery downstream can read them: a ramp has to leave the
 * mainline shallowly enough to be a merge rather than a junction, it has to end exactly on
 * the cross road so a junction forms there at all, and the mainline has to be back on the
 * ground where the ramps meet it — or the ramps would be joining a road that is ten metres
 * above them.
 */

const O_LNG = -84.52;
const O_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((O_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [O_LNG + east / M_PER_LNG, O_LAT + north / M_PER_LAT];
}

function street(id: string, centerline: [number, number][], wide = false): Street {
  return {
    id,
    name: id,
    centerline,
    visible: true,
    section: {
      id: `sec-${id}`,
      name: id,
      anchorOffsetMeters: null,
      components: componentsFromSpecs(
        wide
          ? [
              ['shoulder', 'none', 2.5],
              ['travelLane', 'backward', 3.6],
              ['travelLane', 'backward', 3.6],
              ['median', 'none', 4],
              ['travelLane', 'forward', 3.6],
              ['travelLane', 'forward', 3.6],
              ['shoulder', 'none', 2.5],
            ]
          : [
              ['sidewalk', 'none', 3],
              ['travelLane', 'backward', 3.3],
              ['travelLane', 'forward', 3.3],
              ['sidewalk', 'none', 3],
            ],
      ),
    },
  };
}

/** A freeway east-west, a cross road north-south, meeting at the origin. */
function crossing(): Street[] {
  return [
    street('freeway', [at(-600, 0), at(600, 0)], true),
    street('cross', [at(0, -400), at(0, 400)]),
  ];
}

function junctionFor(streets: readonly Street[]) {
  resetDerivedCaches();
  const { junctions } = detectJunctions(streets);
  return junctions[0]!;
}

beforeEach(() => resetDerivedCaches());

describe('planning a diamond', () => {
  it('produces four ramps, one per quadrant', () => {
    const streets = crossing();
    const plan = planInterchange(junctionFor(streets), streets, {
      mainlineId: 'freeway',
      form: 'diamond',
    })!;

    expect(plan.ramps).toHaveLength(4);
    expect(plan.ramps.map((r) => r.quadrant).sort()).toEqual(['NE', 'NW', 'SE', 'SW']);
  });

  it('names the other street as the one crossed', () => {
    const streets = crossing();
    const plan = planInterchange(junctionFor(streets), streets, {
      mainlineId: 'freeway',
      form: 'diamond',
    })!;
    expect(plan.crossStreetId).toBe('cross');
  });

  it('starts every ramp on the mainline and ends it on the cross road', () => {
    // The whole arrangement depends on this. A ramp that stops short of either forms no
    // junction at all, and the interchange is four disconnected curves.
    const streets = crossing();
    const plan = planInterchange(junctionFor(streets), streets, {
      mainlineId: 'freeway',
      form: 'diamond',
    })!;

    for (const ramp of plan.ramps) {
      const start = ramp.centerline[0]!;
      const end = ramp.centerline[ramp.centerline.length - 1]!;
      // The mainline runs along y = 0 and the cross road along x = 0.
      expect(Math.abs(start[1] - at(0, 0)[1])).toBeLessThan(1e-9);
      expect(Math.abs(end[0] - at(0, 0)[0])).toBeLessThan(1e-9);
    }
  });

  it('leaves the mainline along the mainline, so it reads as a merge', () => {
    // The merge detector decides from the angle a road comes in at. A ramp that kinks away
    // at forty degrees the moment it leaves is a junction, not a merge, and the taper and
    // gore never get built.
    const streets = crossing();
    const plan = planInterchange(junctionFor(streets), streets, {
      mainlineId: 'freeway',
      form: 'diamond',
    })!;

    for (const ramp of plan.ramps) {
      const a = ramp.centerline[0]!;
      const b = ramp.centerline[1]!;
      // Second control point is still on the mainline's line.
      expect(Math.abs(b[1] - a[1])).toBeLessThan(1e-9);
    }
  });

  it('carries the mainline over, and puts it back down either side', () => {
    const streets = crossing();
    const plan = planInterchange(junctionFor(streets), streets, {
      mainlineId: 'freeway',
      form: 'diamond',
    })!;

    const length = lineLengthMeters(resolveCenterline(streets[0]!));
    expect(levelAt(plan.mainlineGrade, length / 2)).toBe(1);
    expect(levelAt(plan.mainlineGrade, 0)).toBe(0);
    expect(levelAt(plan.mainlineGrade, length)).toBe(0);
  });

  it('takes it under when asked', () => {
    const streets = crossing();
    const plan = planInterchange(junctionFor(streets), streets, {
      mainlineId: 'freeway',
      form: 'diamond',
      direction: -1,
    })!;
    const length = lineLengthMeters(resolveCenterline(streets[0]!));
    expect(levelAt(plan.mainlineGrade, length / 2)).toBe(-1);
  });

  it('has the mainline back on the ground where the ramps leave it', () => {
    // The reason the ramps can stay at grade and be ordinary streets. If the mainline were
    // still ten metres up where a ramp diverges, the two would not meet at all.
    const streets = crossing();
    const junction = junctionFor(streets);
    const plan = planInterchange(junction, streets, {
      mainlineId: 'freeway',
      form: 'diamond',
    })!;

    const line = resolveCenterline(streets[0]!);
    for (const ramp of plan.ramps) {
      const station = stationAt(line, ramp.centerline[0]!);
      expect(levelsMeet(levelAt(plan.mainlineGrade, station), 0)).toBe(true);
    }
  });
});

describe('the other forms', () => {
  it('puts a half diamond on one side only', () => {
    const streets = crossing();
    const plan = planInterchange(junctionFor(streets), streets, {
      mainlineId: 'freeway',
      form: 'halfDiamond',
    })!;
    expect(plan.ramps).toHaveLength(2);
    expect(new Set(plan.ramps.map((r) => r.quadrant))).toEqual(new Set(['NE', 'NW']));
  });

  it('puts a trumpet on one side of the mainline', () => {
    const streets = crossing();
    const plan = planInterchange(junctionFor(streets), streets, {
      mainlineId: 'freeway',
      form: 'trumpet',
    })!;
    expect(plan.ramps).toHaveLength(2);
    expect(new Set(plan.ramps.map((r) => r.quadrant))).toEqual(new Set(['NE', 'SE']));
  });
});

describe('refusing to build something that cannot work', () => {
  it('declines when the mainline is too short to hold ramps', () => {
    const streets = [
      street('freeway', [at(-40, 0), at(40, 0)], true),
      street('cross', [at(0, -400), at(0, 400)]),
    ];
    expect(
      planInterchange(junctionFor(streets), streets, { mainlineId: 'freeway', form: 'diamond' }),
    ).toBeNull();
  });

  it('declines when the cross road is too short to hold terminals', () => {
    const streets = [
      street('freeway', [at(-600, 0), at(600, 0)], true),
      street('cross', [at(0, -25), at(0, 25)]),
    ];
    expect(
      planInterchange(junctionFor(streets), streets, { mainlineId: 'freeway', form: 'diamond' }),
    ).toBeNull();
  });

  it('declines when the named mainline is not at this junction', () => {
    const streets = crossing();
    expect(
      planInterchange(junctionFor(streets), streets, { mainlineId: 'nowhere', form: 'diamond' }),
    ).toBeNull();
  });

  it('says which ramp it could not fit rather than dropping it silently', () => {
    // Room on one side of the crossing but not the other.
    const streets = [
      street('freeway', [at(-600, 0), at(600, 0)], true),
      street('cross', [at(0, -30), at(0, 400)]),
    ];
    const plan = planInterchange(junctionFor(streets), streets, {
      mainlineId: 'freeway',
      form: 'diamond',
    })!;
    expect(plan.ramps.length).toBeLessThan(4);
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.warnings[0]).toMatch(/ramp/i);
  });
});

describe('what the ramps become once they are streets', () => {
  /** The plan, applied — ramps as real streets and the grade on the mainline. */
  function build(): Street[] {
    const streets = crossing();
    const plan = planInterchange(junctionFor(streets), streets, {
      mainlineId: 'freeway',
      form: 'diamond',
    })!;

    const ramps: Street[] = plan.ramps.map((ramp, i) => ({
      ...street(`ramp-${i}`, ramp.centerline as [number, number][]),
      name: ramp.name,
      curve: ramp.curve,
    }));

    return [
      { ...streets[0]!, grade: plan.mainlineGrade },
      streets[1]!,
      ...ramps,
    ];
  }

  it('forms a junction where each ramp lands on the cross road', () => {
    const built = build();
    resetDerivedCaches();
    const { junctions } = detectJunctions(built);
    // Four terminals on the cross road, plus wherever the ramps meet the mainline.
    expect(junctions.length).toBeGreaterThanOrEqual(4);
  });

  it('does not form a junction where the mainline crosses the cross road', () => {
    // The point of the structure. If this one appears, the freeway is being carved open by
    // the road it is supposed to be flying over.
    const built = build();
    resetDerivedCaches();
    const { junctions } = detectJunctions(built);

    const throughCrossing = junctions.filter(
      (j) => j.streetIds.includes('freeway') && j.streetIds.includes('cross'),
    );
    expect(throughCrossing).toHaveLength(0);
  });

  it('still derives without warnings about impossible geometry', () => {
    const built = build();
    resetDerivedCaches();
    const derived = deriveProject(built);
    expect(derived.junctionGeometry.length).toBeGreaterThan(0);
    // Every band came out as a real polygon rather than collapsing.
    for (const [, geometry] of derived.byStreet) {
      expect(geometry.bands.length).toBeGreaterThan(0);
    }
  });

  it('puts the ramp terminals well clear of the structure', () => {
    // A terminal directly under the overpass is not a design, it is a collision. They
    // should sit out along the cross road where there is room for a junction.
    const built = build();
    for (const ramp of built.slice(2)) {
      const end = ramp.centerline[ramp.centerline.length - 1]!;
      expect(distanceMeters(end, at(0, 0))).toBeGreaterThan(40);
    }
  });
});

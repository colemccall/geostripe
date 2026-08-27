import { beforeEach, describe, expect, it } from 'vitest';
import { applyConnections, connectStreets, planConnections } from './connect';
import { detectJunctions } from './junctions';
import { resetDerivedCaches } from './derived';
import { distanceMeters, lineLengthMeters } from './measure';
import { componentsFromSpecs } from '../library/templates';
import type { Street } from '../model/types';

/**
 * Welding loose ends onto the streets they were drawn to meet.
 *
 * The tests are written against the *junction* that comes out, not just the coordinates
 * that go in, because the bug this fixes is not "the endpoint is 1.5 m off" — nobody would
 * notice that. It is that 1.5 m of overshoot turns a T into a four-way crossing, with a
 * phantom leg and a fourth corner fillet carved out of the through street. The assertion
 * that matters is therefore `legs.length`, before and after.
 */

const O_LNG = -84.52;
const O_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((O_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [O_LNG + east / M_PER_LNG, O_LAT + north / M_PER_LAT];
}

function street(id: string, centerline: [number, number][], extra: Partial<Street> = {}): Street {
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
        ['sidewalk', 'none', 3],
        ['travelLane', 'backward', 3.3],
        ['travelLane', 'forward', 3.3],
        ['sidewalk', 'none', 3],
      ]),
    },
    ...extra,
  };
}

/** The through street every T in here joins. Half-width 6.3 m. */
const main = () => street('main', [at(-100, 0), at(100, 0)]);

/** Legs at the first junction found, or zero if there is no junction at all. */
function legCount(streets: readonly Street[]): number {
  resetDerivedCaches();
  const { junctions } = detectJunctions(streets);
  return junctions[0]?.legs.length ?? 0;
}

beforeEach(() => resetDerivedCaches());

describe('a side street that overshoots', () => {
  it('is ignored by the detector when it is narrower than a lane', () => {
    // The detector now drops an arm shorter than a lane is wide: nobody draws a
    // metre-and-a-half street, so a tail that short is slop rather than a leg. It used to
    // count, and a T came out as a four-way because of it.
    //
    // That does not make welding pointless — it moves the line where the pavement really
    // goes, and it still matters above this threshold — but the worst symptom is gone at
    // the source.
    expect(legCount([main(), street('side', [at(0, -80), at(0, 1.5)])])).toBe(3);
  });

  it('is what turns a T into a four-way once the tail is a real length', () => {
    // Six metres is longer than a lane is wide, so the detector reads it as an arm — and
    // a T becomes a crossroads with a phantom leg and a fourth corner fillet.
    expect(legCount([main(), street('side', [at(0, -80), at(0, 6)])])).toBe(4);
  });

  it('is cut back to the crossing, and the T comes back', () => {
    const { streets } = connectStreets([main(), street('side', [at(0, -80), at(0, 6)])]);
    expect(legCount(streets)).toBe(3);
  });

  it('ends exactly on the street it crosses', () => {
    const { streets } = connectStreets([main(), street('side', [at(0, -80), at(0, 1.5)])]);
    const side = streets.find((s) => s.id === 'side')!;
    expect(distanceMeters(side.centerline[side.centerline.length - 1]!, at(0, 0))).toBeLessThan(0.01);
  });

  it('keeps a tail long enough to be a real leg', () => {
    // The rule is "does the tail escape the junction", not "is the tail short". A 30 m
    // stub past the crossing is a fourth arm somebody drew on purpose.
    const streets = [main(), street('side', [at(0, -80), at(0, 30)])];
    expect(planConnections(streets)).toHaveLength(0);
    expect(legCount(streets)).toBe(4);
  });

  it('drops control points the cut left outside the street', () => {
    // Two points past the crossing. Moving only the last one would leave the middle one
    // beyond the new end, dragging the line back out through the junction.
    const side = street('side', [at(0, -80), at(0, -40), at(0, 1), at(0, 2)]);
    const { streets } = connectStreets([main(), side]);
    const out = streets.find((s) => s.id === 'side')!;
    for (const p of out.centerline) {
      expect(p[1]).toBeLessThanOrEqual(at(0, 0.01)[1]);
    }
    expect(legCount(streets)).toBe(3);
  });
});

describe('a side street that stops short', () => {
  it('is extended to the centerline it was aiming at', () => {
    const { streets } = connectStreets([main(), street('side', [at(0, -80), at(0, -3)])]);
    const side = streets.find((s) => s.id === 'side')!;
    expect(distanceMeters(side.centerline[side.centerline.length - 1]!, at(0, 0))).toBeLessThan(0.01);
  });

  it('is joined even when it stopped too far away for the detector to notice', () => {
    // The silent case. At 8 m the detector's tolerance — the section half-width — is
    // already exceeded, so before the weld there is no junction at all.
    const before = [main(), street('side', [at(0, -80), at(0, -8)])];
    expect(legCount(before)).toBe(0);

    const { streets } = connectStreets(before);
    expect(legCount(streets)).toBe(3);
  });

  it('is left alone when it is heading somewhere else', () => {
    // A dead end that stops near the main road but runs parallel to it was not drawn to
    // meet it, and welding it would invent a junction nobody asked for.
    const parallel = street('parallel', [at(-40, -8), at(40, -8)]);
    expect(planConnections([main(), parallel])).toHaveLength(0);
  });

  it('is left alone when the gap is a whole block', () => {
    const far = street('far', [at(0, -120), at(0, -60)]);
    expect(planConnections([main(), far])).toHaveLength(0);
  });
});

describe('two streets that end near each other', () => {
  it('are pulled together into one corner', () => {
    const a = street('a', [at(-80, 0), at(0, 0)]);
    const b = street('b', [at(3, 4), at(3, 80)]);
    const { streets } = connectStreets([a, b]);

    const outA = streets.find((s) => s.id === 'a')!;
    const outB = streets.find((s) => s.id === 'b')!;
    const endA = outA.centerline[outA.centerline.length - 1]!;
    expect(distanceMeters(endA, outB.centerline[0]!)).toBeLessThan(0.01);
  });

  it('only one of them moves, so they do not swap places', () => {
    // Both ends name the other. Applying both moves would send each to where the other
    // was, and the gap would survive the fix looking exactly as it did before.
    const a = street('a', [at(-80, 0), at(0, 0)]);
    const b = street('b', [at(3, 4), at(3, 80)]);
    const plan = planConnections([a, b]);
    expect(plan.filter((c) => c.kind === 'corner')).toHaveLength(1);
  });
});

describe('what connecting must never do', () => {
  it('leaves a street that already meets its neighbour untouched', () => {
    const exact = [main(), street('side', [at(0, -80), at(0, 0)])];
    expect(planConnections(exact)).toHaveLength(0);
  });

  it('never welds across a difference in level', () => {
    // The whole point of the level field: a bridge does not join the road beneath it.
    const over = street('over', [at(0, -80), at(0, 1.5)], { level: 1 });
    expect(planConnections([main(), over])).toHaveLength(0);
  });

  it('ignores hidden streets', () => {
    const hidden = street('hidden', [at(-100, 0), at(100, 0)], { visible: false });
    expect(planConnections([hidden, street('side', [at(0, -80), at(0, -3)])])).toHaveLength(0);
  });

  it('moves only what it was told to move', () => {
    // "Connect what I just drew" must not quietly tidy the rest of the project — that
    // would put edits in the undo step that the user did not make.
    const a = street('a', [at(-80, 0), at(0, 0)]);
    const b = street('b', [at(3, 4), at(3, 80)]);
    const plan = planConnections([a, b], { moveOnly: new Set(['b']) });
    expect(plan.every((c) => c.streetId === 'b')).toBe(true);
    expect(plan.length).toBeGreaterThan(0);
  });

  it('never pulls an end off a street it already meets', () => {
    // A crossroads where the side street ends exactly on the main road, with a second
    // road a few metres beyond. The end is done; dragging it on to reach the further
    // street would break a good junction to make a worse one.
    const beyond = street('beyond', [at(-60, 5), at(60, 5)]);
    const side = street('side', [at(0, -80), at(0, 0)]);
    expect(planConnections([main(), beyond, side], { moveOnly: new Set(['side']) })).toHaveLength(
      0,
    );
  });

  it('never leaves a street with fewer than two points', () => {
    // A two-point street whose end is trimmed onto its own start has nothing left. Better
    // to decline the weld than to produce a centerline that cannot be resolved.
    const stub = street('stub', [at(0, -1), at(0, 1)]);
    const { streets } = connectStreets([main(), stub]);
    expect(streets.find((s) => s.id === 'stub')!.centerline.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the corner flags on the points that survive a trim', () => {
    // Sharp flags are indices. Dropping a stranded point shifts every index after it, and
    // a flag left pointing at the old slot would harden the wrong corner.
    // Index 3 sits past the crossing and gets dropped, which shifts index 4 down to 3.
    // A flag left at 4 would point off the end; one left at 3 would harden the wrong
    // corner. Both flagged points must still be the points that were flagged.
    const side = street('side', [at(0, -80), at(0, -60), at(0, -40), at(0, 0.5), at(0, 1)], {
      curve: { mode: 'rounded', radiusMeters: 10, sharpVertices: [2, 4] },
    });
    const { streets } = connectStreets([main(), side]);
    const out = streets.find((s) => s.id === 'side')!;

    expect(out.centerline).toHaveLength(4);
    const flagged = out.curve!.sharpVertices!.map((i) => out.centerline[i]!);
    expect(flagged).toHaveLength(2);
    expect(distanceMeters(flagged[0]!, at(0, -40))).toBeLessThan(0.01);
    // The old index 4 was the end being welded, so it now names the weld point itself.
    expect(distanceMeters(flagged[1]!, at(0, 0))).toBeLessThan(0.01);
  });
});

describe('the plan itself', () => {
  it('is empty for a project that is already sound', () => {
    const sound = [main(), street('side', [at(0, -80), at(0, 0)])];
    expect(planConnections(sound)).toHaveLength(0);
  });

  it('says what it will do, in metres', () => {
    const plan = planConnections([main(), street('side', [at(0, -80), at(0, -3)])]);
    expect(plan[0]!.kind).toBe('extend');
    expect(plan[0]!.movedMeters).toBeCloseTo(3, 1);
    expect(plan[0]!.targetId).toBe('main');
  });

  it('changes nothing when applied to a plan that is empty', () => {
    const sound = [main(), street('side', [at(0, -80), at(0, 0)])];
    expect(applyConnections(sound, [])).toEqual(sound);
  });

  it('picks the nearer of two streets an end sits between', () => {
    // Both must be inside the weld reach, or the "nearer" is the only candidate there is
    // and the comparison never happens.
    const near = street('near', [at(-40, 10), at(40, 10)]);
    const far = street('far', [at(-40, 14), at(40, 14)]);
    const spur = street('spur', [at(0, -40), at(0, 4)]);
    const plan = planConnections([near, far, spur], { moveOnly: new Set(['spur']) });
    expect(plan[0]!.targetId).toBe('near');
    expect(plan[0]!.movedMeters).toBeCloseTo(6, 1);
  });

  it('is stable — connecting an already-connected project is a no-op', () => {
    const messy = [main(), street('side', [at(0, -80), at(0, 1.5)])];
    const once = connectStreets(messy).streets;
    resetDerivedCaches();
    expect(planConnections(once)).toHaveLength(0);
  });
});

describe('geometry that is not a perfect cross', () => {
  it('welds a skewed approach along its own heading', () => {
    // A slip lane coming in at 30 degrees. Extending perpendicular to the main road would
    // put the end somewhere the driver never goes; extending along the street's own
    // bearing is the only version that describes the design.
    const skew = street('skew', [at(-60, -35), at(-5, -3)]);
    const { streets } = connectStreets([main(), skew]);
    const out = streets.find((s) => s.id === 'skew')!;
    const end = out.centerline[out.centerline.length - 1]!;

    expect(Math.abs(end[1] - at(0, 0)[1])).toBeLessThan(1e-7);
    // It lands where its own line reaches the centerline, well east of the perpendicular
    // foot at x = -5.
    expect(end[0]).toBeGreaterThan(at(-1, 0)[0]);
    expect(legCount(streets)).toBe(3);
  });

  it('welds a curved street along the heading it ends on', () => {
    // A rounded curve keeps its last run straight, so the tangent at the end is the last
    // control segment — which is why reading the heading off the control points is right
    // here and not an approximation.
    const curved = street('curved', [at(-60, -60), at(-30, -40), at(0, -4)], {
      curve: { mode: 'rounded', radiusMeters: 20 },
    });
    const { streets } = connectStreets([main(), curved]);
    const out = streets.find((s) => s.id === 'curved')!;
    const end = out.centerline[out.centerline.length - 1]!;

    // On the main road's centerline, and east of where it stopped — it carried on the way
    // it was going rather than being dragged sideways to the nearest point.
    expect(Math.abs(end[1] - at(0, 0)[1])).toBeLessThan(1e-7);
    expect(end[0]).toBeGreaterThan(at(2, 0)[0]);
    expect(out.curve!.mode).toBe('rounded');
    expect(legCount(streets)).toBe(3);
  });
});

describe('the streets that come out', () => {
  it('are still the same streets', () => {
    const { streets } = connectStreets([main(), street('side', [at(0, -80), at(0, -3)])]);
    expect(streets.map((s) => s.id).sort()).toEqual(['main', 'side']);
    expect(streets.find((s) => s.id === 'side')!.section.components).toHaveLength(4);
  });

  it('barely change length, so a weld is a correction and not a redesign', () => {
    const side = street('side', [at(0, -80), at(0, -3)]);
    const { streets } = connectStreets([main(), side]);
    const after = lineLengthMeters(streets.find((s) => s.id === 'side')!.centerline);
    expect(after - lineLengthMeters(side.centerline)).toBeCloseTo(3, 1);
  });
});

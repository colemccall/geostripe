import { beforeEach, describe, expect, it } from 'vitest';
import { gradeSpans, isFlat, levelAt, levelsMeet, overpassProfile, sliceLine } from './grade';
import { detectJunctions } from './junctions';
import { resetDerivedCaches } from './derived';
import { componentsFromSpecs } from '../library/templates';
import { distanceMeters, lineLengthMeters } from './measure';
import type { GradePoint } from './grade';
import type { Street } from '../model/types';

/**
 * An overpass that comes back down.
 *
 * A single `level` per street could say "this is elevated" but never "this rises here and
 * lands there" — so a grade-separated crossing was a street elevated end to end, with no
 * ramps and no junctions anywhere along it. The test that matters is the one at the bottom:
 * a street that climbs over one road still meets the roads at either end.
 */

const O_LNG = -84.52;
const O_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((O_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [O_LNG + east / M_PER_LNG, O_LAT + north / M_PER_LAT];
}

function street(id: string, centerline: [number, number][], grade?: GradePoint[]): Street {
  return {
    id,
    name: id,
    centerline,
    visible: true,
    ...(grade ? { grade } : {}),
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
  };
}

beforeEach(() => resetDerivedCaches());

describe('reading a level off a profile', () => {
  const climb: GradePoint[] = [
    { stationMeters: 0, level: 0 },
    { stationMeters: 100, level: 1 },
  ];

  it('holds the first level before the profile starts', () => {
    expect(levelAt(climb, -20)).toBe(0);
  });

  it('holds the last level after it ends', () => {
    expect(levelAt(climb, 500)).toBe(1);
  });

  it('interpolates in between, because a ramp has to be somewhere', () => {
    expect(levelAt(climb, 50)).toBeCloseTo(0.5, 9);
    expect(levelAt(climb, 25)).toBeCloseTo(0.25, 9);
  });

  it('falls back when there is no profile at all', () => {
    expect(levelAt(undefined, 50, 1)).toBe(1);
    expect(levelAt([], 50, -1)).toBe(-1);
  });
});

describe('deciding whether two things meet', () => {
  it('lets a road at grade meet another at grade', () => {
    expect(levelsMeet(0, 0)).toBe(true);
  });

  it('keeps an overpass off the road beneath it', () => {
    expect(levelsMeet(1, 0)).toBe(false);
  });

  it('still lets the foot of a ramp meet the ground', () => {
    // The reason the threshold is half a level rather than exact equality. A ramp that has
    // only just started climbing is still on the street it left.
    expect(levelsMeet(0.2, 0)).toBe(true);
    expect(levelsMeet(0.8, 0)).toBe(false);
  });
});

describe('the profile for going over something', () => {
  it('rises, holds across, and comes back down', () => {
    const profile = overpassProfile(400, 200);
    expect(profile[0]!.level).toBe(0);
    expect(profile[profile.length - 1]!.level).toBe(0);
    expect(Math.max(...profile.map((p) => p.level))).toBe(1);
  });

  it('is at full height where the crossing is', () => {
    expect(levelAt(overpassProfile(400, 200), 200)).toBe(1);
  });

  it('is back on the ground at both ends', () => {
    const profile = overpassProfile(400, 200);
    expect(levelAt(profile, 0)).toBe(0);
    expect(levelAt(profile, 400)).toBe(0);
  });

  it('goes under when asked', () => {
    const profile = overpassProfile(400, 200, { direction: -1 });
    expect(levelAt(profile, 200)).toBe(-1);
    expect(levelAt(profile, 0)).toBe(0);
  });

  it('starts elevated when the street is too short to carry its ramps', () => {
    // Honest rather than clamped-to-nonsense: it says the ramp is off the end of what has
    // been drawn, which is a thing worth being able to see.
    const profile = overpassProfile(30, 15);
    expect(profile[0]!.stationMeters).toBe(0);
    expect(profile.every((p) => p.stationMeters <= 30)).toBe(true);
  });

  it('never produces two breakpoints at the same station', () => {
    for (const length of [20, 60, 140, 400]) {
      const profile = overpassProfile(length, length / 2);
      for (let i = 1; i < profile.length; i++) {
        expect(profile[i]!.stationMeters).toBeGreaterThan(profile[i - 1]!.stationMeters);
      }
    }
  });
});

describe('the stretches worth drawing differently', () => {
  it('finds two ramps and one deck on an overpass', () => {
    const spans = gradeSpans(overpassProfile(400, 200));
    expect(spans.filter((s) => s.kind === 'ramp')).toHaveLength(2);
    expect(spans.filter((s) => s.kind === 'deck')).toHaveLength(1);
  });

  it('puts the deck between the ramps', () => {
    const spans = gradeSpans(overpassProfile(400, 200));
    const deck = spans.find((s) => s.kind === 'deck')!;
    const ramps = spans.filter((s) => s.kind === 'ramp');
    expect(ramps[0]!.toMeters).toBeCloseTo(deck.fromMeters, 6);
    expect(ramps[1]!.fromMeters).toBeCloseTo(deck.toMeters, 6);
  });

  it('finds nothing on a street that never leaves the ground', () => {
    expect(gradeSpans(undefined)).toHaveLength(0);
    expect(gradeSpans([{ stationMeters: 0, level: 0 }, { stationMeters: 100, level: 0 }])).toHaveLength(0);
  });

  it('marks a tunnel as going down', () => {
    const spans = gradeSpans(overpassProfile(400, 200, { direction: -1 }));
    expect(spans.every((s) => s.direction === -1)).toBe(true);
  });
});

describe('slicing a line by station', () => {
  const line: [number, number][] = [at(0, 0), at(100, 0), at(200, 0)];

  it('returns the piece asked for, ends included', () => {
    // Asserted in metres, not degrees: the `at` helper above uses round metres-per-degree
    // constants while the slicer measures on the WGS84 series, so the two disagree by a
    // few centimetres. That gap is the fixture's, not the code's — measuring the property
    // directly tests what is meant instead of how the fixture was built.
    const piece = sliceLine(line, 50, 150);
    expect(piece.length).toBeGreaterThanOrEqual(3);
    expect(distanceMeters(piece[0]!, at(50, 0))).toBeLessThan(0.1);
    expect(distanceMeters(piece[piece.length - 1]!, at(150, 0))).toBeLessThan(0.1);
    expect(lineLengthMeters(piece)).toBeCloseTo(100, 1);
  });

  it('keeps the vertices that fall inside', () => {
    // The bend at 100 m has to survive, or a sliced curve comes out as a straight chord.
    expect(sliceLine(line, 50, 150)).toHaveLength(3);
  });

  it('clamps to the line rather than running off it', () => {
    const whole = sliceLine(line, -50, 500);
    expect(distanceMeters(whole[0]!, at(0, 0))).toBeLessThan(0.01);
    expect(distanceMeters(whole[whole.length - 1]!, at(200, 0))).toBeLessThan(0.01);
  });

  it('returns nothing for an empty span', () => {
    expect(sliceLine(line, 100, 100)).toHaveLength(0);
    expect(sliceLine(line, 150, 50)).toHaveLength(0);
  });
});

describe('what a grade profile does to junctions', () => {
  /** East-west street crossed by three north-south streets at -100, 0 and 100. */
  const cross = (grade?: GradePoint[]): Street[] => [
    street('main', [at(-200, 0), at(200, 0)], grade),
    street('west', [at(-100, -80), at(-100, 80)]),
    street('mid', [at(0, -80), at(0, 80)]),
    street('east', [at(100, -80), at(100, 80)]),
  ];

  it('meets all three when it stays on the ground', () => {
    expect(detectJunctions(cross()).junctions).toHaveLength(3);
  });

  it('skips only the one it flies over', () => {
    // The whole point. `main` runs 400 m; the middle crossing is at station 200. It climbs
    // over that one and is back on the ground for the other two.
    const flyover = overpassProfile(400, 200);
    const { junctions } = detectJunctions(cross(flyover));

    expect(junctions).toHaveLength(2);
    const met = junctions.flatMap((j) => j.streetIds).filter((id) => id !== 'main');
    expect(met.sort()).toEqual(['east', 'west']);
  });

  it('is not the same as marking the whole street elevated', () => {
    // The old model. Elevated end to end meets nothing at all, which is why an overpass
    // could never come back down to anything.
    const elevated = [{ stationMeters: 0, level: 1 }];
    expect(detectJunctions(cross(elevated)).junctions).toHaveLength(0);
  });

  it('meets the ground again at the foot of each ramp', () => {
    // A road placed right where the ramp lands still joins it — that is what makes an
    // interchange buildable out of a flyover plus ordinary streets.
    const flyover = overpassProfile(400, 200, { rampMeters: 40, holdMeters: 20 });
    const streets = [
      street('main', [at(-200, 0), at(200, 0)], flyover),
      // Station 60 along `main` is at x = -140, well below half a level.
      street('foot', [at(-140, -80), at(-140, 80)]),
    ];
    expect(levelAt(flyover, 60)).toBeLessThan(0.5);
    expect(detectJunctions(streets).junctions).toHaveLength(1);
  });

  it('lets a tunnel pass under without meeting either', () => {
    const under = overpassProfile(400, 200, { direction: -1 });
    expect(detectJunctions(cross(under)).junctions).toHaveLength(2);
  });
});

describe('telling a flat street from one that is not', () => {
  it('calls no profile flat', () => {
    expect(isFlat(undefined)).toBe(true);
    expect(isFlat([])).toBe(true);
  });

  it('calls an all-zero profile flat', () => {
    expect(isFlat([{ stationMeters: 0, level: 0 }, { stationMeters: 50, level: 0 }])).toBe(true);
  });

  it('calls an overpass not flat', () => {
    expect(isFlat(overpassProfile(400, 200))).toBe(false);
  });
});

describe('surviving a save and reload', () => {
  it('carries the profile through the project file', async () => {
    const { serializeProject, parseProject } = await import('../model/project');
    const { TEMPLATES, instantiateTemplate } = await import('../library/templates');

    const flyover = overpassProfile(400, 200);
    const original = street('main', [at(-200, 0), at(200, 0)], flyover);

    const text = serializeProject([original], { name: 'grade', editorVersion: 'test' });
    const fallback = instantiateTemplate(TEMPLATES[1]!);
    const parsed = parseProject(text, {
      sectionName: fallback.name,
      components: fallback.components,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const back = parsed.streets[0]!;
    expect(back.grade).toBeDefined();
    // The shape is what matters, not the exact float: it is rounded on the way out.
    expect(back.grade!.length).toBe(flyover.length);
    expect(levelAt(back.grade, 200)).toBeCloseTo(1, 3);
    expect(levelAt(back.grade, 0)).toBeCloseTo(0, 3);
    expect(gradeSpans(back.grade).filter((s) => s.kind === 'ramp')).toHaveLength(2);
  });

  it('leaves a flat street with no profile in the file', async () => {
    const { serializeProject } = await import('../model/project');
    const flat = street('flat', [at(-100, 0), at(100, 0)]);
    const text = serializeProject([flat], { name: 'flat', editorVersion: 'test' });
    expect(text).not.toContain('grade');
  });
});

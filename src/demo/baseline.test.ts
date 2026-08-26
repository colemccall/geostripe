import { beforeEach, describe, expect, it } from 'vitest';
import { createCincinnatiProject } from './cincinnati';
import { deriveProject, resetDerivedCaches } from '../geo/derived';
import { buildDesignData } from '../map/designLayers';
import { resolveCenterline } from '../geo/curve';
import { connectStreets, planConnections } from '../geo/connect';

/**
 * The downtown Cincinnati baseline, as a working project rather than a fixture.
 *
 * Ten streets and thirteen junctions is the size at which this editor started feeling
 * slow, so it is the size the guarantees are written against. The numbers below are budgets
 * with room in them, not measurements — they exist to catch a change that makes the whole
 * pipeline an order of magnitude worse, which is what actually happened here twice:
 *
 *   Tessellating to a fixed chord LENGTH rather than a deviation, so one gently curving
 *   street resolved to 309 points and cost more than the other nine put together.
 *
 *   Trimming every band against every junction, including the ones on the far side of the
 *   map, and keying the trim cache on all of them together so one corner radius rebuilt
 *   the project.
 *
 * Timings are deliberately loose — a shared CI box is not a benchmark rig — and the
 * structural assertions above them are the real guard. A vertex count cannot be flaky.
 */

beforeEach(() => resetDerivedCaches());

describe('the baseline project', () => {
  it('loads through the ordinary importer', () => {
    const demo = createCincinnatiProject();
    expect(demo.streets).toHaveLength(10);
    expect(demo.streets.every((s) => s.section.components.length > 0)).toBe(true);
  });

  it('brings its designed intersections with it', () => {
    // The point of shipping a project rather than ten centerlines: the corner radii and
    // crosswalks are the worked part of the worked example.
    const demo = createCincinnatiProject();
    expect(Object.keys(demo.junctionOverrides).length).toBeGreaterThan(0);
  });

  it('finds the intersections that are really there', () => {
    const demo = createCincinnatiProject();
    const derived = deriveProject(demo.streets, { overrides: demo.junctionOverrides });
    expect(derived.junctionGeometry.length).toBeGreaterThanOrEqual(10);
  });

  it('has the loose ends real tracing leaves behind', () => {
    // Shipped as traced, not tidied. Six ends miss what they were aimed at — which is what
    // clicking along imagery produces, and why the joining engine exists. Tidying the file
    // would hide the one thing this example is best placed to demonstrate.
    const demo = createCincinnatiProject();
    expect(planConnections(demo.streets)).toHaveLength(6);
  });

  it('is carrying three junctions that are secretly the wrong shape', () => {
    // The bug the joining engine was written for, found in a real project three times: a
    // side street overshooting by a couple of metres reads as a clean T on screen and
    // builds a four-way underneath, with a phantom leg and a fourth corner fillet.
    const demo = createCincinnatiProject();
    const before = deriveProject(demo.streets, { overrides: demo.junctionOverrides });
    resetDerivedCaches();
    const joined = connectStreets(demo.streets).streets;
    const after = deriveProject(joined, { overrides: demo.junctionOverrides });

    const tees = (d: ReturnType<typeof deriveProject>) =>
      d.junctionGeometry.filter((g) => g.legs.length === 3).length;

    expect(tees(after) - tees(before)).toBe(3);
    // No junction invented or destroyed — the same intersections, correctly shaped.
    expect(after.junctionGeometry).toHaveLength(before.junctionGeometry.length);
  });

  it('is clean once joined, and stays clean', () => {
    const demo = createCincinnatiProject();
    const joined = connectStreets(demo.streets).streets;
    expect(planConnections(joined)).toHaveLength(0);
  });
});

describe('what the geometry costs', () => {
  it('spends vertices where a curve actually bends', () => {
    // Sampling to a deviation rather than a chord length. The curved street here has 11
    // control points; a fixed 1.2 m chord turned that into 309 resolved points, nearly all
    // of them moving the line by less than a millimetre.
    const demo = createCincinnatiProject();
    const resolved = demo.streets.map((s) => resolveCenterline(s).length);
    expect(Math.max(...resolved)).toBeLessThan(150);
    // And it is still a curve, not a polyline pretending to be one.
    expect(Math.max(...resolved)).toBeGreaterThan(20);
  });

  it('cuts a street only at the junctions it meets', () => {
    // Not just cheaper — correct. A street running past an intersection it does not join
    // used to have a bite taken out of it whenever the box reached that far.
    const demo = createCincinnatiProject();
    const derived = deriveProject(demo.streets, { overrides: demo.junctionOverrides });

    for (const street of demo.streets) {
      const meets = derived.junctionGeometry.filter((g) =>
        g.legs.some((leg) => leg.streetId === street.id),
      );
      const bands = derived.byStreet.get(street.id)?.bands ?? [];
      if (meets.length > 0) continue;
      // A street meeting nothing keeps every band whole.
      expect(bands.every((b) => b.geometry.type === 'Polygon')).toBe(true);
    }
  });

  it('re-derives an untouched project from cache', () => {
    const demo = createCincinnatiProject();
    deriveProject(demo.streets, { overrides: demo.junctionOverrides });

    const started = performance.now();
    for (let i = 0; i < 20; i++) deriveProject(demo.streets, { overrides: demo.junctionOverrides });
    expect((performance.now() - started) / 20).toBeLessThan(15);
  });

  it('keeps a vertex drag inside a frame or two', () => {
    // The number that decides whether dragging feels direct or syrupy. Each iteration is a
    // genuinely different geometry, the way a real drag is — reusing one moved copy would
    // measure the cache instead of the work.
    const demo = createCincinnatiProject();
    const { streets, junctionOverrides: overrides } = demo;
    deriveProject(streets, { overrides });

    const live = streets[0]!.id;
    const started = performance.now();
    const frames = 8;
    for (let i = 0; i < frames; i++) {
      const moved = streets.map((s, j) =>
        j === 0
          ? {
              ...s,
              centerline: s.centerline.map((p, k) =>
                k === 0 ? ([p[0] + i * 1e-7, p[1]] as [number, number]) : p,
              ),
            }
          : s,
      );
      deriveProject(moved, { overrides, liveStreetId: live });
    }
    expect((performance.now() - started) / frames).toBeLessThan(60);
  });

  it('does not re-clip the whole project for one corner radius', () => {
    // The cache used to be keyed on every junction's signature at once, so this cost a
    // full rebuild — and got worse with every intersection added, which is precisely the
    // "slower the further you go" complaint.
    const demo = createCincinnatiProject();
    const { streets, junctionOverrides: overrides } = demo;
    deriveProject(streets, { overrides });

    const key = Object.keys(overrides)[0]!;
    const started = performance.now();
    const edits = 6;
    for (let i = 0; i < edits; i++) {
      deriveProject(streets, {
        overrides: { ...overrides, [key]: { ...overrides[key], corners: [{ radiusMeters: 4 + i }] } },
      });
    }
    expect((performance.now() - started) / edits).toBeLessThan(120);
  });
});

describe('what reaches the map', () => {
  it('stays within a sane payload', () => {
    // Every feature here is re-tessellated by MapLibre on each update, so the count is a
    // running cost and not just a memory one.
    const demo = createCincinnatiProject();
    const data = buildDesignData(demo.streets, null, { overrides: demo.junctionOverrides });

    expect(data.bands.features.length).toBeLessThan(120);
    expect(data.stamps.features.length).toBeLessThan(600);
    expect(data.markings.features.length).toBeLessThan(300);
  });
});

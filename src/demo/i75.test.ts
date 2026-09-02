import { beforeEach, describe, expect, it } from 'vitest';
import { createI75Project } from './cincinnati';
import { deriveProject, resetDerivedCaches } from '../geo/derived';
import { planConnections } from '../geo/connect';
import { lineLengthMeters } from '../geo/measure';
import { resolveCenterline } from '../geo/curve';

/**
 * The I-75 alternative, and what it exposes.
 *
 * The freeway case: two eight-lane mainlines and eight ramps. Unlike a street grid, these
 * do not simply meet at nodes — a ramp leaves and the mainline carries fewer lanes
 * afterwards, which is one road with two widths rather than two roads meeting.
 */

beforeEach(() => resetDerivedCaches());

describe('the I-75 baseline', () => {
  it('loads through the ordinary importer', () => {
    const demo = createI75Project();
    expect(demo.streets).toHaveLength(10);
    expect(demo.areas.length).toBeGreaterThan(0);
  });

  it('has two eight-lane mainlines and eight two-lane ramps', () => {
    const demo = createI75Project();
    const lanes = (id: string) =>
      demo.streets
        .find((s) => s.id === id)!
        .section.components.filter((c) => c.componentType.includes('Lane')).length;

    const counts = demo.streets
      .map((s) => s.section.components.filter((c) => c.componentType.includes('Lane')).length)
      .sort((a, b) => b - a);
    expect(counts.slice(0, 2)).toEqual([8, 8]);
    expect(counts.slice(2)).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    expect(lanes(demo.streets[0]!.id)).toBeGreaterThan(0);
  });

  it('is long enough to carry lane changes', () => {
    // A section change needs room for its taper either side. A mainline that is only a
    // couple of hundred metres cannot express a lane drop at all.
    const demo = createI75Project();
    const longest = Math.max(
      ...demo.streets.map((s) => lineLengthMeters(resolveCenterline(s))),
    );
    expect(longest).toBeGreaterThan(400);
  });

  it('derives without collapsing any street', { timeout: 20000 }, () => {
    // Twenty seconds, and it needs several. A cold derive of this project is about two
    // SECONDS against Cincinnati's third of one, because Street 1 is four kilometres of
    // smooth curve carrying a fifteen-component section — bands of five hundred vertices,
    // each one trimmed against every junction it meets by polygon boolean.
    //
    // That is the cost the roadmap's next item exists to remove: trimming at junctions by
    // station along the centreline instead of by boolean. Freeway geometry is what makes
    // it urgent rather than merely untidy.
    const demo = createI75Project();
    const derived = deriveProject(demo.streets, { overrides: demo.junctionOverrides });
    for (const street of demo.streets) {
      expect(derived.byStreet.get(street.id)!.bands.length).toBeGreaterThan(0);
    }
  });

  it('reports its loose ends rather than hiding them', () => {
    // Traced, not tidied — same as the downtown baseline. Whatever the count, the plan has
    // to be computable on real freeway geometry without throwing.
    const demo = createI75Project();
    expect(() => planConnections(demo.streets)).not.toThrow();
  });
});

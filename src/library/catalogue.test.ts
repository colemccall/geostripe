import { describe, expect, it } from 'vitest';
import {
  COMPONENT_CATEGORIES,
  COMPONENT_TYPES,
  PRIMITIVES,
  searchPrimitives,
} from './primitives';
import {
  TEMPLATES,
  TEMPLATE_CATEGORIES,
  instantiateTemplate,
  searchTemplates,
  templateTotalWidth,
} from './templates';
import { totalWidth } from '../model/section';
import { metresToDisplay } from '../lib/units';

/**
 * The asset catalogue.
 *
 * A library this size stops being reviewable by eye, which is the point at which it needs
 * tests that a reader can trust instead. These check the things that go wrong when a
 * catalogue grows: an entry nobody can find, a category nobody filters to, a generated
 * family that quietly produced a street four inches wide.
 */

const ft = (metres: number) => metresToDisplay(metres, 'ft');

describe('the primitive catalogue', () => {
  it('is substantial and every entry is reachable', () => {
    expect(COMPONENT_TYPES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(COMPONENT_TYPES).size).toBe(COMPONENT_TYPES.length);
    // Everything appears in an unfiltered search, or it is in the data and not in the UI.
    expect(searchPrimitives('')).toHaveLength(COMPONENT_TYPES.length);
  });

  it('puts every primitive in a category the filter offers', () => {
    const offered = new Set(COMPONENT_CATEGORIES.map((c) => c.id));
    for (const type of COMPONENT_TYPES) {
      expect(offered.has(PRIMITIVES[type].category)).toBe(true);
    }
  });

  it('leaves no category empty', () => {
    // An empty filter chip is a dead end for the reader.
    for (const group of COMPONENT_CATEGORIES) {
      const members = COMPONENT_TYPES.filter((t) => PRIMITIVES[t].category === group.id);
      expect(members.length).toBeGreaterThan(0);
    }
  });

  it('finds things by what they are for, not just by name', () => {
    // The reason notes are searchable: you rarely know the name of the thing you want.
    expect(searchPrimitives('refuge')).toContain('medianRefuge');
    expect(searchPrimitives('freight')).toContain('loadingZone');
    expect(searchPrimitives('drainage')).toContain('bioswale');
    expect(searchPrimitives('breakdown')).toContain('shoulder');
  });

  it('gives every primitive a real note, not a placeholder', () => {
    for (const type of COMPONENT_TYPES) {
      expect(PRIMITIVES[type].note.length).toBeGreaterThan(25);
    }
  });

  it('keeps the eleven original ids, so old files still load', () => {
    // These were in the first release. Renaming one silently changes what a saved project
    // opens as, and the loader would report it as an unknown component type.
    for (const type of [
      'travelLane',
      'turnLane',
      'busLane',
      'bikeLaneConventional',
      'bikeLaneBuffered',
      'bikeLaneProtected',
      'parkingLaneParallel',
      'parkingLaneAngled',
      'median',
      'shoulder',
      'sidewalk',
    ] as const) {
      expect(PRIMITIVES[type]).toBeDefined();
    }
  });
});

describe('the template catalogue', () => {
  it('is substantial and uniquely keyed', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  it('puts every template in a category the filter offers, and leaves none empty', () => {
    const offered = new Set(TEMPLATE_CATEGORIES.map((c) => c.id));
    for (const template of TEMPLATES) expect(offered.has(template.category)).toBe(true);
    for (const group of TEMPLATE_CATEGORIES) {
      expect(TEMPLATES.filter((t) => t.category === group.id).length).toBeGreaterThan(0);
    }
  });

  it('produces a plausible street from every single one', () => {
    // The check that catches a generated family going wrong: a section four inches wide,
    // or one wider than a city block, is a transposed number rather than a design.
    for (const template of TEMPLATES) {
      const section = instantiateTemplate(template);
      expect(section.components.length).toBeGreaterThan(0);

      const width = totalWidth(section.components);
      expect(width).toBeCloseTo(templateTotalWidth(template), 6);
      expect(ft(width)).toBeGreaterThan(12);
      expect(ft(width)).toBeLessThan(400);

      for (const component of section.components) {
        expect(component.widthMeters).toBeGreaterThan(0);
      }
    }
  });

  it('mints fresh component ids each time, so two placements never alias', () => {
    const a = instantiateTemplate(TEMPLATES[0]!);
    const b = instantiateTemplate(TEMPLATES[0]!);
    const ids = new Set(a.components.map((c) => c.id));
    for (const component of b.components) expect(ids.has(component.id)).toBe(false);
  });

  it('searches by the components a section contains', () => {
    // How you find "the one with a busway" without remembering its name.
    const busway = searchTemplates('busway');
    expect(busway.length).toBeGreaterThan(0);
    for (const template of busway) {
      const hit =
        template.label.toLowerCase().includes('busway') ||
        template.specs.some(([type]) => type === 'busway');
      expect(hit).toBe(true);
    }

    expect(searchTemplates('tram').length).toBeGreaterThan(0);
    expect(searchTemplates('zzzz')).toHaveLength(0);
  });

  it('keeps the eight original template ids, which saved projects reference', () => {
    for (const id of [
      'existing-stroad',
      'protected-retrofit',
      'transit-priority',
      'parking-protected',
      'median-boulevard',
      'neighborhood',
      'main-street',
      'one-way-protected',
    ]) {
      expect(TEMPLATES.find((t) => t.id === id)).toBeDefined();
    }
  });

  it('makes freeway sections wider than city streets, as they are on the ground', () => {
    const freeway = TEMPLATES.find((t) => t.id === 'freeway-6-barrier')!;
    const local = TEMPLATES.find((t) => t.id === 'neighborhood')!;

    // The figures, rather than a ratio picked out of the air: six 12 ft lanes is 72 ft
    // before shoulders, barrier and sound walls, which lands the section near 105 ft. A
    // local street with parking both sides is around 54 ft.
    expect(ft(templateTotalWidth(freeway))).toBeGreaterThan(95);
    expect(ft(templateTotalWidth(local))).toBeLessThan(60);
    expect(templateTotalWidth(freeway)).toBeGreaterThan(templateTotalWidth(local) * 1.75);
  });

  it('makes every road diet narrower than the as-built street of the same lane count', () => {
    const built = TEMPLATES.find((t) => t.id === 'existing-4-plain')!;
    for (const diet of TEMPLATES.filter((t) => t.category === 'diet' && t.id.endsWith('-4'))) {
      const dietLanes = diet.specs.filter(([type]) => type === 'travelLane');
      const builtLanes = built.specs.filter(([type]) => type === 'travelLane');
      expect(dietLanes.length).toBe(builtLanes.length);
      // Same number of lanes, narrower lanes, so the carriageway shrinks even though the
      // template gains a kerbside element.
      const laneWidth = (specs: typeof dietLanes) =>
        specs.reduce((sum, [type, , w]) => sum + (w ?? PRIMITIVES[type].defaultWidthMeters), 0);
      expect(laneWidth(dietLanes)).toBeLessThan(laneWidth(builtLanes));
    }
  });
});

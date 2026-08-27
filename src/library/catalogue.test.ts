import { describe, expect, it } from 'vitest';
import {
  COMPONENT_CATEGORIES,
  COMPONENT_TYPES,
  DEFAULT_LANE_GLYPHS,
  PRIMITIVES,
  primitiveTree,
  searchPrimitives,
} from './primitives';
import { GLYPHS } from '../geo/glyphs';
import {
  TEMPLATES,
  TEMPLATE_CATEGORIES,
  instantiateTemplate,
  searchTemplates,
  templateTotalWidth,
  templateTree,
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
    expect(COMPONENT_TYPES.length).toBeGreaterThanOrEqual(90);
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

  it('keeps a path out of the carriageway', () => {
    // The load-bearing distinction between a path and a narrow street. A path with
    // isRoadway true would take the travelway anchor, get a kerb line drawn along it, and
    // be trimmed as carriageway at every junction it touches.
    for (const type of COMPONENT_TYPES) {
      if (PRIMITIVES[type].category !== 'path') continue;
      expect(PRIMITIVES[type].isRoadway).toBe(false);
    }
  });

  it('gives every lane symbol a component that is wide enough to hold it', () => {
    // A default that never fits its own lane is a default that never appears, which reads
    // as a bug rather than as the deliberate suppression it is.
    for (const [type, preset] of Object.entries(DEFAULT_LANE_GLYPHS)) {
      const spec = PRIMITIVES[type as (typeof COMPONENT_TYPES)[number]];
      expect(GLYPHS[preset!.glyph].widthMeters).toBeLessThan(spec.defaultWidthMeters);
      expect(preset!.spacingMeters).toBeGreaterThan(GLYPHS[preset!.glyph].lengthMeters);
    }
  });

  it('leaves nothing stranded outside the browser tree', () => {
    // The tree is what the palette navigates. A primitive in no listed group would simply
    // not exist as far as the UI is concerned, and nothing anywhere would say so.
    const inTree = primitiveTree().flatMap((c) => c.groups.flatMap((g) => g.items));
    expect(new Set(inTree).size).toBe(COMPONENT_TYPES.length);
    for (const type of COMPONENT_TYPES) expect(inTree).toContain(type);
  });

  it('names every group, and keeps categories from splintering into singletons', () => {
    for (const category of primitiveTree()) {
      expect(category.groups.length).toBeGreaterThan(0);
      // More than six groups in one category is a category that wants splitting; a group
      // per item is a tree that navigates no better than the flat list it replaced.
      expect(category.groups.length).toBeLessThanOrEqual(6);
      for (const group of category.groups) {
        expect(group.label.length).toBeGreaterThan(2);
        expect(group.items.length).toBeGreaterThan(0);
      }
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
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(150);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  it('puts every template in a category the filter offers, and leaves none empty', () => {
    const offered = new Set(TEMPLATE_CATEGORIES.map((c) => c.id));
    for (const template of TEMPLATES) expect(offered.has(template.category)).toBe(true);

    for (const group of TEMPLATE_CATEGORIES) {
      // 'saved' is the one category the catalogue does not fill: it holds sections the
      // user built, and a fresh install has none. The tree drops empty groups, so it
      // simply does not appear until there is something in it.
      if (group.id === 'saved') continue;
      expect(TEMPLATES.filter((t) => t.category === group.id).length).toBeGreaterThan(0);
    }
  });

  it('ships no saved sections of its own', () => {
    // Guards the exemption above from becoming a hiding place: 'saved' means "yours", and
    // a built-in preset sitting in it would be the library claiming credit for your work.
    expect(TEMPLATES.filter((t) => t.category === 'saved')).toHaveLength(0);
  });

  it('offers Yours first, where a saved section is easiest to find', () => {
    expect(TEMPLATE_CATEGORIES[0]!.id).toBe('saved');
  });

  it('produces a plausible street from every single one', () => {
    // The check that catches a generated family going wrong: a section four inches wide,
    // or one wider than a city block, is a transposed number rather than a design.
    for (const template of TEMPLATES) {
      const section = instantiateTemplate(template);
      expect(section.components.length).toBeGreaterThan(0);

      const width = totalWidth(section.components);
      expect(width).toBeCloseTo(templateTotalWidth(template), 6);
      // A path is legitimately narrower than any street — a 10 ft boardwalk is a real
      // cross-section, not a transposed number — so the floor is per-kind rather than one
      // figure that would have to be loosened until it caught nothing.
      expect(ft(width)).toBeGreaterThan(template.category === 'path' ? 7 : 12);
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

  it('leaves no preset outside the tree, and no family unreasonably large', () => {
    const inTree = templateTree().flatMap((c) => c.groups.flatMap((g) => g.items));
    expect(inTree).toHaveLength(TEMPLATES.length);
    for (const category of templateTree()) {
      for (const group of category.groups) {
        expect(group.label.length).toBeGreaterThan(2);
        // A family of thirty is a flat list wearing a tree's clothes.
        expect(group.items.length).toBeLessThanOrEqual(14);
      }
    }
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

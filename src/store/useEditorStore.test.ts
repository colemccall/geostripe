import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore, cloneSection } from './useEditorStore';
import { createDemoStreets } from '../demo/washingtonPark';
import { TEMPLATES, instantiateTemplate } from '../library/templates';
import { detectJunctions } from '../geo/junctions';

/**
 * Store behaviour that is easy to get subtly wrong and impossible to see on screen.
 *
 * The two things under test are history granularity and aliasing. A drag that records two
 * hundred history entries still *looks* correct until someone presses Ctrl+Z; a section
 * that aliases its source still *looks* correct until editing one street silently rewrites
 * another.
 */

const line: [number, number][] = [
  [-84.52, 39.11],
  [-84.52, 39.112],
  [-84.519, 39.113],
];

function reset() {
  const streets = createDemoStreets();
  useEditorStore.setState({
    streets,
    draftSection: instantiateTemplate(TEMPLATES[1]!),
    selectedStreetId: streets[0]?.id ?? null,
    selectedComponentId: null,
    drawSectionId: TEMPLATES[1]!.id,
    tool: 'select',
    past: [],
    future: [],
  });
}

describe('drawing a street', () => {
  beforeEach(reset);

  it('creates it from the chosen template and selects it', () => {
    const store = useEditorStore.getState();
    store.setDrawSectionId('transit-priority');
    const id = useEditorStore.getState().addStreet(line);

    const state = useEditorStore.getState();
    const street = state.streets.find((s) => s.id === id);
    expect(street).toBeDefined();
    expect(street!.centerline).toEqual(line);
    expect(state.selectedStreetId).toBe(id);
    expect(street!.section.components.map((c) => c.componentType)).toEqual(
      instantiateTemplate(TEMPLATES.find((t) => t.id === 'transit-priority')!).components.map(
        (c) => c.componentType,
      ),
    );
  });

  it('leaves draw mode so the next click does not start another street', () => {
    useEditorStore.setState({ tool: 'draw' });
    useEditorStore.getState().addStreet(line);
    expect(useEditorStore.getState().tool).toBe('select');
  });

  it('is one undo step', () => {
    const before = useEditorStore.getState().streets.length;
    useEditorStore.getState().addStreet(line);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().streets).toHaveLength(before);
  });

  it('does not alias the Asset Builder draft', () => {
    useEditorStore.getState().setDrawSectionId('draft');
    const id = useEditorStore.getState().addStreet(line);

    const street = useEditorStore.getState().streets.find((s) => s.id === id)!;
    const draftIds = useEditorStore.getState().draftSection.components.map((c) => c.id);
    for (const component of street.section.components) {
      expect(draftIds).not.toContain(component.id);
    }

    // And editing the street must not move the draft.
    const target = street.section.components[1]!;
    const draftWidthBefore = useEditorStore.getState().draftSection.components[1]!.widthMeters;
    useEditorStore.getState().setWidth('street', target.id, 9.99);
    expect(useEditorStore.getState().draftSection.components[1]!.widthMeters).toBe(
      draftWidthBefore,
    );
  });
});

describe('vertex gestures', () => {
  beforeEach(reset);

  it('records a whole drag as a single undo step', () => {
    const state = useEditorStore.getState();
    const street = state.streets[0]!;
    const original = street.centerline;

    state.beginGesture();
    // A real drag is hundreds of these.
    for (let i = 1; i <= 40; i++) {
      useEditorStore.getState().moveVertexLive(street.id, 0, [-84.53 + i * 1e-5, 39.1 + i * 1e-5]);
    }
    useEditorStore.getState().endGesture();

    expect(useEditorStore.getState().past).toHaveLength(1);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().streets[0]!.centerline).toEqual(original);
  });

  it('records nothing when a gesture ends where it started', () => {
    useEditorStore.getState().beginGesture();
    useEditorStore.getState().endGesture();
    expect(useEditorStore.getState().past).toHaveLength(0);
  });

  it('inserts and drags a midpoint as one step', () => {
    const street = useEditorStore.getState().streets[0]!;
    const originalCount = street.centerline.length;

    useEditorStore.getState().beginGesture();
    useEditorStore.getState().insertVertexLive(street.id, 0, [-84.5, 39.11]);
    useEditorStore.getState().moveVertexLive(street.id, 1, [-84.4999, 39.1101]);
    useEditorStore.getState().endGesture();

    expect(useEditorStore.getState().streets[0]!.centerline).toHaveLength(originalCount + 1);
    expect(useEditorStore.getState().past).toHaveLength(1);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().streets[0]!.centerline).toHaveLength(originalCount);
  });

  it('refuses to delete a vertex below the two a line needs', () => {
    const id = useEditorStore.getState().addStreet([
      [-84.52, 39.11],
      [-84.52, 39.112],
    ]);
    useEditorStore.getState().removeVertex(id, 0);
    const street = useEditorStore.getState().streets.find((s) => s.id === id)!;
    expect(street.centerline).toHaveLength(2);
  });
});

describe('duplicating', () => {
  beforeEach(reset);

  it('copies geometry and section without sharing any ids', () => {
    const source = useEditorStore.getState().streets[0]!;
    useEditorStore.getState().duplicateStreet(source.id);

    const state = useEditorStore.getState();
    const copy = state.streets[state.streets.length - 1]!;

    expect(copy.id).not.toBe(source.id);
    expect(copy.centerline).toEqual(source.centerline);
    expect(copy.section.id).not.toBe(source.section.id);

    const sourceIds = new Set(source.section.components.map((c) => c.id));
    for (const component of copy.section.components) {
      expect(sourceIds.has(component.id)).toBe(false);
    }

    // Moving the copy must not move the original.
    useEditorStore.getState().moveVertexLive(copy.id, 0, [-1, 1]);
    expect(useEditorStore.getState().streets[0]!.centerline).toEqual(source.centerline);
  });
});

describe('cloneSection', () => {
  it('keeps every value and replaces every id', () => {
    const source = instantiateTemplate(TEMPLATES[0]!);
    const copy = cloneSection(source);

    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe(source.name);
    expect(copy.anchorOffsetMeters).toBe(source.anchorOffsetMeters);
    expect(copy.components.map((c) => c.widthMeters)).toEqual(
      source.components.map((c) => c.widthMeters),
    );
    expect(copy.components.map((c) => c.id)).not.toEqual(source.components.map((c) => c.id));
  });
});

describe('setComponentMarkings', () => {
  it('sets a symbol, and clears it back to the default rather than to nothing', () => {
    const street = useEditorStore.getState().streets[0]!;
    useEditorStore.getState().selectStreet(street.id);
    const component = street.section.components[0]!;

    useEditorStore.getState().setComponentMarkings('street', component.id, { glyph: 'sharrow' });
    const marked = useEditorStore.getState().streets[0]!.section.components[0]!;
    expect(marked.glyph).toBe('sharrow');

    // Clearing has to remove the key, not write `undefined` into it: a key that is present
    // and undefined survives a JSON round trip as a null and stops meaning "inherit".
    useEditorStore.getState().setComponentMarkings('street', component.id, { glyph: undefined });
    const cleared = useEditorStore.getState().streets[0]!.section.components[0]!;
    expect('glyph' in cleared).toBe(false);
  });

  it('is one undo step and leaves the other bands alone', () => {
    const street = useEditorStore.getState().streets[0]!;
    const before = street.section.components.map((c) => c.glyph);

    useEditorStore
      .getState()
      .setComponentMarkings('street', street.section.components[1]!.id, { stripeLeft: 'none' });
    useEditorStore.getState().undo();

    const after = useEditorStore.getState().streets[0]!.section.components;
    expect(after.map((c) => c.glyph)).toEqual(before);
    expect(after[1]!.stripeLeft).toBeUndefined();
  });
});

describe('placed intersections', () => {
  it('places, selects and deletes one, and undo brings it back', () => {
    const before = useEditorStore.getState().nodes.length;
    const id = useEditorStore.getState().addNode([-84.52, 39.11]);

    expect(useEditorStore.getState().nodes).toHaveLength(before + 1);
    expect(useEditorStore.getState().selectedNodeId).toBe(id);

    useEditorStore.getState().removeNode(id);
    expect(useEditorStore.getState().nodes).toHaveLength(before);
    expect(useEditorStore.getState().selectedNodeId).toBeNull();

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().nodes.some((n) => n.id === id)).toBe(true);
  });

  it('takes its junction settings with it when deleted', () => {
    // The key is the node id, so nothing can ever claim those settings again. Leaving
    // them would be a slow leak that survives every save and load.
    const id = useEditorStore.getState().addNode([-84.52, 39.11]);
    useEditorStore.getState().updateCorner(`node:${id}`, 0, { radiusMeters: 3 });
    expect(useEditorStore.getState().junctionOverrides[`node:${id}`]).toBeDefined();

    useEditorStore.getState().removeNode(id);
    expect(useEditorStore.getState().junctionOverrides[`node:${id}`]).toBeUndefined();
  });

  it('drags a street END along with the node, and leaves a street it passes through alone', () => {
    // The behaviour a road-building game has, and for the same reason: an endpoint at the
    // node IS the node, while a street the node sits on is one the node slides along.
    const state = useEditorStore.getState();
    const through = state.streets[0]!;
    const start = through.centerline[0]!;

    const id = state.addNode([start[0], start[1]]);
    const moved: [number, number] = [start[0] + 0.0002, start[1] + 0.0002];
    useEditorStore.getState().moveNodeLive(id, moved);

    const after = useEditorStore.getState().streets.find((s) => s.id === through.id)!;
    expect(after.centerline[0]).toEqual(moved);
    // Everything that was not at the node is untouched.
    expect(after.centerline[1]).toEqual(through.centerline[1]);
  });

  it('selecting a node puts down whatever else was selected', () => {
    const street = useEditorStore.getState().streets[0]!;
    useEditorStore.getState().selectStreet(street.id);
    const id = useEditorStore.getState().addNode([-84.52, 39.11]);
    useEditorStore.getState().selectNode(id);

    expect(useEditorStore.getState().selectedStreetId).toBeNull();
    expect(useEditorStore.getState().selectedNodeId).toBe(id);

    useEditorStore.getState().clearSelection();
    expect(useEditorStore.getState().selectedNodeId).toBeNull();
  });

  it('takes ownership of one crossing at a time, and selects what it made', () => {
    // This replaced a button that placed a node at every crossing at once. Owning an
    // intersection is a decision about that intersection, and forty at a stroke is forty
    // decisions nobody made.
    useEditorStore.getState().loadDemo();
    const before = useEditorStore.getState().nodes.length;

    const id = useEditorStore.getState().placeNodeAt([-84.5155, 39.1105]);
    expect(useEditorStore.getState().nodes).toHaveLength(before + 1);
    expect(useEditorStore.getState().selectedNodeId).toBe(id);
  });
});

/**
 * Welding loose ends, from the store's side.
 *
 * The geometry itself is covered in `geo/connect.test.ts`. What can only be tested here is
 * the part that is about editing rather than about shapes: that the weld and the street it
 * belongs to land in ONE undo step, and that turning the feature off really leaves the
 * line where it was drawn.
 */
describe('joining ends as streets are drawn', () => {
  const M_PER_LAT = 111132;
  const M_PER_LNG = 111412 * Math.cos((39.11 * Math.PI) / 180);
  const at = (east: number, north: number): [number, number] => [
    -84.52 + east / M_PER_LNG,
    39.11 + north / M_PER_LAT,
  ];

  /** One east–west street to join, and nothing else to confuse the plan. */
  function blankWithMain() {
    useEditorStore.setState({
      streets: [],
      areas: [],
      nodes: [],
      junctionOverrides: {},
      past: [],
      future: [],
      autoConnect: true,
      drawSectionId: TEMPLATES[1]!.id,
    });
    return useEditorStore.getState().addStreet([at(-100, 0), at(100, 0)]);
  }

  const endOf = (id: string) => {
    const street = useEditorStore.getState().streets.find((s) => s.id === id)!;
    return street.centerline[street.centerline.length - 1]!;
  };

  it('moves a new street onto the one it stopped short of', () => {
    blankWithMain();
    const side = useEditorStore.getState().addStreet([at(0, -80), at(0, -6)]);
    // Welded to the main road's centerline at y = 0, not left where the click landed.
    expect(endOf(side)[1]).toBeCloseTo(at(0, 0)[1], 9);
  });

  it('does that in one undo step, not two', () => {
    const before = blankWithMain();
    const past = useEditorStore.getState().past.length;
    useEditorStore.getState().addStreet([at(0, -80), at(0, -6)]);
    expect(useEditorStore.getState().past.length).toBe(past + 1);

    // And one undo really takes the whole thing back.
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().streets.map((s) => s.id)).toEqual([before]);
  });

  it('leaves the line exactly where it was drawn when the toggle is off', () => {
    blankWithMain();
    useEditorStore.getState().setAutoConnect(false);
    const side = useEditorStore.getState().addStreet([at(0, -80), at(0, -6)]);
    expect(endOf(side)[1]).toBeCloseTo(at(0, -6)[1], 9);
  });

  it('never moves the street that was already there', () => {
    // Only the new street may move. Welding the through street to the spur would drag a
    // hundred metres of design sideways to close a six-metre gap.
    const main = blankWithMain();
    const mainBefore = useEditorStore.getState().streets.find((s) => s.id === main)!.centerline;
    useEditorStore.getState().addStreet([at(0, -80), at(0, -6)]);
    expect(useEditorStore.getState().streets.find((s) => s.id === main)!.centerline).toEqual(
      mainBefore,
    );
  });
});

describe('joining ends on demand', () => {
  const M_PER_LAT = 111132;
  const M_PER_LNG = 111412 * Math.cos((39.11 * Math.PI) / 180);
  const at = (east: number, north: number): [number, number] => [
    -84.52 + east / M_PER_LNG,
    39.11 + north / M_PER_LAT,
  ];

  function messy() {
    useEditorStore.setState({
      streets: [],
      areas: [],
      nodes: [],
      junctionOverrides: {},
      past: [],
      future: [],
      autoConnect: false,
      drawSectionId: TEMPLATES[1]!.id,
    });
    const store = useEditorStore.getState();
    store.addStreet([at(-100, 0), at(100, 0)]);
    store.addStreet([at(-40, -80), at(-40, -6)]);
    store.addStreet([at(40, -80), at(40, 2)]);
  }

  it('joins the one end it was given, and leaves the others alone', () => {
    messy();
    const ids = useEditorStore.getState().streets.map((s) => s.id);
    const others = useEditorStore.getState().streets.filter((s) => s.id !== ids[1]);
    const before = others.map((s) => s.centerline);

    expect(useEditorStore.getState().connectEnd(ids[1]!, 'end')).toBe(true);

    const after = useEditorStore
      .getState()
      .streets.filter((s) => s.id !== ids[1])
      .map((s) => s.centerline);
    expect(after).toEqual(before);
  });

  it('says so, and adds no history, when that end already meets', () => {
    messy();
    const ids = useEditorStore.getState().streets.map((s) => s.id);
    // The start of this street is a dead end in open ground — nothing to meet.
    const past = useEditorStore.getState().past.length;
    expect(useEditorStore.getState().connectEnd(ids[1]!, 'start')).toBe(false);
    expect(useEditorStore.getState().past.length).toBe(past);
  });

  it('undoes as a single step', () => {
    messy();
    const ids = useEditorStore.getState().streets.map((s) => s.id);
    const before = useEditorStore.getState().streets;
    useEditorStore.getState().connectEnd(ids[1]!, 'end');
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().streets).toEqual(before);
  });
});

/**
 * Building an interchange, from the store's side.
 *
 * The geometry is covered in `geo/interchange.test.ts`. What only the store can answer is
 * whether the whole arrangement is one edit — four ramps and a grade profile arriving
 * together, and leaving together. A half-undone interchange is four orphan ramps around a
 * crossing that is back at grade, which is worse than either state.
 */
describe('building an interchange', () => {
  const M_PER_LAT = 111132;
  const M_PER_LNG = 111412 * Math.cos((39.11 * Math.PI) / 180);
  const at = (east: number, north: number): [number, number] => [
    -84.52 + east / M_PER_LNG,
    39.11 + north / M_PER_LAT,
  ];

  function freewayCrossing() {
    useEditorStore.setState({
      streets: [],
      areas: [],
      nodes: [],
      junctionOverrides: {},
      past: [],
      future: [],
      autoConnect: false,
      drawSectionId: TEMPLATES[1]!.id,
    });
    const store = useEditorStore.getState();
    const mainline = store.addStreet([at(-600, 0), at(600, 0)]);
    store.addStreet([at(0, -400), at(0, 400)]);
    return mainline;
  }

  /** The key of the one junction there is. */
  function onlyJunctionKey(): string {
    const { streets } = useEditorStore.getState();
    return detectJunctions(streets).junctions[0]!.key;
  }

  it('places the ramps and grades the mainline', () => {
    const mainline = freewayCrossing();
    const result = useEditorStore
      .getState()
      .buildInterchange(onlyJunctionKey(), { mainlineId: mainline, form: 'diamond' });

    expect(result?.ramps).toBe(4);
    const state = useEditorStore.getState();
    expect(state.streets).toHaveLength(6);
    expect(state.streets.find((s) => s.id === mainline)!.grade).toBeDefined();
  });

  it('is one edit, so one undo takes the whole thing back', () => {
    const mainline = freewayCrossing();
    const before = useEditorStore.getState().past.length;

    useEditorStore
      .getState()
      .buildInterchange(onlyJunctionKey(), { mainlineId: mainline, form: 'diamond' });
    expect(useEditorStore.getState().past.length).toBe(before + 1);

    useEditorStore.getState().undo();
    const after = useEditorStore.getState();
    expect(after.streets).toHaveLength(2);
    expect(after.streets.find((s) => s.id === mainline)!.grade).toBeUndefined();
  });

  it('gives the ramps a ramp cross-section, whatever the draw tool is set to', () => {
    // A ramp with a boulevard cross-section is not a ramp. The section comes from the
    // ramp template, not from whatever was last used for drawing.
    const mainline = freewayCrossing();
    useEditorStore.getState().setDrawSectionId(TEMPLATES[0]!.id);
    useEditorStore
      .getState()
      .buildInterchange(onlyJunctionKey(), { mainlineId: mainline, form: 'diamond' });

    const ramps = useEditorStore.getState().streets.filter((s) => s.name.includes('ramp'));
    expect(ramps).toHaveLength(4);
    for (const ramp of ramps) {
      expect(ramp.section.name).toBe('Ramp, single lane');
      // A rampLane, not a travelLane — the library models them as different things, and a
      // ramp carrying a plain travel lane would be a road that happens to be curved.
      const lanes = ramp.section.components.filter((c) => c.componentType === 'rampLane');
      expect(lanes).toHaveLength(1);
    }
  });

  it('leaves the mainline carrying a profile and no flat level', () => {
    // The two would contradict each other: the profile says the road climbs and comes back
    // down, a flat level says it is elevated for its whole length. Which won would depend
    // on which piece of code asked.
    const mainline = freewayCrossing();
    useEditorStore
      .getState()
      .buildInterchange(onlyJunctionKey(), { mainlineId: mainline, form: 'diamond' });

    const street = useEditorStore.getState().streets.find((s) => s.id === mainline)!;
    expect(street.grade).toBeDefined();
    expect(street.level).toBeUndefined();
  });

  it('has nothing to build on once the street is elevated end to end', () => {
    // Not a limitation so much as the point restated: a street marked elevated for its
    // whole length crosses nothing, so there is no junction to make an interchange of.
    // That is exactly the hole grade profiles were added to fill.
    const mainline = freewayCrossing();
    const key = onlyJunctionKey();
    useEditorStore.getState().setStreetLevel(mainline, 1);

    expect(
      useEditorStore.getState().buildInterchange(key, { mainlineId: mainline, form: 'diamond' }),
    ).toBeNull();
  });

  it('changes nothing when there is no room', () => {
    useEditorStore.setState({
      streets: [], areas: [], nodes: [], junctionOverrides: {},
      past: [], future: [], autoConnect: false, drawSectionId: TEMPLATES[1]!.id,
    });
    const store = useEditorStore.getState();
    const mainline = store.addStreet([at(-40, 0), at(40, 0)]);
    store.addStreet([at(0, -40), at(0, 40)]);

    const before = useEditorStore.getState().streets.length;
    const result = useEditorStore
      .getState()
      .buildInterchange(onlyJunctionKey(), { mainlineId: mainline, form: 'diamond' });

    expect(result).toBeNull();
    expect(useEditorStore.getState().streets).toHaveLength(before);
  });
});

/**
 * Sections you build and keep.
 *
 * The loop this closes: before it, composing a cross-section in the Asset Builder and
 * using it meant exporting a file and importing it back. A preset you have to export to
 * use is not in your library.
 */
describe('saving a cross-section to the library', () => {
  beforeEach(() => {
    useEditorStore.setState({ savedSections: [] });
    try {
      window.localStorage.clear();
    } catch {
      // No DOM in this environment, so nothing to clear. The store falls back to keeping
      // presets in memory, which is what these tests then exercise.
    }
  });

  it('keeps it under the name it was given', () => {
    const section = instantiateTemplate(TEMPLATES[3]!);
    useEditorStore.getState().saveSection('My high street', section);

    const saved = useEditorStore.getState().savedSections;
    expect(saved).toHaveLength(1);
    expect(saved[0]!.label).toBe('My high street');
    expect(saved[0]!.category).toBe('saved');
  });

  it('keeps the whole section, not a lossy summary of it', () => {
    // `specs` can only carry type, direction and width. A section somebody built can also
    // carry a pavement glyph and a stripe, and rebuilding from specs would drop both.
    const section = instantiateTemplate(TEMPLATES[3]!);
    const withMarkings = {
      ...section,
      components: section.components.map((c, i) =>
        i === 1 ? { ...c, glyph: 'arrowThrough' as const, stripeLeft: 'laneDashed' as const } : c,
      ),
    };
    useEditorStore.getState().saveSection('Marked up', withMarkings);

    const preset = useEditorStore.getState().savedSections[0]!;
    expect(preset.section).toBeDefined();
    expect(preset.section!.components[1]!.glyph).toBe('arrowThrough');
    expect(preset.section!.components[1]!.stripeLeft).toBe('laneDashed');
  });

  it('instantiates back into a section with fresh component ids', () => {
    // Two streets sharing a preset must not alias each other's bands — the same guarantee
    // the generated presets give.
    const section = instantiateTemplate(TEMPLATES[3]!);
    useEditorStore.getState().saveSection('Reusable', section);
    const preset = useEditorStore.getState().savedSections[0]!;

    const a = instantiateTemplate(preset);
    const b = instantiateTemplate(preset);
    expect(a.components[0]!.id).not.toBe(b.components[0]!.id);
    expect(a.components.map((c) => c.widthMeters)).toEqual(b.components.map((c) => c.widthMeters));
  });

  it('falls back to a name rather than saving an untitled blank', () => {
    useEditorStore.getState().saveSection('   ', instantiateTemplate(TEMPLATES[3]!));
    expect(useEditorStore.getState().savedSections[0]!.label).toBe('Untitled section');
  });

  it('renames and removes', () => {
    const id = useEditorStore.getState().saveSection('First', instantiateTemplate(TEMPLATES[3]!));
    useEditorStore.getState().renameSavedSection(id, 'Second');
    expect(useEditorStore.getState().savedSections[0]!.label).toBe('Second');

    useEditorStore.getState().removeSavedSection(id);
    expect(useEditorStore.getState().savedSections).toHaveLength(0);
  });

  it('is not part of the drawing, so undo does not touch it', () => {
    // A preset is a tool. Undoing a street should not take a section out of your library.
    useEditorStore.getState().saveSection('Kept', instantiateTemplate(TEMPLATES[3]!));
    const before = useEditorStore.getState().savedSections.length;

    useEditorStore.getState().addStreet(line);
    useEditorStore.getState().undo();

    expect(useEditorStore.getState().savedSections).toHaveLength(before);
  });

  it('still saves when the browser will not store anything', () => {
    // These tests run without a DOM, so there is no localStorage — which makes this the
    // exact condition a private window or a blocked-storage setting produces. Saving has
    // to keep working in memory: refusing to save at all because it cannot be remembered
    // is worse than remembering it only for this session.
    const hasStorage = (() => {
      try {
        return typeof window !== 'undefined' && !!window.localStorage;
      } catch {
        return false;
      }
    })();

    useEditorStore.getState().saveSection('Persisted', instantiateTemplate(TEMPLATES[3]!));
    expect(useEditorStore.getState().savedSections[0]!.label).toBe('Persisted');

    if (hasStorage) {
      const raw = window.localStorage.getItem('geostripe.savedSections.v1');
      expect(JSON.parse(raw!)[0].label).toBe('Persisted');
    }
  });
});

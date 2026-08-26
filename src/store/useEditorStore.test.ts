import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore, cloneSection } from './useEditorStore';
import { createDemoStreets } from '../demo/washingtonPark';
import { TEMPLATES, instantiateTemplate } from '../library/templates';

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

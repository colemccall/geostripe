import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TAPER_METRES,
  matchSections,
  sameSection,
  sectionAt,
  sectionSpans,
  withComponentAdded,
  withComponentRemoved,
} from './lanes';
import { deriveProject, resetDerivedCaches } from './derived';
import { componentsFromSpecs } from '../library/templates';
import { boundaryOffsets, totalWidth } from '../model/section';
import type { SectionChange } from './lanes';
import type { CrossSection, SectionComponent, Street } from '../model/types';

/**
 * A freeway that drops a lane into a ramp.
 *
 * Four lanes run up to an interchange, one peels off, three carry on. One road, one
 * alignment, three widths. The two things that have to be true for it to read as a road
 * rather than a step are tested hardest: the lanes that continue must not move sideways
 * when the count changes, and the lane that goes must close off over a length rather than
 * stop at a point.
 */

const O_LNG = -84.52;
const O_LAT = 39.11;
const M_PER_LAT = 111132;
const M_PER_LNG = 111412 * Math.cos((O_LAT * Math.PI) / 180);

function at(east: number, north: number): [number, number] {
  return [O_LNG + east / M_PER_LNG, O_LAT + north / M_PER_LAT];
}

/** A four-lane carriageway with shoulders, ids fixed so a derived section can match them. */
function mainline(): CrossSection {
  const components = componentsFromSpecs([
    ['shoulder', 'none', 3],
    ['freewayLane', 'forward', 3.65],
    ['freewayLane', 'forward', 3.65],
    ['freewayLane', 'forward', 3.65],
    ['freewayLane', 'forward', 3.65],
    ['shoulder', 'none', 3],
  ]);
  return { id: 'sec-main', name: 'Mainline', anchorOffsetMeters: null, components };
}

function street(section: CrossSection, changes?: SectionChange[]): Street {
  return {
    id: 'fw',
    name: 'Freeway',
    centerline: [at(-400, 0), at(400, 0)],
    visible: true,
    section,
    ...(changes ? { sectionChanges: changes } : {}),
  };
}

/** The same section with the outermost lane taken out. */
function droppedOuterLane(section: CrossSection): CrossSection {
  const lanes = section.components.filter((c) => c.componentType === 'freewayLane');
  return withComponentRemoved(section, lanes[lanes.length - 1]!.id);
}

beforeEach(() => resetDerivedCaches());

describe('reading the section at a station', () => {
  const base = mainline();
  const narrowed = droppedOuterLane(base);
  const changes: SectionChange[] = [
    { stationMeters: 400, section: narrowed, taperMeters: DEFAULT_TAPER_METRES },
  ];

  it('is the base section before the first change', () => {
    expect(sectionAt(base, changes, 100).components).toHaveLength(6);
  });

  it('is the new section after it', () => {
    expect(sectionAt(base, changes, 500).components).toHaveLength(5);
  });

  it('is the base section when nothing changes at all', () => {
    expect(sectionAt(base, undefined, 500)).toBe(base);
    expect(sectionAt(base, [], 500)).toBe(base);
  });
});

describe('cutting a street into stretches', () => {
  const base = mainline();
  const narrowed = droppedOuterLane(base);

  it('produces nothing for a street whose section never changes', () => {
    // The feature has to cost a plain street exactly nothing.
    expect(sectionSpans(base, undefined, 800)).toHaveLength(0);
    expect(sectionSpans(base, [], 800)).toHaveLength(0);
  });

  it('gives hold, taper, hold', () => {
    const spans = sectionSpans(
      base,
      [{ stationMeters: 400, section: narrowed, taperMeters: 40 }],
      800,
    );
    expect(spans).toHaveLength(3);
    expect(spans[0]!.transition).toBeUndefined();
    expect(spans[1]!.transition).toBeDefined();
    expect(spans[2]!.transition).toBeUndefined();
  });

  it('centres the taper on the station it was given', () => {
    const spans = sectionSpans(
      base,
      [{ stationMeters: 400, section: narrowed, taperMeters: 40 }],
      800,
    );
    const taper = spans.find((s) => s.transition)!;
    expect(taper.fromMeters).toBeCloseTo(380, 6);
    expect(taper.toMeters).toBeCloseTo(420, 6);
  });

  it('covers the whole street with no gaps', () => {
    const spans = sectionSpans(
      base,
      [{ stationMeters: 400, section: narrowed, taperMeters: 40 }],
      800,
    );
    expect(spans[0]!.fromMeters).toBe(0);
    expect(spans[spans.length - 1]!.toMeters).toBeCloseTo(800, 6);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.fromMeters).toBeCloseTo(spans[i - 1]!.toMeters, 6);
    }
  });

  it('keeps two changes close together from overlapping', () => {
    // Two lane drops sixty metres apart with forty-metre tapers each. The second cannot
    // start before the first has finished, or the ribbons would be drawn over each other.
    const once = droppedOuterLane(base);
    const twice = droppedOuterLane(once);
    const spans = sectionSpans(
      base,
      [
        { stationMeters: 400, section: once, taperMeters: 40 },
        { stationMeters: 440, section: twice, taperMeters: 40 },
      ],
      800,
    );
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.fromMeters).toBeGreaterThanOrEqual(spans[i - 1]!.toMeters - 1e-6);
    }
  });

  it('ignores a change beyond the end of the street', () => {
    expect(sectionSpans(base, [{ stationMeters: 9000, section: narrowed, taperMeters: 40 }], 800))
      .toHaveLength(0);
  });
});

describe('lining two sections up', () => {
  const base = mainline();

  it('pairs the components that continue by id', () => {
    const narrowed = droppedOuterLane(base);
    const slots = matchSections(base, narrowed);
    const kept = slots.filter((s) => s.toLeft !== s.toRight);
    expect(kept).toHaveLength(5);
  });

  it('closes the dropped lane to nothing', () => {
    const narrowed = droppedOuterLane(base);
    const slots = matchSections(base, narrowed);
    const going = slots.filter((s) => s.toLeft === s.toRight);
    expect(going).toHaveLength(1);
    expect(going[0]!.component.componentType).toBe('freewayLane');
    // It has width at the start and none at the end: it closes off rather than vanishing.
    expect(going[0]!.fromRight - going[0]!.fromLeft).toBeCloseTo(3.65, 6);
  });

  it('opens an added lane from nothing', () => {
    const lane: SectionComponent = {
      id: 'new-lane',
      componentType: 'freewayLane',
      widthMeters: 3.65,
      direction: 'forward',
    };
    const wider = withComponentAdded(base, lane, 5);
    const slots = matchSections(base, wider);
    const arriving = slots.filter((s) => s.fromLeft === s.fromRight);
    expect(arriving).toHaveLength(1);
    expect(arriving[0]!.component.id).toBe('new-lane');
    expect(arriving[0]!.toRight - arriving[0]!.toLeft).toBeCloseTo(3.65, 6);
  });

  it('leaves adjacent slots sharing a boundary at both ends', () => {
    // What keeps the taper free of slivers: one band's right edge is the next one's left.
    const narrowed = droppedOuterLane(base);
    const slots = matchSections(base, narrowed);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]!.fromLeft).toBeCloseTo(slots[i - 1]!.fromRight, 9);
      expect(slots[i]!.toLeft).toBeCloseTo(slots[i - 1]!.toRight, 9);
    }
  });
});

describe('keeping the lanes that continue where they were', () => {
  const base = mainline();

  /** Each component's left and right offset from the drawn line, keyed by id. */
  function spanById(section: CrossSection): Map<string, { left: number; right: number }> {
    const offsets = boundaryOffsets(section);
    return new Map(
      section.components.map((component, i) => [
        component.id,
        { left: offsets[i]!, right: offsets[i + 1]! },
      ]),
    );
  }

  it('does not move the rest of the road when a lane is dropped', () => {
    // The heart of it. Dropping a lane makes the section narrower, and an anchor that
    // resolves itself sits at the middle of the travelway — so every remaining lane would
    // slide half a lane sideways. On the ground nothing moves except the lane that went.
    const narrowed = droppedOuterLane(base);
    const before = boundaryOffsets(base);
    const after = boundaryOffsets(narrowed);

    // Every boundary up to the dropped lane is unchanged.
    for (let i = 0; i < after.length - 1; i++) {
      expect(after[i]!).toBeCloseTo(before[i]!, 9);
    }
  });

  it('does not move the rest of the road when a lane is added', () => {
    const lane: SectionComponent = {
      id: 'extra',
      componentType: 'freewayLane',
      widthMeters: 3.65,
      direction: 'forward',
    };
    // Added on the right, just inside the shoulder.
    const wider = withComponentAdded(base, lane, 5);
    const before = boundaryOffsets(base);
    const after = boundaryOffsets(wider);

    for (let i = 0; i <= 5; i++) {
      expect(after[i]!).toBeCloseTo(before[i]!, 9);
    }
    // And the road really did get wider rather than just shifting.
    expect(totalWidth(wider.components) - totalWidth(base.components)).toBeCloseTo(3.65, 9);
  });

  it('widens outward when a lane goes in on the left', () => {
    // Adding width on the left has to move something: what moves is the LEFT SHOULDER,
    // outward, exactly as a real widening does. What must not move is any lane that was
    // already there, and the far shoulder must not move either.
    const lane: SectionComponent = {
      id: 'left-extra',
      componentType: 'freewayLane',
      widthMeters: 3.65,
      direction: 'forward',
    };
    const wider = withComponentAdded(base, lane, 1);

    const before = spanById(base);
    const after = spanById(wider);

    for (const component of base.components) {
      const was = before.get(component.id)!;
      const now = after.get(component.id)!;
      if (component.id === base.components[0]!.id) {
        // The left shoulder: same width, pushed out by exactly the new lane.
        expect(now.right - now.left).toBeCloseTo(was.right - was.left, 9);
        expect(now.left).toBeCloseTo(was.left - 3.65, 9);
      } else {
        expect(now.left).toBeCloseTo(was.left, 9);
        expect(now.right).toBeCloseTo(was.right, 9);
      }
    }
  });
});

describe('what the map gets', () => {
  const base = mainline();
  const narrowed = droppedOuterLane(base);

  function withDrop(taper = 40): Street {
    return street(base, [{ stationMeters: 400, section: narrowed, taperMeters: taper }]);
  }

  it('bands a street with no changes exactly as before', () => {
    const plain = deriveProject([street(base)]);
    expect(plain.byStreet.get('fw')!.bands).toHaveLength(6);
  });

  it('bands the wide part, the taper and the narrow part', () => {
    const derived = deriveProject([withDrop()]);
    const bands = derived.byStreet.get('fw')!.bands;
    // Six before, six across the taper, five after.
    expect(bands.length).toBe(6 + 6 + 5);
  });

  it('gives every band real area', () => {
    // A ribbon built with its edges the wrong way round comes out as a bowtie, which reads
    // as a hole in the road rather than as an error.
    const derived = deriveProject([withDrop()]);
    for (const band of derived.byStreet.get('fw')!.bands) {
      const geometry = band.geometry as
        | { type: 'Polygon'; coordinates: number[][][] }
        | { type: 'MultiPolygon'; coordinates: number[][][][] };
      const rings =
        geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
      for (const ring of rings) {
        let twice = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          twice += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
        }
        expect(Math.abs(twice / 2)).toBeGreaterThan(0);
      }
    }
  });

  it('narrows the road across the taper rather than at a point', () => {
    const derived = deriveProject([withDrop()]);
    const bands = derived.byStreet.get('fw')!.bands;

    // The dropped lane appears once in the taper and never after it.
    const dropped = droppedOuterLane(base);
    const goneId = base.components.find(
      (c) => !dropped.components.some((d) => d.id === c.id),
    )!.id;

    const appearances = bands.filter((b) => b.properties?.componentId === goneId);
    // Once in the stretch before, once tapering. Not in the stretch after.
    expect(appearances).toHaveLength(2);
  });

  it('carries the section change through a grade profile too', () => {
    // The two vary along the same street independently, and both have to survive being
    // sliced by the other.
    const withBoth: Street = {
      ...withDrop(),
      // Flat at both ends, so there are genuine at-grade stretches as well as ramps —
      // a profile that starts climbing at station zero has no level-zero segment at all.
      grade: [
        { stationMeters: 0, level: 0 },
        { stationMeters: 150, level: 0 },
        { stationMeters: 250, level: 1 },
        { stationMeters: 550, level: 1 },
        { stationMeters: 650, level: 0 },
        { stationMeters: 800, level: 0 },
      ],
    };
    const derived = deriveProject([withBoth]);
    const bands = derived.byStreet.get('fw')!.bands;
    const levels = bands.map((b) => (b.properties as { level?: number }).level ?? 0);

    expect(bands.length).toBeGreaterThan(11);
    expect(Math.max(...levels)).toBeCloseTo(1, 6);
    expect(Math.min(...levels)).toBeCloseTo(0, 6);
  });
});

describe('telling one section from another', () => {
  it('calls a section the same as itself', () => {
    const base = mainline();
    expect(sameSection(base, base)).toBe(true);
  });

  it('spots a dropped lane', () => {
    const base = mainline();
    expect(sameSection(base, droppedOuterLane(base))).toBe(false);
  });
});

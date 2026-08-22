import { describe, expect, it } from 'vitest';
import type { ComponentType, Direction } from '../library/primitives';
import type { CrossSection, SectionComponent } from './types';
import {
  autoAnchorOffset,
  boundaryOffsets,
  checkFit,
  componentStarts,
  geometricCentreOffset,
  resolveAnchorOffset,
  sectionExtent,
  totalWidth,
  travelwayWidth,
} from './section';

/**
 * Cross-section arithmetic — the numbers the geometry engine will offset the centerline
 * by. Getting these wrong misplaces every band, so they are pinned here before any
 * geodesy is written on top of them.
 */

let counter = 0;
function comp(componentType: ComponentType, widthMeters: number, direction: Direction = 'none'): SectionComponent {
  return { id: `c${counter++}`, componentType, widthMeters, direction };
}

function section(components: SectionComponent[], anchorOffsetMeters: number | null = null): CrossSection {
  return { id: 's', name: 'test', components, anchorOffsetMeters };
}

/** Symmetric: sidewalk | lane | turn | lane | sidewalk */
const symmetric = () => [
  comp('sidewalk', 1.8),
  comp('travelLane', 3.0, 'backward'),
  comp('turnLane', 3.0, 'both'),
  comp('travelLane', 3.0, 'forward'),
  comp('sidewalk', 1.8),
];

/** Asymmetric: a wide commercial walk one side, a narrow one the other. */
const asymmetric = () => [
  comp('sidewalk', 3.7),
  comp('parkingLaneParallel', 2.4),
  comp('travelLane', 3.0, 'backward'),
  comp('travelLane', 3.0, 'forward'),
  comp('bikeLaneProtected', 2.7, 'forward'),
  comp('sidewalk', 1.5),
];

describe('widths', () => {
  it('totals every component', () => {
    expect(totalWidth(symmetric())).toBeCloseTo(12.6, 10);
    expect(totalWidth(asymmetric())).toBeCloseTo(16.3, 10);
  });

  it('measures the travelway as curb-to-curb, excluding sidewalks', () => {
    // 3.0 + 3.0 + 3.0 = 9.0, sidewalks excluded
    expect(travelwayWidth(symmetric())).toBeCloseTo(9.0, 10);
    // 2.4 + 3.0 + 3.0 + 2.7 = 11.1
    expect(travelwayWidth(asymmetric())).toBeCloseTo(11.1, 10);
  });

  it('counts a raised median as inside the travelway', () => {
    // A median sits between the kerbs, so it must not split the travelway span.
    const withMedian = [
      comp('sidewalk', 1.8),
      comp('travelLane', 3.0, 'backward'),
      comp('median', 2.0),
      comp('travelLane', 3.0, 'forward'),
      comp('sidewalk', 1.8),
    ];
    expect(travelwayWidth(withMedian)).toBeCloseTo(8.0, 10);
  });

  it('reports cumulative start offsets from the left edge', () => {
    expect(componentStarts(symmetric())).toEqual([0, 1.8, 4.8, 7.8, 10.8]);
  });
});

describe('anchor', () => {
  it('coincides with the geometric centre on a symmetric section', () => {
    const components = symmetric();
    expect(autoAnchorOffset(components)).toBeCloseTo(geometricCentreOffset(components), 10);
  });

  it('diverges from the geometric centre on an asymmetric section', () => {
    // This is the whole reason the anchor is stored rather than assumed. The travelway
    // runs 3.7 -> 14.8, so its midpoint is 9.25; the geometric centre is 8.15.
    const components = asymmetric();
    expect(autoAnchorOffset(components)).toBeCloseTo(9.25, 10);
    expect(geometricCentreOffset(components)).toBeCloseTo(8.15, 10);
    expect(autoAnchorOffset(components)).not.toBeCloseTo(geometricCentreOffset(components), 2);
  });

  it('honours an explicit offset over the derived one', () => {
    expect(resolveAnchorOffset(section(asymmetric(), 0))).toBe(0);
    expect(resolveAnchorOffset(section(asymmetric(), 4.2))).toBe(4.2);
    expect(resolveAnchorOffset(section(asymmetric(), null))).toBeCloseTo(9.25, 10);
  });

  it('falls back to the geometric centre when nothing is roadway', () => {
    const walksOnly = [comp('sidewalk', 2.0), comp('sidewalk', 4.0)];
    expect(autoAnchorOffset(walksOnly)).toBeCloseTo(3.0, 10);
  });
});

describe('boundary offsets', () => {
  it('produces one more boundary than components', () => {
    const s = section(symmetric());
    expect(boundaryOffsets(s)).toHaveLength(s.components.length + 1);
  });

  it('spans exactly the total width', () => {
    const s = section(asymmetric());
    const offsets = boundaryOffsets(s);
    const span = offsets[offsets.length - 1]! - offsets[0]!;
    expect(span).toBeCloseTo(totalWidth(s.components), 10);
  });

  it('is symmetric about zero for a symmetric section', () => {
    const offsets = boundaryOffsets(section(symmetric()));
    expect(offsets[0]).toBeCloseTo(-6.3, 10);
    expect(offsets[offsets.length - 1]).toBeCloseTo(6.3, 10);
  });

  it('shares each interior boundary between neighbouring components', () => {
    // Adjacent bands derive from the same offset value, which is what guarantees no
    // slivers or overlaps once these become polygons.
    const s = section(asymmetric());
    const offsets = boundaryOffsets(s);
    s.components.forEach((c, i) => {
      expect(offsets[i + 1]! - offsets[i]!).toBeCloseTo(c.widthMeters, 10);
    });
  });

  it('translates without changing widths when the anchor moves', () => {
    const components = asymmetric();
    const auto = boundaryOffsets(section(components, null));
    const shifted = boundaryOffsets(section(components, 0));
    const delta = shifted[0]! - auto[0]!;
    auto.forEach((v, i) => expect(shifted[i]! - v).toBeCloseTo(delta, 10));
  });

  it('reports how far the section reaches either side', () => {
    const extent = sectionExtent(section(symmetric()));
    expect(extent.left).toBeCloseTo(6.3, 10);
    expect(extent.right).toBeCloseTo(6.3, 10);
  });
});

describe('fit check', () => {
  it('fits when the design is narrower than the measured right-of-way', () => {
    const result = checkFit(symmetric(), 18.6);
    expect(result.fits).toBe(true);
    expect(result.differenceMeters).toBeCloseTo(-6.0, 10);
  });

  it('fails when the design is wider', () => {
    const result = checkFit(asymmetric(), 12.0);
    expect(result.fits).toBe(false);
    expect(result.differenceMeters).toBeCloseTo(4.3, 10);
  });

  it('treats an exact match as fitting despite float drift', () => {
    // Widths round-trip through feet at the input boundary, so exact equality is rare.
    const components = symmetric();
    const drifted = totalWidth(components) + 1e-12;
    expect(checkFit(components, drifted).fits).toBe(true);
  });
});

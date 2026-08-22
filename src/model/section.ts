import { PRIMITIVES } from '../library/primitives';
import type { CrossSection, SectionComponent } from './types';

/**
 * Cross-section arithmetic.
 *
 * Pure functions over a list of widths — no projection, no coordinates, no map. This is
 * *not* the geometry engine: it computes where each boundary sits along the section, and
 * the geometry engine will later offset the centerline by exactly these distances to
 * produce polygons. Keeping the two separate means the whole Asset Builder works, and is
 * testable, before any geodesy exists.
 */

export function totalWidth(components: readonly SectionComponent[]): number {
  return components.reduce((sum, c) => sum + c.widthMeters, 0);
}

/** Curb-to-curb width: the span from the first to the last roadway component. */
export function travelwayWidth(components: readonly SectionComponent[]): number {
  const span = travelwaySpan(components);
  return span ? span.end - span.start : 0;
}

/** Distance from the left edge of the section to the start of each component. */
export function componentStarts(components: readonly SectionComponent[]): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const c of components) {
    starts.push(cursor);
    cursor += c.widthMeters;
  }
  return starts;
}

/**
 * Extent of the curb-to-curb travelway, measured from the left edge of the section.
 * Returns null when the section contains no roadway components at all (a sidewalk-only
 * section, say) — callers fall back to the geometric centre.
 */
function travelwaySpan(
  components: readonly SectionComponent[],
): { start: number; end: number } | null {
  const starts = componentStarts(components);
  let first = -1;
  let last = -1;

  components.forEach((c, i) => {
    if (PRIMITIVES[c.componentType].isRoadway) {
      if (first < 0) first = i;
      last = i;
    }
  });

  if (first < 0) return null;
  // Non-null: indices came from iterating these same arrays.
  return {
    start: starts[first]!,
    end: starts[last]! + components[last]!.widthMeters,
  };
}

/**
 * Where the drawn centerline sits, as a distance from the left edge of the section.
 *
 * An explicit `anchorOffsetMeters` wins. Otherwise it derives to the midpoint of the
 * travelway — not the geometric centre of the whole section — because that is the line
 * a user can actually see on satellite imagery. The two coincide on a symmetric street
 * and diverge as soon as the section is asymmetric (a wide commercial sidewalk on one
 * side, parking on one side only), which is exactly when getting it wrong is visible.
 */
export function resolveAnchorOffset(section: CrossSection): number {
  if (section.anchorOffsetMeters !== null) return section.anchorOffsetMeters;
  return autoAnchorOffset(section.components);
}

export function autoAnchorOffset(components: readonly SectionComponent[]): number {
  const span = travelwaySpan(components);
  if (!span) return totalWidth(components) / 2;
  return (span.start + span.end) / 2;
}

export function geometricCentreOffset(components: readonly SectionComponent[]): number {
  return totalWidth(components) / 2;
}

/**
 * Signed offsets of every component boundary from the drawn centerline, left negative to
 * right positive. Length is components.length + 1.
 *
 * These are precisely the distances the geometry engine will offset the centerline by.
 * Adjacent components share a boundary value, which is what guarantees no slivers or
 * overlaps between neighbouring bands once they become polygons.
 */
export function boundaryOffsets(section: CrossSection): number[] {
  const anchor = resolveAnchorOffset(section);
  const offsets = [-anchor];
  let cursor = 0;
  for (const c of section.components) {
    cursor += c.widthMeters;
    offsets.push(cursor - anchor);
  }
  return offsets;
}

/** How far the section reaches either side of the centerline. */
export function sectionExtent(section: CrossSection): { left: number; right: number } {
  const offsets = boundaryOffsets(section);
  return {
    left: Math.abs(offsets[0] ?? 0),
    right: Math.abs(offsets[offsets.length - 1] ?? 0),
  };
}

export interface FitResult {
  designedMeters: number;
  availableMeters: number;
  /** Positive when the design exceeds the measured right-of-way. */
  differenceMeters: number;
  fits: boolean;
}

/**
 * The argument a street redesign has to win: does this fit in the width that already
 * exists? Cheap to compute, and the reason the geometry has to be honest.
 */
export function checkFit(
  components: readonly SectionComponent[],
  availableMeters: number,
): FitResult {
  const designedMeters = totalWidth(components);
  const differenceMeters = designedMeters - availableMeters;
  return {
    designedMeters,
    availableMeters,
    differenceMeters,
    // Tolerance absorbs float drift from repeated ft->m conversions at the input boundary.
    fits: differenceMeters <= 1e-6,
  };
}

import { dedupe, localPlane, originFor } from './projection';
import type { LngLat, PlanePoint } from './projection';
import { boundaryOffsets, resolveAnchorOffset, totalWidth } from '../model/section';
import { bandColor } from './banding';
import type { BandFeature, BandProperties } from './banding';
import { stationsAlong } from './grade';
import type { CrossSection, SectionComponent } from '../model/types';

/**
 * A street whose cross-section changes along its length.
 *
 * A `Street` carried exactly one `CrossSection` for its whole run, which is fine for a city
 * block and wrong for everything a freeway does. Four lanes run up to an interchange, one
 * peels off into a ramp, three carry on. That is one road with one alignment — but it was
 * inexpressible: the only way to draw it was to cut the highway into two streets that meet
 * end to end, which puts a fake junction between them, makes you drag two centrelines to
 * move one road, and loses the fact that the lanes on either side are the same lanes.
 *
 * So the section varies along the street, the same way the grade does. Stored as the
 * section in force at station zero plus the changes after it; resolved at derive time by
 * slicing the centreline and banding each piece.
 *
 * Two things make it read as a road rather than a step:
 *
 *   **The taper.** A lane does not appear or vanish at a point; it opens out or closes off
 *   over a length. Between two sections the bands are drawn as ribbons whose edges move
 *   from where they were to where they are going, so a dropped lane narrows to nothing and
 *   the shoulder slides across to meet it.
 *
 *   **The anchor.** Adding a lane makes the section wider, and if the drawn line stays at
 *   the middle of the travelway the whole road shifts sideways to accommodate it — every
 *   lane moves, which is not what happens on the ground. The change carries an explicit
 *   anchor so the lanes that continue stay exactly where they were and the new one appears
 *   beside them.
 */

export interface SectionChange {
  /** Distance along the resolved centerline at which the new section takes over. */
  stationMeters: number;
  /** The section in force from here until the next change. */
  section: CrossSection;
  /**
   * Length over which one section becomes the other, centred on the station.
   *
   * A lane drop on a freeway is 45 m or so by the books; a lane gain is longer. Stored
   * rather than assumed because it is a design decision with a number, which is the whole
   * ethos of the tool.
   */
  taperMeters: number;
}

/** Default taper for a lane opening or closing, in metres. */
export const DEFAULT_TAPER_METRES = 45;

export interface SectionSpan {
  fromMeters: number;
  toMeters: number;
  /** The section to band this stretch with. */
  section: CrossSection;
  /**
   * Set when the section is CHANGING across this stretch rather than holding.
   *
   * The presence of this is what sends the span to the ribbon builder instead of the
   * ordinary offsetter.
   */
  transition?: { from: CrossSection; to: CrossSection };
}

/** The section in force at a station. */
export function sectionAt(
  base: CrossSection,
  changes: readonly SectionChange[] | undefined,
  stationMeters: number,
): CrossSection {
  if (!changes || changes.length === 0) return base;

  let current = base;
  for (const change of [...changes].sort((a, b) => a.stationMeters - b.stationMeters)) {
    if (change.stationMeters > stationMeters) break;
    current = change.section;
  }
  return current;
}

/**
 * The street cut into stretches that can each be banded on their own.
 *
 * Returns an empty list when the section never changes, so a street that does not use the
 * feature pays nothing for it — the caller takes its existing single-section path.
 */
export function sectionSpans(
  base: CrossSection,
  changes: readonly SectionChange[] | undefined,
  lengthMeters: number,
): SectionSpan[] {
  if (!changes || changes.length === 0) return [];

  const ordered = [...changes]
    .filter((change) => change.stationMeters > 0 && change.stationMeters < lengthMeters)
    .sort((a, b) => a.stationMeters - b.stationMeters);
  if (ordered.length === 0) return [];

  const spans: SectionSpan[] = [];
  let cursor = 0;
  let held = base;

  for (const change of ordered) {
    const taper = Math.max(1, change.taperMeters);
    // Centred on the station, and clamped so two changes close together cannot produce
    // overlapping tapers — the second simply starts where the first finished.
    const start = Math.max(cursor, change.stationMeters - taper / 2);
    const end = Math.min(lengthMeters, Math.max(start + 1, change.stationMeters + taper / 2));

    if (start > cursor + 0.5) {
      spans.push({ fromMeters: cursor, toMeters: start, section: held });
    }
    spans.push({
      fromMeters: start,
      toMeters: end,
      section: change.section,
      transition: { from: held, to: change.section },
    });

    cursor = end;
    held = change.section;
  }

  if (lengthMeters - cursor > 0.5) {
    spans.push({ fromMeters: cursor, toMeters: lengthMeters, section: held });
  }

  return spans;
}

// ------------------------------------------------------------------------- matching

/**
 * One band's worth of the transition: where its two edges start and where they end.
 *
 * A component present in both sections keeps its width and merely moves. One that appears
 * has both edges collapsed onto a single line at the start, so it opens from nothing. One
 * that goes has both edges collapsed at the end, so it closes to nothing.
 */
export interface TransitionSlot {
  component: SectionComponent;
  fromLeft: number;
  fromRight: number;
  toLeft: number;
  toRight: number;
}

/**
 * Line up two sections component by component.
 *
 * Matched on component **id**, not on type or position. A section built by taking another
 * and adding a lane keeps every other component's id, so the ones that continue are known
 * to be the same ones and can be drawn moving rather than being destroyed and recreated.
 * Matching on type instead would pair the wrong lanes the moment there were two alike,
 * which on a freeway is always.
 *
 * The walk assumes one section was derived from the other by inserting and removing
 * components rather than reordering them — which is what the editing actions do. A
 * reordered pair still produces sane geometry, just a less flattering taper.
 */
export function matchSections(from: CrossSection, to: CrossSection): TransitionSlot[] {
  const fromOffsets = boundaryOffsets(from);
  const toOffsets = boundaryOffsets(to);

  const fromIndex = new Map(from.components.map((c, i) => [c.id, i]));
  const toIndex = new Map(to.components.map((c, i) => [c.id, i]));

  const slots: TransitionSlot[] = [];
  let i = 0;
  let j = 0;

  const collapsedFrom = (index: number): number => fromOffsets[index] ?? fromOffsets[fromOffsets.length - 1]!;
  const collapsedTo = (index: number): number => toOffsets[index] ?? toOffsets[toOffsets.length - 1]!;

  while (i < from.components.length || j < to.components.length) {
    const a = from.components[i];
    const b = to.components[j];

    if (a && b && a.id === b.id) {
      slots.push({
        component: b,
        fromLeft: fromOffsets[i]!,
        fromRight: fromOffsets[i + 1]!,
        toLeft: toOffsets[j]!,
        toRight: toOffsets[j + 1]!,
      });
      i += 1;
      j += 1;
      continue;
    }

    // Appears in `to` only: opens out from a line at the position it will occupy.
    if (b && !fromIndex.has(b.id)) {
      const seam = collapsedFrom(i);
      slots.push({
        component: b,
        fromLeft: seam,
        fromRight: seam,
        toLeft: toOffsets[j]!,
        toRight: toOffsets[j + 1]!,
      });
      j += 1;
      continue;
    }

    // Present in `from` only: closes off to a line where it used to be.
    if (a && !toIndex.has(a.id)) {
      const seam = collapsedTo(j);
      slots.push({
        component: a,
        fromLeft: fromOffsets[i]!,
        fromRight: fromOffsets[i + 1]!,
        toLeft: seam,
        toRight: seam,
      });
      i += 1;
      continue;
    }

    // Both sides know this component but they disagree on the order. Advance the one that
    // is further from its match so the walk cannot stall.
    if (a) i += 1;
    else j += 1;
  }

  return slots;
}

// -------------------------------------------------------------------------- geometry

/** Unit normals at each vertex, averaged across the corner so edges stay continuous. */
function vertexNormals(pts: readonly PlanePoint[]): PlanePoint[] {
  const normals: PlanePoint[] = [];

  for (let i = 0; i < pts.length; i++) {
    const before = pts[i - 1] ?? pts[i]!;
    const after = pts[i + 1] ?? pts[i]!;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.hypot(dx, dy) || 1;
    // Left of travel, matching the sign convention the banding engine uses.
    normals.push({ x: -dy / length, y: dx / length });
  }

  return normals;
}

/**
 * Bands for a stretch across which the section is changing.
 *
 * A ribbon per component rather than an offset polyline, because the offset is not constant:
 * each edge moves from where it was to where it is going, in step along the stretch. The
 * ordinary offsetter cannot do that — it takes one distance for the whole line, which is
 * exactly why a lane could not open or close before.
 *
 * Adjacent components share the coordinates of the boundary between them, the same
 * guarantee `bandsForStreet` gives, because both read it from the same lerp.
 */
export function bandsForTransition(
  streetId: string,
  centerline: readonly LngLat[],
  from: CrossSection,
  to: CrossSection,
  indexOffset = 0,
): BandFeature[] {
  const line = dedupe(centerline);
  if (line.length < 2) return [];

  const plane = localPlane(originFor(line));
  const pts = line.map((p) => plane.toPlane(p));
  const normals = vertexNormals(pts);
  const stations = stationsAlong(line);
  const total = stations[stations.length - 1]!;
  if (total <= 0) return [];

  const slots = matchSections(from, to);
  const bands: BandFeature[] = [];

  slots.forEach((slot, index) => {
    // A component that is absent at both ends is not part of this transition at all.
    if (slot.fromLeft === slot.fromRight && slot.toLeft === slot.toRight) return;

    const left: [number, number][] = [];
    const right: [number, number][] = [];

    for (let k = 0; k < pts.length; k++) {
      const t = stations[k]! / total;
      const p = pts[k]!;
      const n = normals[k]!;
      // Offsets are measured left-to-right across the section while the normal points
      // left, hence the negation — the same convention bandsForStreet uses.
      const l = slot.fromLeft + (slot.toLeft - slot.fromLeft) * t;
      const r = slot.fromRight + (slot.toRight - slot.fromRight) * t;
      left.push([p.x - n.x * l, p.y - n.y * l]);
      right.push([p.x - n.x * r, p.y - n.y * r]);
    }

    const ring = [...left, ...right.reverse(), left[0]!];
    const coords = ring.map((p) => plane.toLngLat({ x: p[0], y: p[1] }) as [number, number]);

    const properties: BandProperties = {
      featureClass: 'band',
      streetId,
      componentId: slot.component.id,
      componentIndex: indexOffset + index,
      componentType: slot.component.componentType,
      direction: slot.component.direction,
      widthMeters: slot.component.widthMeters,
      color: bandColor(slot.component.componentType, slot.component.colorOverride),
    };

    bands.push({
      type: 'Feature',
      id: `${streetId}:t${indexOffset + index}`,
      properties,
      geometry: { type: 'Polygon', coordinates: [coords] },
    });
  });

  return bands;
}

// --------------------------------------------------------------------------- editing

/**
 * A copy of `section` with one component added, anchored so nothing else moves.
 *
 * The anchor is the point of this. `anchorOffsetMeters` is measured from the section's left
 * edge to the drawn line, so a lane added on the right leaves it alone and every existing
 * lane stays put, while one added on the left pushes the left edge outward and the anchor
 * has to grow by the same amount to compensate. Left to resolve itself — an auto anchor
 * sits at the middle of the travelway — the whole road would slide sideways by half a lane
 * every time one was added, which is not what happens on the ground and makes the before
 * and after impossible to compare.
 */
export function withComponentAdded(
  section: CrossSection,
  component: SectionComponent,
  index: number,
): CrossSection {
  const at = Math.max(0, Math.min(index, section.components.length));
  const components = [...section.components];
  components.splice(at, 0, component);

  const anchor = resolveAnchorOffset(section);
  // Everything inserted to the left of the drawn line pushes the left edge further out.
  const addedLeft = at === 0 || offsetOfIndex(section, at) <= anchor ? component.widthMeters : 0;

  return {
    ...section,
    components,
    anchorOffsetMeters: anchor + addedLeft,
  };
}

/** A copy of `section` with one component removed, anchored so nothing else moves. */
export function withComponentRemoved(section: CrossSection, componentId: string): CrossSection {
  const index = section.components.findIndex((c) => c.id === componentId);
  if (index < 0) return section;

  const removed = section.components[index]!;
  const anchor = resolveAnchorOffset(section);
  const wasLeft = offsetOfIndex(section, index) < anchor;

  return {
    ...section,
    components: section.components.filter((c) => c.id !== componentId),
    anchorOffsetMeters: anchor - (wasLeft ? removed.widthMeters : 0),
  };
}

/** Distance from the section's left edge to the left edge of the component at `index`. */
function offsetOfIndex(section: CrossSection, index: number): number {
  let cursor = 0;
  for (let i = 0; i < index && i < section.components.length; i++) {
    cursor += section.components[i]!.widthMeters;
  }
  return cursor;
}

/** Whether two sections describe the same stack, so a change would be a no-op. */
export function sameSection(a: CrossSection, b: CrossSection): boolean {
  if (a.components.length !== b.components.length) return false;
  if (Math.abs(totalWidth(a.components) - totalWidth(b.components)) > 1e-9) return false;
  return a.components.every((component, i) => {
    const other = b.components[i]!;
    return (
      component.id === other.id &&
      component.componentType === other.componentType &&
      Math.abs(component.widthMeters - other.widthMeters) < 1e-9
    );
  });
}

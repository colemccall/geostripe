import type { ComponentType, Direction } from '../library/primitives';
import type { CurveSettings } from '../geo/curve';
import type { LandcoverType } from '../library/landcover';

/**
 * One band of a cross-section. `id` is runtime-only — it is regenerated on load and
 * never written to a file, so ids stay stable within a session without leaking into
 * the interchange format.
 */
export interface SectionComponent {
  id: string;
  componentType: ComponentType;
  widthMeters: number;
  direction: Direction;
  /**
   * Explicit user override only. Ordinary styling resolves from componentType at render
   * time, so changing a primitive's colour updates every existing design rather than
   * leaving saved files frozen at the old palette.
   */
  colorOverride?: string;
}

/**
 * A cross-section — what the Asset Builder produces and the Map Editor places.
 *
 * Deliberately geometry-agnostic: an ordered stack of widths with no centerline and no
 * coordinates. It becomes real geometry only when placed on a street, which is why this
 * whole page can be built before the geometry engine exists.
 */
export interface CrossSection {
  id: string;
  name: string;
  components: SectionComponent[];
  /**
   * Distance from the LEFT EDGE of the section to the drawn centerline.
   *
   * `null` means "derive it" — the midpoint of the travelway, so the line lands on the
   * centre of the curb-to-curb width, which is what you can actually see on imagery.
   * A number pins it explicitly, which is what re-anchoring writes. Storing one number
   * makes travelway-centre, geometric-centre and left-edge anchoring all representable.
   */
  anchorOffsetMeters: number | null;
}

/**
 * A street placed on the map: a drawn centerline plus the cross-section applied to it.
 *
 * The centerline is the parametric truth. Band polygons are derived from it on every
 * render and never stored here, so editing a width or dragging a vertex regenerates the
 * geometry rather than mutating it.
 */
export interface Street {
  id: string;
  name: string;
  /**
   * WGS84 [lng, lat] control points — the vertices you drag.
   *
   * NOT the line the geometry is built from when the street is curved. Everything that
   * needs real geometry goes through `resolveCenterline`, which tessellates these into a
   * dense polyline. Keeping the controls separate is what lets a curve stay editable.
   */
  centerline: [number, number][];
  /** How the control points are joined. Absent means a plain polyline. */
  curve?: CurveSettings;
  /**
   * Grade separation, the way OSM uses `layer`: 0 is at grade, +1 an overpass, -1 a
   * tunnel. Streets at different levels do not form junctions, which is the entire point —
   * a freeway crossing a street underneath it is not an intersection, and treating it as
   * one would carve a hole through both.
   */
  level?: number;
  section: CrossSection;
  /** Measured curb-to-curb of the real street, for the fit check. */
  existingWidthMeters?: number;
  visible: boolean;
}

/**
 * A land-cover polygon: everything a design places that is not a band along a street.
 *
 * Deliberately its own entity rather than a component type. A street's geometry is derived
 * from a centerline and a stack of widths; an area has neither, and forcing it through the
 * banding engine would mean inventing a centerline for a pond. It shares the curve
 * machinery, though — a park boundary curves for the same reasons a street does.
 */
export interface Area {
  id: string;
  name: string;
  landcover: LandcoverType;
  /**
   * Control points of a closed ring, WGS84, with the first point NOT repeated at the end.
   * Closing is a rendering concern; repeating it here would mean every edit had to keep
   * two copies of one vertex in step.
   */
  ring: [number, number][];
  curve?: CurveSettings;
  visible: boolean;
}

export function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

import type { ComponentType, Direction } from '../library/primitives';
import type { CurveSettings } from '../geo/curve';
import type { GradePoint } from '../geo/grade';
import type { GlyphId } from '../geo/glyphs';
import type { StripeStyle } from '../geo/markings';
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
  /**
   * Pavement symbol repeated along this band in plan view. Absent takes the type's
   * default (a bicycle in a bike lane, a diamond in a bus lane); `'none'` says the user
   * deliberately wants it bare, which is a different statement and has to be storable.
   */
  glyph?: GlyphId | 'none';
  glyphSpacingMeters?: number;
  /**
   * The longitudinal stripe on this component's LEFT edge, overriding the convention
   * derived from the two components either side of it.
   *
   * Named for the edge rather than for the pair, so a boundary can never end up carrying
   * two overrides that disagree.
   */
  stripeLeft?: StripeStyle;
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
   *
   * Applies to the whole street. For one that climbs, crosses and comes back down, use
   * `grade` instead; this is the flat case and the fallback when there is no profile.
   */
  level?: number;
  /**
   * Where the street leaves the ground and where it returns, along its own length.
   *
   * The thing a single `level` cannot say. An overpass is four breakpoints — ground, up,
   * up, ground — and the sloping stretches between them are its ramps. Absent means flat
   * at `level`.
   */
  grade?: GradePoint[];
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

/**
 * An intersection you placed, rather than one the geometry noticed.
 *
 * GeoStripe started by deriving every junction from where centerlines happen to cross, and
 * that is still what happens where you have not said otherwise — it means a design works
 * before you have thought about intersections at all. But a derived junction is not a
 * thing you own: you cannot select the crossing itself, cannot move it independently of
 * the streets, and cannot say "there is no junction here" about two roads that pass each
 * other on the flat.
 *
 * A node fixes all three. It is the authority wherever it sits: the junction is AT the
 * node, built from whichever streets pass within reach of it, keyed by the node's id — so
 * its corner radii and crossings survive anything that happens to the streets, including
 * being redrawn from scratch.
 *
 * Dragging one behaves the way it does in a road-building game, and for the same reason:
 * a street that ENDS near the node has its endpoint carried along, because that endpoint
 * and the node are the same place; a street that merely passes through lets the node slide
 * along it, because the node is a point on that street and moving it should not bend it.
 */
export interface JunctionNode {
  id: string;
  name?: string;
  /** WGS84. Authoritative: the junction is built here, not at the detected crossing. */
  position: [number, number];
  /**
   * How far the node reaches for streets, in metres. Absent derives it from the widest
   * section involved, which is right unless streets are stacked unusually close.
   */
  reachMeters?: number;
  /**
   * No junction here at all — the streets simply overlap.
   *
   * Not the same as deleting the node: deleting it hands the spot back to automatic
   * detection, which would put the junction straight back. This is how you say two roads
   * cross without meeting, which nothing else in the model can express.
   */
  disabled?: boolean;
}

export function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

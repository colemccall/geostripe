import type { ComponentType, Direction } from '../library/primitives';
import type { GlyphId } from '../geo/glyphs';
import type { StripeStyle } from '../geo/markings';

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
 * A cross-section: an ordered stack of widths, with no centerline and no coordinates.
 *
 * Kept as a type of its own even though a LineAsset now carries these fields directly,
 * because the section arithmetic in section.ts is written against it and is useful without
 * an asset — the asset editor works on a stack that is not yet placed anywhere.
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

export function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

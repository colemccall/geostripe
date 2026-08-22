import type { ComponentType, Direction } from '../library/primitives';

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

export function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

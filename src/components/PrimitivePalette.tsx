import { PRIMITIVE_ORDER, PRIMITIVES } from '../library/primitives';
import type { ComponentType } from '../library/primitives';
import { formatWidth } from '../lib/units';
import type { DisplayUnits } from '../lib/units';

/**
 * The lane library, as an add-a-band palette.
 *
 * Shared by both pages so the Map Editor's inspector and the Asset Builder cannot drift
 * apart — the same list, the same defaults, the same provenance in the tooltip.
 */
interface Props {
  units: DisplayUnits;
  disabled?: boolean;
  onAdd: (type: ComponentType) => void;
}

export default function PrimitivePalette({ units, disabled = false, onAdd }: Props) {
  return (
    <ul className="prims">
      {PRIMITIVE_ORDER.map((type) => {
        const spec = PRIMITIVES[type];
        return (
          <li key={type}>
            <button
              type="button"
              className="prim"
              disabled={disabled}
              title={spec.note}
              onClick={() => onAdd(type)}
            >
              <span className="swatch" style={{ background: spec.color }} />
              <span className="prim-name">{spec.label}</span>
              <span className="prim-width mono">{formatWidth(spec.defaultWidthMeters, units)}</span>
              <span className="prim-add" aria-hidden="true">
                +
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

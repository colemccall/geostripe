import { PRIMITIVES } from '../library/primitives';
import type { Direction } from '../library/primitives';
import type { SectionComponent } from '../model/types';
import { displayToMetres, formatWidth, stepFor } from '../lib/units';
import type { DisplayUnits } from '../lib/units';

/**
 * The editable component stack — one row per band, ordered left to right across the
 * street. Shared between the Asset Builder and (later) the Map Editor inspector, so it
 * takes callbacks rather than reaching into the store itself.
 */

const DIRECTION_LABEL: Record<Direction, string> = {
  forward: '→ forward',
  backward: '← backward',
  both: '↔ two-way',
  none: '—',
};

const DIRECTION_ORDER: readonly Direction[] = ['forward', 'backward', 'both', 'none'];

interface Props {
  components: readonly SectionComponent[];
  units: DisplayUnits;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onWidth: (id: string, metres: number) => void;
  onDirection: (id: string, direction: Direction) => void;
  onMove: (id: string, delta: number) => void;
  onRemove: (id: string) => void;
}

export default function ComponentStack({
  components,
  units,
  selectedId,
  onSelect,
  onWidth,
  onDirection,
  onMove,
  onRemove,
}: Props) {
  if (components.length === 0) {
    return <p className="empty-note">No components. Add one from the library on the left.</p>;
  }

  return (
    <ul className="stack">
      {components.map((c, i) => {
        const spec = PRIMITIVES[c.componentType];
        const selected = selectedId === c.id;

        return (
          <li
            key={c.id}
            className={`row${selected ? ' is-selected' : ''}`}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('input,button,select')) return;
              onSelect(c.id);
            }}
          >
            <div className="row-move">
              <button
                type="button"
                aria-label={`Move ${spec.label} left`}
                disabled={i === 0}
                onClick={() => onMove(c.id, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${spec.label} right`}
                disabled={i === components.length - 1}
                onClick={() => onMove(c.id, 1)}
              >
                ↓
              </button>
            </div>

            <span className="swatch" style={{ background: c.colorOverride ?? spec.color }} />

            <div className="row-name">
              <span>{spec.label}</span>
              <select
                className="row-dir"
                value={c.direction}
                aria-label={`${spec.label} direction`}
                onChange={(e) => onDirection(c.id, e.target.value as Direction)}
              >
                {DIRECTION_ORDER.map((d) => (
                  <option key={d} value={d}>
                    {DIRECTION_LABEL[d]}
                  </option>
                ))}
              </select>
            </div>

            <input
              className="row-width"
              type="number"
              min={0.1}
              step={stepFor(units)}
              value={formatWidth(c.widthMeters, units)}
              aria-label={`${spec.label} width in ${units}`}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isFinite(value) || value <= 0) return;
                onWidth(c.id, displayToMetres(value, units));
              }}
            />

            <button
              type="button"
              className="row-remove"
              aria-label={`Remove ${spec.label}`}
              title="Remove"
              onClick={() => onRemove(c.id)}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

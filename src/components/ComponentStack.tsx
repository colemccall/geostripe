import { DEFAULT_LANE_GLYPHS, PRIMITIVES } from '../library/primitives';
import type { Direction } from '../library/primitives';
import { GLYPHS, GLYPH_IDS } from '../geo/glyphs';
import { STRIPE_LABELS, STRIPE_STYLES, stripeBetween } from '../geo/markings';
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
  onDuplicate?: (id: string) => void;
  /** Markings for the selected band. Omitted where the caller has no use for them. */
  onMarkings?: (
    id: string,
    patch: Pick<Partial<SectionComponent>, 'glyph' | 'glyphSpacingMeters' | 'stripeLeft'>,
  ) => void;
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
  onDuplicate,
  onMarkings,
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
              title={`Typically ${spec.typicalRangeFeet[0]}–${spec.typicalRangeFeet[1]} ft as built. ${spec.note}`}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isFinite(value) || value <= 0) return;
                onWidth(c.id, displayToMetres(value, units));
              }}
            />

            <span className="row-tools">
              {onDuplicate && (
                <button
                  type="button"
                  className="row-remove"
                  aria-label={`Duplicate ${spec.label}`}
                  title="Duplicate"
                  onClick={() => onDuplicate(c.id)}
                >
                  ⧉
                </button>
              )}
              <button
                type="button"
                className="row-remove"
                aria-label={`Remove ${spec.label}`}
                title="Remove"
                onClick={() => onRemove(c.id)}
              >
                ×
              </button>
            </span>

            {selected && onMarkings && (
              <div className="row-markings">
                <label className="field">
                  <span className="label">Symbol</span>
                  <select
                    className="text-input"
                    value={c.glyph ?? ''}
                    onChange={(e) =>
                      onMarkings(c.id, {
                        glyph: e.target.value === '' ? undefined : (e.target.value as never),
                      })
                    }
                  >
                    {/* Three states, not two: inherit, deliberately bare, or a choice. */}
                    <option value="">
                      Default
                      {DEFAULT_LANE_GLYPHS[c.componentType]
                        ? ` — ${GLYPHS[DEFAULT_LANE_GLYPHS[c.componentType]!.glyph].label}`
                        : ' — none'}
                    </option>
                    <option value="none">No symbol</option>
                    {GLYPH_IDS.map((id) => (
                      <option key={id} value={id}>
                        {GLYPHS[id].label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span className="label">Every (m)</span>
                  <input
                    className="text-input mono"
                    type="number"
                    min={2}
                    max={400}
                    step={1}
                    placeholder={String(DEFAULT_LANE_GLYPHS[c.componentType]?.spacingMeters ?? 30)}
                    value={c.glyphSpacingMeters ?? ''}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      onMarkings(c.id, {
                        glyphSpacingMeters:
                          e.target.value === '' || !Number.isFinite(value) || value < 2
                            ? undefined
                            : value,
                      });
                    }}
                  />
                </label>

                {i > 0 && (
                  <label className="field">
                    <span className="label">Line on its left</span>
                    <select
                      className="text-input"
                      value={c.stripeLeft ?? ''}
                      onChange={(e) =>
                        onMarkings(c.id, {
                          stripeLeft:
                            e.target.value === ''
                              ? undefined
                              : (e.target.value as NonNullable<SectionComponent['stripeLeft']>),
                        })
                      }
                    >
                      <option value="">
                        Default — {STRIPE_LABELS[stripeBetween(components[i - 1]!, c).style]}
                      </option>
                      {STRIPE_STYLES.map((style) => (
                        <option key={style} value={style}>
                          {STRIPE_LABELS[style]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

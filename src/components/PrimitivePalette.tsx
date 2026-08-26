import { useMemo, useState } from 'react';
import { COMPONENT_CATEGORIES, PRIMITIVES, searchPrimitives } from '../library/primitives';
import type { ComponentCategory, ComponentType } from '../library/primitives';
import { formatWidth } from '../lib/units';
import type { DisplayUnits } from '../lib/units';

/**
 * The lane library, as an add-a-band palette.
 *
 * Shared by both pages so the Map Editor's inspector and the Asset Builder cannot drift
 * apart — the same list, the same defaults, the same provenance in the tooltip.
 *
 * Filtered and searchable because the list is over fifty long. Search covers the note as
 * well as the label, which means you can find something by what it is *for* — "refuge",
 * "freight", "stormwater" — rather than having to already know what it is called.
 */
interface Props {
  units: DisplayUnits;
  disabled?: boolean;
  onAdd: (type: ComponentType) => void;
}

export default function PrimitivePalette({ units, disabled = false, onAdd }: Props) {
  const [category, setCategory] = useState<ComponentCategory | 'all'>('all');
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const found = searchPrimitives(query);
    return category === 'all' ? found : found.filter((t) => PRIMITIVES[t].category === category);
  }, [query, category]);

  return (
    <>
      <input
        className="text-input"
        type="search"
        placeholder="Search lanes…"
        value={query}
        aria-label="Search lane types"
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="chip-filter" role="group" aria-label="Filter by category">
        <button type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>
          All
        </button>
        {COMPONENT_CATEGORIES.map((group) => (
          <button
            key={group.id}
            type="button"
            aria-pressed={category === group.id}
            onClick={() => setCategory(group.id)}
          >
            {group.label}
          </button>
        ))}
      </div>

      {matches.length === 0 ? (
        <p className="empty-note">Nothing matches that.</p>
      ) : (
        <ul className="prims">
          {matches.map((type) => {
            const spec = PRIMITIVES[type];
            return (
              <li key={type}>
                <button
                  type="button"
                  className="prim"
                  disabled={disabled}
                  title={`Typically ${spec.typicalRangeFeet[0]}–${spec.typicalRangeFeet[1]} ft. ${spec.note}`}
                  onClick={() => onAdd(type)}
                >
                  <span className="swatch" style={{ background: spec.color }} />
                  <span className="prim-name">{spec.label}</span>
                  <span className="prim-width mono">
                    {formatWidth(spec.defaultWidthMeters, units)}
                  </span>
                  <span className="prim-add" aria-hidden="true">
                    +
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

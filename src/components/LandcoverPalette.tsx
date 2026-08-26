import { useMemo, useState } from 'react';
import {
  LANDCOVERS,
  LANDCOVER_CATEGORIES,
  searchLandcover,
} from '../library/landcover';
import type { LandcoverCategory, LandcoverType } from '../library/landcover';

/**
 * The land cover picker: category filter plus free-text search.
 *
 * Built to scale rather than to fit today's list. Twenty-two entries would be fine as a
 * flat scroll, but the same pattern has to carry a library several hundred long, and a
 * palette that only works while the list is short is a palette that gets rewritten.
 */
interface Props {
  value: LandcoverType;
  onChange: (type: LandcoverType) => void;
  /** Compact drops the search box, for the toolbar. */
  variant?: 'full' | 'compact';
}

export default function LandcoverPalette({ value, onChange, variant = 'full' }: Props) {
  const [category, setCategory] = useState<LandcoverCategory | 'all'>('all');
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const found = searchLandcover(query);
    return category === 'all' ? found : found.filter((t) => LANDCOVERS[t].category === category);
  }, [query, category]);

  if (variant === 'compact') {
    return (
      <select
        className="select"
        value={value}
        aria-label="Land type"
        onChange={(e) => onChange(e.target.value as LandcoverType)}
      >
        {LANDCOVER_CATEGORIES.map((group) => (
          <optgroup key={group.id} label={group.label}>
            {searchLandcover('')
              .filter((t) => LANDCOVERS[t].category === group.id)
              .map((type) => (
                <option key={type} value={type}>
                  {LANDCOVERS[type].label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    );
  }

  return (
    <>
      <input
        className="text-input"
        type="search"
        placeholder="Search land types…"
        value={query}
        aria-label="Search land types"
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="chip-filter" role="group" aria-label="Filter by category">
        <button
          type="button"
          aria-pressed={category === 'all'}
          onClick={() => setCategory('all')}
        >
          All
        </button>
        {LANDCOVER_CATEGORIES.map((group) => (
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
        <p className="empty-note">Nothing matches “{query}”.</p>
      ) : (
        <ul className="prims">
          {matches.map((type) => {
            const spec = LANDCOVERS[type];
            return (
              <li key={type}>
                <button
                  type="button"
                  className={`prim${type === value ? ' is-selected' : ''}`}
                  title={spec.note}
                  onClick={() => onChange(type)}
                >
                  <span className="swatch" style={{ background: spec.color }} />
                  <span className="prim-name">{spec.label}</span>
                  <span className="prim-width">{spec.category}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

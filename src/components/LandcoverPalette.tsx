import { useMemo, useState } from 'react';
import {
  LANDCOVERS,
  LANDCOVER_CATEGORIES,
  LANDCOVER_TYPES,
  landcoverTree,
  searchLandcover,
} from '../library/landcover';
import type { LandcoverType } from '../library/landcover';
import LibraryTree from './LibraryTree';

/**
 * The land cover picker.
 *
 * Uses the same tree as the lane and preset libraries rather than its own arrangement.
 * Twenty-two entries would be fine as a flat scroll, but a browser that only works while
 * the list is short is a browser that gets rewritten, and three navigation patterns in one
 * app is two too many.
 */
interface Props {
  value: LandcoverType;
  onChange: (type: LandcoverType) => void;
  /** Compact drops the search box, for the toolbar. */
  variant?: 'full' | 'compact';
}

export default function LandcoverPalette({ value, onChange, variant = 'full' }: Props) {
  const [query, setQuery] = useState('');

  const tree = useMemo(() => landcoverTree(), []);
  const filtered = useMemo(
    () => (query.trim() ? landcoverTree(searchLandcover(query)) : tree),
    [query, tree],
  );

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
    <LibraryTree
      tree={tree}
      filtered={filtered}
      query={query}
      onQuery={setQuery}
      placeholder="Search land types…"
      totalLabel={`${LANDCOVER_TYPES.length} materials`}
      keyOf={(type) => type}
      renderItem={(type) => {
        const spec = LANDCOVERS[type];
        return (
          <button
            type="button"
            className={`prim${type === value ? ' is-selected' : ''}`}
            title={spec.note}
            onClick={() => onChange(type)}
          >
            <span className="swatch" style={{ background: spec.color }} />
            <span className="prim-name">{spec.label}</span>
            <span className="prim-add" aria-hidden="true">
              {type === value ? '✓' : ''}
            </span>
          </button>
        );
      }}
    />
  );
}

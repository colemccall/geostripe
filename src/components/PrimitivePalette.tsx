import { useMemo, useState } from 'react';
import { PRIMITIVES, primitiveTree, searchPrimitives } from '../library/primitives';
import type { ComponentType } from '../library/primitives';
import LibraryTree from './LibraryTree';
import { formatWidth } from '../lib/units';
import type { DisplayUnits } from '../lib/units';

/**
 * The lane library.
 *
 * Ninety-six primitives is past the point where a flat list works, so it is a tree:
 * category, then the group within it, then the lane. Search flattens the whole thing and
 * covers the note as well as the label, which means you can find something by what it is
 * *for* — "refuge", "freight", "stormwater" — rather than having to know its name.
 *
 * Recently used sits above the tree because the same three or four lanes come up over and
 * over while assembling one street, and making the user re-navigate to them each time is
 * the difference between a library and an obstacle.
 */

interface Props {
  units: DisplayUnits;
  disabled?: boolean;
  onAdd: (type: ComponentType) => void;
  /** Most recent first. The caller owns this so it survives switching pages. */
  recent?: readonly ComponentType[];
}

export default function PrimitivePalette({ units, disabled = false, onAdd, recent = [] }: Props) {
  const [query, setQuery] = useState('');

  const tree = useMemo(() => primitiveTree(), []);
  const filtered = useMemo(
    () => (query.trim() ? primitiveTree(searchPrimitives(query)) : tree),
    [query, tree],
  );

  const row = (type: ComponentType) => {
    const spec = PRIMITIVES[type];
    return (
      <button
        type="button"
        className="prim"
        disabled={disabled}
        title={`Typically ${spec.typicalRangeFeet[0]}–${spec.typicalRangeFeet[1]} ft. ${spec.note}`}
        onClick={() => onAdd(type)}
      >
        <span className="swatch" style={{ background: spec.color }} />
        <span className="prim-name">{spec.label}</span>
        <span className="prim-width mono">{formatWidth(spec.defaultWidthMeters, units)}</span>
        <span className="prim-add" aria-hidden="true">
          +
        </span>
      </button>
    );
  };

  return (
    <LibraryTree
      tree={tree}
      filtered={filtered}
      query={query}
      onQuery={setQuery}
      placeholder="Search lanes…"
      totalLabel={`${Object.keys(PRIMITIVES).length} lanes`}
      keyOf={(type) => type}
      renderItem={row}
      header={
        recent.length > 0 && !query.trim() ? (
          <div className="library-recent">
            <span className="label">Recent</span>
            <ul className="prims">
              {recent.slice(0, 6).map((type) => (
                <li key={type}>{row(type)}</li>
              ))}
            </ul>
          </div>
        ) : null
      }
    />
  );
}

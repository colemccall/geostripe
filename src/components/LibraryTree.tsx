import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The navigation shell the whole library shares.
 *
 * Categories collapse, groups inside them collapse, and search flattens the lot. That last
 * part is the reason this is one component rather than three: a tree and a search box are
 * two different ways of finding the same thing, and if they are built separately they
 * drift — the tree gains a group the search cannot reach, or search returns something the
 * tree has no home for.
 *
 * Two rules keep it navigable at 96 primitives and 157 presets:
 *
 *   Typing opens everything that matched and closes everything that did not. A search that
 *   leaves you looking at collapsed headers has told you nothing.
 *   Clearing the search restores what you had open, rather than dumping you at the top of
 *   a fully collapsed tree with no idea where you were.
 */

export interface TreeCategory<T> {
  category: string;
  label: string;
  groups: { label: string; items: T[] }[];
}

interface Props<T> {
  /** The full tree, unfiltered. */
  tree: TreeCategory<T>[];
  /** The same tree filtered to the current query — pass the full tree when there is none. */
  filtered: TreeCategory<T>[];
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  /** Stable key for one item, used for React keys and for the recents list. */
  keyOf: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** Rendered above the tree — recently used, favourites, whatever the caller has. */
  header?: React.ReactNode;
  /** Count shown beside the search box. */
  totalLabel: string;
}

export default function LibraryTree<T>({
  tree,
  filtered,
  query,
  onQuery,
  placeholder,
  keyOf,
  renderItem,
  header,
  totalLabel,
}: Props<T>) {
  const searching = query.trim().length > 0;

  const [openCategories, setOpenCategories] = useState<Set<string>>(
    () => new Set(tree[0] ? [tree[0].category] : []),
  );
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => new Set());

  // What was open before a search started, so clearing the box puts it back.
  const restore = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (searching) {
      if (restore.current === null) restore.current = openCategories;
    } else if (restore.current !== null) {
      setOpenCategories(restore.current);
      restore.current = null;
    }
    // openCategories is deliberately not a dependency: this reacts to the search starting
    // and stopping, and including it would overwrite the snapshot on every toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching]);

  const visible = searching ? filtered : tree;
  const matchCount = useMemo(
    () => filtered.reduce((n, c) => n + c.groups.reduce((m, g) => m + g.items.length, 0), 0),
    [filtered],
  );

  const isOpen = (category: string) => searching || openCategories.has(category);

  const toggleCategory = (category: string) => {
    setOpenCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const toggleGroup = (id: string) => {
    setClosedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="library">
      <div className="library-search">
        <input
          className="text-input"
          type="search"
          placeholder={placeholder}
          value={query}
          aria-label={placeholder}
          onChange={(e) => onQuery(e.target.value)}
        />
        <span className="library-count mono">{searching ? `${matchCount} found` : totalLabel}</span>
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setOpenCategories(new Set(tree.map((c) => c.category)))}
        >
          Expand all
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpenCategories(new Set())}>
          Collapse all
        </button>
      </div>

      {header}

      {visible.length === 0 ? (
        <p className="empty-note">Nothing matches that.</p>
      ) : (
        <ul className="tree">
          {visible.map((category) => {
            const open = isOpen(category.category);
            const count = category.groups.reduce((n, g) => n + g.items.length, 0);
            return (
              <li key={category.category} className="tree-category">
                <button
                  type="button"
                  className={`tree-head${open ? ' is-open' : ''}`}
                  aria-expanded={open}
                  onClick={() => toggleCategory(category.category)}
                >
                  <span className="tree-caret" aria-hidden="true">
                    {open ? '▾' : '▸'}
                  </span>
                  <span className="tree-label">{category.label}</span>
                  <span className="tree-count mono">{count}</span>
                </button>

                {open && (
                  <ul className="tree-groups">
                    {category.groups.map((group) => {
                      const id = `${category.category}/${group.label}`;
                      // A single group under a category is the category — drawing a header
                      // for it would be a level of nesting that carries no information.
                      const bare = category.groups.length === 1;
                      const groupOpen = bare || searching || !closedGroups.has(id);
                      return (
                        <li key={id} className="tree-group">
                          {!bare && (
                            <button
                              type="button"
                              className={`tree-subhead${groupOpen ? ' is-open' : ''}`}
                              aria-expanded={groupOpen}
                              onClick={() => toggleGroup(id)}
                            >
                              <span className="tree-caret" aria-hidden="true">
                                {groupOpen ? '▾' : '▸'}
                              </span>
                              <span className="tree-label">{group.label}</span>
                              <span className="tree-count mono">{group.items.length}</span>
                            </button>
                          )}
                          {groupOpen && (
                            <ul className="tree-items">
                              {group.items.map((item) => (
                                <li key={keyOf(item)}>{renderItem(item)}</li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

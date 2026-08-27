import { useMemo, useState } from 'react';
import { TEMPLATES, searchTemplates, templateTotalWidth, templateTree } from '../library/templates';
import type { TemplateDef } from '../library/templates';
import { PRIMITIVES } from '../library/primitives';
import LibraryTree from './LibraryTree';
import { useEditorStore } from '../store/useEditorStore';
import { formatWidth } from '../lib/units';
import type { DisplayUnits } from '../lib/units';

/**
 * The cross-section preset browser.
 *
 * Each card shows the section as a proportional colour strip rather than a name alone,
 * because that strip is what you actually recognise — nobody scans a hundred and fifty by
 * reading "2+2 + buffered bike both". The tree is category, then family: "Bike" opens into
 * Painted, Buffered, Protected and Raised, which is how someone comparing them thinks.
 *
 * Search covers the components a preset contains as well as its name, so "busway" finds the
 * one with a busway in it even though the word is not in its label.
 *
 * Sections saved from the Asset Builder appear here alongside the built-in presets, in a
 * category of their own that sorts first. That is the whole point of saving one: a preset
 * you have to export and re-import to use is not in your library, it is in your downloads.
 */

interface Props {
  units: DisplayUnits;
  disabled?: boolean;
  /** Highlights the current choice, when the picker selects rather than applies. */
  selectedId?: string | null;
  onPick: (template: TemplateDef) => void;
  recent?: readonly string[];
}

export default function TemplatePicker({
  units,
  disabled = false,
  selectedId,
  onPick,
  recent = [],
}: Props) {
  const [query, setQuery] = useState('');
  const saved = useEditorStore((s) => s.savedSections);

  const all = useMemo(() => [...saved, ...TEMPLATES], [saved]);
  const tree = useMemo(() => templateTree(all), [all]);
  const filtered = useMemo(
    () => (query.trim() ? templateTree(searchTemplates(query, all)) : tree),
    [query, tree, all],
  );

  const card = (template: TemplateDef) => (
    <button
      type="button"
      className={`card${template.id === selectedId ? ' is-active' : ''}`}
      disabled={disabled}
      onClick={() => onPick(template)}
    >
      <span className="card-title">{template.label}</span>
      <span className="chip-row" aria-hidden="true">
        {template.specs.map(([type, , width], i) => (
          <i
            key={i}
            style={{
              flexGrow: width ?? PRIMITIVES[type].defaultWidthMeters,
              background: PRIMITIVES[type].color,
            }}
          />
        ))}
      </span>
      <span className="card-meta">
        <span>{template.note}</span>
        <span className="mono">
          {formatWidth(templateTotalWidth(template), units, { withUnit: true })}
        </span>
      </span>
    </button>
  );

  const recentTemplates = recent
    .map((id) => all.find((t) => t.id === id))
    .filter((t): t is TemplateDef => Boolean(t));

  return (
    <LibraryTree
      tree={tree}
      filtered={filtered}
      query={query}
      onQuery={setQuery}
      placeholder="Search cross-sections…"
      totalLabel={
        saved.length > 0 ? `${TEMPLATES.length} presets · ${saved.length} yours` : `${TEMPLATES.length} presets`
      }
      keyOf={(template) => template.id}
      renderItem={card}
      header={
        recentTemplates.length > 0 && !query.trim() ? (
          <div className="library-recent">
            <span className="label">Recent</span>
            <ul className="cards">
              {recentTemplates.slice(0, 4).map((template) => (
                <li key={template.id}>{card(template)}</li>
              ))}
            </ul>
          </div>
        ) : null
      }
    />
  );
}

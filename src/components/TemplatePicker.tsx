import { useMemo, useState } from 'react';
import { TEMPLATE_CATEGORIES, searchTemplates, templateTotalWidth } from '../library/templates';
import type { TemplateCategory, TemplateDef } from '../library/templates';
import { PRIMITIVES } from '../library/primitives';
import { formatWidth } from '../lib/units';
import type { DisplayUnits } from '../lib/units';

/**
 * The cross-section preset picker.
 *
 * Each card shows the section as a proportional colour strip rather than a name alone,
 * because that strip is what you actually recognise — nobody scans a list of sixty by
 * reading "2+2 + buffered bike both". Search covers the components a template contains as
 * well as its name, so "busway" finds the one with a busway in it.
 */
interface Props {
  units: DisplayUnits;
  disabled?: boolean;
  /** Highlights the current choice, when the picker is used to select rather than apply. */
  selectedId?: string | null;
  onPick: (template: TemplateDef) => void;
}

export default function TemplatePicker({ units, disabled = false, selectedId, onPick }: Props) {
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const found = searchTemplates(query);
    return category === 'all' ? found : found.filter((t) => t.category === category);
  }, [query, category]);

  return (
    <>
      <input
        className="text-input"
        type="search"
        placeholder="Search cross-sections…"
        value={query}
        aria-label="Search cross-sections"
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="chip-filter" role="group" aria-label="Filter by category">
        <button type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>
          All
        </button>
        {TEMPLATE_CATEGORIES.map((group) => (
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
        <ul className="cards">
          {matches.map((template) => (
            <li key={template.id}>
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
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

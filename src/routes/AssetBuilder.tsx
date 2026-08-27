import { cloneSection, useEditorStore, anchorModeOf } from '../store/useEditorStore';
import type { AnchorMode } from '../store/useEditorStore';
import { downloadAsset, pickTextFile } from '../model/assetFile';
import { parseAssetFile } from '../model/schema';
import {
  autoAnchorOffset,
  resolveAnchorOffset,
  totalWidth,
  travelwayWidth,
} from '../model/section';
import { formatWidth } from '../lib/units';
import CrossSectionSvg from '../components/CrossSectionSvg';
import ComponentStack from '../components/ComponentStack';
import TemplatePicker from '../components/TemplatePicker';
import PrimitivePalette from '../components/PrimitivePalette';
import NoticeBar from '../components/NoticeBar';

/**
 * Route: "/builder" — the Asset Builder.
 *
 * Streetmix-style cross-section assembler. Notably this page needs *no geometry engine*:
 * an asset is a geometry-agnostic stack of widths with no centerline and no coordinates,
 * so composition, dimensioning, and the JSON round-trip are all pure arithmetic. It
 * becomes real geometry only when placed on a street in the Map Editor.
 */
export default function AssetBuilder() {
  const section = useEditorStore((s) => s.draftSection);
  const units = useEditorStore((s) => s.units);
  const recentComponentTypes = useEditorStore((s) => s.recentComponentTypes);
  const recentTemplateIds = useEditorStore((s) => s.recentTemplateIds);
  const selectedId = useEditorStore((s) => s.selectedComponentId);
  const notice = useEditorStore((s) => s.notice);
  const savedSections = useEditorStore((s) => s.savedSections);

  const {
    addComponent,
    removeComponent,
    setWidth,
    setDirection,
    setComponentMarkings,
    duplicateComponent,
    mirrorSection,
    moveComponent,
    selectComponent,
    renameSection,
    setAnchorMode,
    loadSection,
    applyTemplate,
    saveSection,
    removeSavedSection,
    setNotice,
  } = useEditorStore.getState();

  const total = totalWidth(section.components);
  const travelway = travelwayWidth(section.components);
  const anchor = resolveAnchorOffset(section);
  const anchorMode = anchorModeOf(section);

  async function handleUpload() {
    const text = await pickTextFile();
    if (text === null) return;

    const result = parseAssetFile(text);
    if (!result.ok) {
      setNotice({
        kind: 'error',
        title: "That file couldn't be loaded",
        details: result.errors,
      });
      return;
    }

    loadSection('draft', result.section);
    setNotice({
      kind: result.warnings.length ? 'warning' : 'success',
      title: `Loaded “${result.section.name}”`,
      details: result.warnings,
    });
  }

  function handleDownload() {
    downloadAsset(section);
    setNotice({ kind: 'success', title: `Downloaded “${section.name}”` });
  }

  return (
    <div className="workspace-grid">
      {/* ---------------------------------------------------------------- left rail */}
      <aside className="rail">
        <section className="panel">
          <header className="panel-head">
            <span className="label">Lane primitives</span>
          </header>
          <PrimitivePalette
                units={units}
                recent={recentComponentTypes}
                onAdd={(type) => addComponent('draft', type)}
              />
          <p className="hint">
            Defaults come from NACTO guidance and are starting values, never constraints.
          </p>
        </section>

        <section className="panel">
          <header className="panel-head">
            <span className="label">Start from a template</span>
          </header>
          <TemplatePicker
            recent={recentTemplateIds}
            units={units}
            onPick={(t) => applyTemplate('draft', t.id)}
          />
        </section>
      </aside>

      {/* -------------------------------------------------------------------- stage */}
      <main className="stage stage-pad">
        <NoticeBar notice={notice} onDismiss={() => setNotice(null)} />

        <div className="stage-body">
          <div className="asset-head">
            <h1>{section.name}</h1>
            <span className="tag mono">
              {section.components.length} components · {formatWidth(total, units, { withUnit: true })}
            </span>
          </div>

          <div className="section-canvas">
            <CrossSectionSvg
              section={section}
              units={units}
              variant="full"
              selectedId={selectedId}
              onSelect={selectComponent}
            />
          </div>

          <p className="asset-note">
            An asset is geometry-agnostic — a stack of components and widths with no
            centerline. Download it as a single <code>.json</code> and anyone can load it
            into their own palette. No account, no backend, no server.
          </p>
        </div>

        <footer className="statusbar">
          {[
            ['Components', String(section.components.length)],
            ['Total width', formatWidth(total, units, { withUnit: true })],
            ['Travelway', formatWidth(travelway, units, { withUnit: true })],
            ['Anchor', `${formatWidth(anchor, units, { withUnit: true })} from left`],
            ['Schema', 'v1 · geometry-agnostic'],
          ].map(([k, v]) => (
            <div className="cell" key={k}>
              <span className="label">{k}</span>
              <b className="mono">{v}</b>
            </div>
          ))}
        </footer>
      </main>

      {/* --------------------------------------------------------------- right rail */}
      <aside className="rail rail-right">
        <section className="panel">
          <header className="panel-head">
            <span className="label">Asset</span>
          </header>
          <label className="field">
            <span className="label">Name</span>
            <input
              className="text-input"
              value={section.name}
              onChange={(e) => renameSection('draft', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="label">Anchor</span>
            <select
              className="text-input"
              value={anchorMode}
              onChange={(e) => setAnchorMode('draft', e.target.value as AnchorMode)}
            >
              <option value="travelway">
                Travelway centre — {formatWidth(autoAnchorOffset(section.components), units, { withUnit: true })} from left
              </option>
              <option value="geometric">Geometric centre of section</option>
              <option value="leftEdge">Left edge of section</option>
              {anchorMode === 'custom' && <option value="custom">Custom offset</option>}
            </select>
            <span className="hint">
              Where the drawn centerline lands. Travelway centre puts it on the line you
              can actually see on imagery.
            </span>
          </label>
        </section>

        <section className="panel">
          <header className="panel-head">
            <span className="label">Stack · left → right</span>
            <span className="label mono">{formatWidth(total, units, { withUnit: true })}</span>
          </header>
          <ComponentStack
            components={section.components}
            units={units}
            selectedId={selectedId}
            onSelect={selectComponent}
            onWidth={(id, m) => setWidth('draft', id, m)}
            onDirection={(id, d) => setDirection('draft', id, d)}
            onMove={(id, delta) => moveComponent('draft', id, delta)}
            onRemove={(id) => removeComponent('draft', id)}
            onDuplicate={(id) => duplicateComponent('draft', id)}
            onMarkings={(id, patch) => setComponentMarkings('draft', id, patch)}
          />
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={() => mirrorSection('draft')}>
              Mirror the section
            </button>
          </div>
        </section>

        {/* ------------------------------------------------------------ library */}
        <section className="panel">
          <header className="panel-head">
            <span className="label">Your library</span>
            {savedSections.length > 0 && (
              <span className="label mono">{savedSections.length} saved</span>
            )}
          </header>

          <button
            type="button"
            className="btn btn-solid btn-block"
            onClick={() => {
              saveSection(section.name, section);
              setNotice({
                kind: 'success',
                title: `“${section.name}” is in your library`,
                details: [
                  'It is in the cross-section picker now, under Yours — no export and re-import.',
                ],
              });
            }}
          >
            Save to library
          </button>
          <p className="hint">
            Kept in this browser rather than in the project, because a preset is a tool and
            not part of any one drawing. Streets carry their own bands into the file
            regardless, so sharing a project never loses geometry.
          </p>

          {savedSections.length > 0 && (
            <ul className="cards" style={{ marginTop: 9 }}>
              {savedSections.map((preset) => (
                <li key={preset.id}>
                  <div className="street-card">
                    <button
                      type="button"
                      className="card street-card-main"
                      title="Load this back into the builder"
                      onClick={() => {
                        if (preset.section) loadSection('draft', cloneSection(preset.section));
                      }}
                    >
                      <span className="card-title">{preset.label}</span>
                      <span className="card-meta">
                        <span>{preset.note}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn is-danger"
                      title="Remove it from your library"
                      aria-label={`Remove ${preset.label}`}
                      onClick={() => removeSavedSection(preset.id)}
                    >
                      🗑
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <header className="panel-head">
            <span className="label">Share</span>
          </header>
          <button type="button" className="btn btn-solid btn-block" onClick={handleDownload}>
            Download asset JSON
          </button>
          <button type="button" className="btn btn-ghost btn-block" onClick={handleUpload}>
            Upload asset JSON…
          </button>
          <p className="hint">No account needed — the file is the sharing mechanism.</p>
        </section>
      </aside>
    </div>
  );
}

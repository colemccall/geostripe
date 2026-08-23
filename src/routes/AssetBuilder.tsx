import { PRIMITIVE_ORDER, PRIMITIVES } from '../library/primitives';
import { TEMPLATES, templateTotalWidth } from '../library/templates';
import { useEditorStore, anchorModeOf } from '../store/useEditorStore';
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
  const selectedId = useEditorStore((s) => s.selectedComponentId);
  const notice = useEditorStore((s) => s.notice);

  const {
    addComponent,
    removeComponent,
    setWidth,
    setDirection,
    moveComponent,
    selectComponent,
    renameSection,
    setAnchorMode,
    loadSection,
    applyTemplate,
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
          <ul className="prims">
            {PRIMITIVE_ORDER.map((type) => {
              const spec = PRIMITIVES[type];
              return (
                <li key={type}>
                  <button type="button" className="prim" onClick={() => addComponent('draft', type)}>
                    <span className="swatch" style={{ background: spec.color }} />
                    <span className="prim-name">{spec.label}</span>
                    <span className="prim-width mono">{formatWidth(spec.defaultWidthMeters, units)}</span>
                    <span className="prim-add" aria-hidden="true">
                      +
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="hint">
            Defaults come from NACTO guidance and are starting values, never constraints.
          </p>
        </section>

        <section className="panel">
          <header className="panel-head">
            <span className="label">Start from a template</span>
          </header>
          <ul className="cards">
            {TEMPLATES.map((t) => (
              <li key={t.id}>
                <button type="button" className="card" onClick={() => applyTemplate('draft', t.id)}>
                  <span className="card-title">{t.label}</span>
                  <span className="chip-row" aria-hidden="true">
                    {t.specs.map(([type, , w], i) => (
                      <i
                        key={i}
                        style={{
                          flexGrow: w ?? PRIMITIVES[type].defaultWidthMeters,
                          background: PRIMITIVES[type].color,
                        }}
                      />
                    ))}
                  </span>
                  <span className="card-meta">
                    <span>{t.note}</span>
                    <span className="mono">
                      {formatWidth(templateTotalWidth(t), units, { withUnit: true })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
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
          />
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

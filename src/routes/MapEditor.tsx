import { useState } from 'react';
import { PRIMITIVES } from '../library/primitives';
import { TEMPLATES, templateTotalWidth } from '../library/templates';
import { useEditorStore } from '../store/useEditorStore';
import { checkFit, resolveAnchorOffset, totalWidth } from '../model/section';
import { displayToMetres, formatWidth, stepFor } from '../lib/units';
import { basemapById } from '../map/basemaps';
import MapCanvas from '../map/MapCanvas';
import type { MapView } from '../map/MapCanvas';
import CrossSectionSvg from '../components/CrossSectionSvg';
import ComponentStack from '../components/ComponentStack';
import NoticeBar from '../components/NoticeBar';

/**
 * Route: "/" — the Map Editor.
 *
 * Satellite imagery is live; the design layer is not drawn yet. Rendering a cross-section
 * onto a traced centerline needs the geometry engine (local metric projection, polyline
 * offsetting, banding), which is the next phase and the real technical risk. Everything
 * around it — imagery, template selection, the editable stack, the fit check — is real
 * and operates on the same state the map layer will consume.
 */
export default function MapEditor() {
  const section = useEditorStore((s) => s.section);
  const units = useEditorStore((s) => s.units);
  const selectedId = useEditorStore((s) => s.selectedComponentId);
  const basemapId = useEditorStore((s) => s.basemapId);
  const customTileUrl = useEditorStore((s) => s.customTileUrl);
  const measuredRow = useEditorStore((s) => s.measuredRowMeters);
  const notice = useEditorStore((s) => s.notice);

  const {
    select,
    setWidth,
    setDirection,
    moveComponent,
    removeComponent,
    loadTemplate,
    setMeasuredRow,
    setNotice,
  } = useEditorStore.getState();

  const [view, setView] = useState<MapView | null>(null);
  const [showImagery, setShowImagery] = useState(true);

  const total = totalWidth(section.components);
  const fit = checkFit(section.components, measuredRow);
  const basemap = basemapById(basemapId);

  return (
    <div className="workspace-grid">
      {/* ---------------------------------------------------------------- left rail */}
      <aside className="rail">
        <section className="panel">
          <header className="panel-head">
            <span className="label">Cross-section templates</span>
          </header>
          <ul className="cards">
            {TEMPLATES.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className={`card${section.name === t.label ? ' is-active' : ''}`}
                  onClick={() => loadTemplate(t.id)}
                >
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
      <main className="stage">
        <NoticeBar notice={notice} onDismiss={() => setNotice(null)} />

        <div className="map-wrap">
          <MapCanvas
            basemapId={basemapId}
            customTileUrl={customTileUrl}
            units={units}
            showImagery={showImagery}
            onViewChange={setView}
          />

          <div className="map-overlay-tl">
            <button
              type="button"
              className="btn btn-pill"
              aria-pressed={!showImagery}
              onClick={() => setShowImagery((v) => !v)}
            >
              {showImagery ? 'Hide imagery' : 'Show imagery'}
            </button>
          </div>

          <div className="map-overlay-bl">
            <div className="pill pill-note">
              <strong>Design layer arrives with the geometry engine.</strong>
              <span>
                Drawing a centerline and rendering bands onto it needs local metric
                projection and polyline offsetting — the next phase.
              </span>
            </div>
          </div>
        </div>

        <footer className="statusbar">
          {[
            ['Cursor', view ? `${view.lat.toFixed(5)}, ${view.lng.toFixed(5)}` : '—'],
            ['Zoom', view ? `z${view.zoom.toFixed(1)}` : '—'],
            ['Imagery', basemap.label],
            ['Section', `${section.components.length} bands · ${formatWidth(total, units, { withUnit: true })}`],
            ['Anchor', `${formatWidth(resolveAnchorOffset(section), units, { withUnit: true })} from left`],
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
            <span className="label">Fit check</span>
            <span className="label">vs measured right-of-way</span>
          </header>

          <div className="fit">
            <div className="fit-top">
              <span
                className="fit-value mono"
                style={{ color: fit.fits ? 'var(--good)' : 'var(--bad)' }}
              >
                {formatWidth(total, units, { withUnit: true })}
              </span>
              <span
                className="fit-verdict"
                style={{ color: fit.fits ? 'var(--good)' : 'var(--bad)' }}
              >
                {fit.fits
                  ? `Fits · ${formatWidth(Math.abs(fit.differenceMeters), units, { withUnit: true })} spare`
                  : `Over by ${formatWidth(Math.abs(fit.differenceMeters), units, { withUnit: true })}`}
              </span>
            </div>
            <div className="fit-track">
              <div
                className="fit-bar"
                style={{
                  width: `${Math.min((total / Math.max(measuredRow, 0.01)) * 100, 100)}%`,
                  background: fit.fits ? 'var(--good-fill)' : 'var(--bad-fill)',
                }}
              />
            </div>
            <div className="fit-caption">
              <span>designed</span>
              <span className="mono">
                available {formatWidth(measuredRow, units, { withUnit: true })}
              </span>
            </div>
          </div>

          <label className="field">
            <span className="label">Measured right-of-way ({units})</span>
            <input
              className="text-input mono"
              type="number"
              min={1}
              step={stepFor(units)}
              value={formatWidth(measuredRow, units)}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v) || v <= 0) return;
                setMeasuredRow(displayToMetres(v, units));
              }}
            />
            <span className="hint">
              Measure the real street curb-to-curb, then check the redesign against it.
              A measure tool lands with the geometry engine.
            </span>
          </label>
        </section>

        <section className="panel">
          <header className="panel-head">
            <span className="label">Components · left → right</span>
            <span className="label mono">{section.components.length}</span>
          </header>
          <ComponentStack
            components={section.components}
            units={units}
            selectedId={selectedId}
            onSelect={select}
            onWidth={setWidth}
            onDirection={setDirection}
            onMove={moveComponent}
            onRemove={removeComponent}
          />
        </section>

        <section className="panel">
          <header className="panel-head">
            <span className="label">Cross-section</span>
          </header>
          <div className="section-preview">
            <CrossSectionSvg
              section={section}
              units={units}
              variant="compact"
              selectedId={selectedId}
              onSelect={select}
            />
          </div>
        </section>
      </aside>
    </div>
  );
}

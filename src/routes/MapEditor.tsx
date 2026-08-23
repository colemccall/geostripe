import { useCallback, useMemo, useRef, useState } from 'react';
import { useEditorStore, selectedStreet, anchorModeOf } from '../store/useEditorStore';
import type { AnchorMode } from '../store/useEditorStore';
import { checkFit, resolveAnchorOffset, totalWidth } from '../model/section';
import { displayToMetres, formatWidth, stepFor } from '../lib/units';
import { PRIMITIVES } from '../library/primitives';
import { TEMPLATES, templateTotalWidth } from '../library/templates';
import { basemapById } from '../map/basemaps';
import MapCanvas from '../map/MapCanvas';
import type { MapView } from '../map/MapCanvas';
import type { DesignData } from '../map/designLayers';
import { describeWarnings } from '../geo/curvature';
import { DEMO_CENTER, DEMO_ZOOM } from '../demo/washingtonPark';
import CrossSectionSvg from '../components/CrossSectionSvg';
import ComponentStack from '../components/ComponentStack';
import NoticeBar from '../components/NoticeBar';

/**
 * Route: "/" — the Map Editor.
 *
 * Streets render as real measured polygons over the imagery. The swipe divider shows the
 * design against the untouched street, which is the comparison the whole tool exists to
 * make: does this fit in the width that is already there?
 */
export default function MapEditor() {
  const streets = useEditorStore((s) => s.streets);
  const units = useEditorStore((s) => s.units);
  const selectedComponentId = useEditorStore((s) => s.selectedComponentId);
  const selectedStreetId = useEditorStore((s) => s.selectedStreetId);
  const basemapId = useEditorStore((s) => s.basemapId);
  const customTileUrl = useEditorStore((s) => s.customTileUrl);
  const waybackRelease = useEditorStore((s) => s.waybackRelease);
  const arcgisApiKey = useEditorStore((s) => s.arcgisApiKey);
  const swipe = useEditorStore((s) => s.swipe);
  const notice = useEditorStore((s) => s.notice);
  const street = useEditorStore(selectedStreet);

  const {
    selectStreet,
    selectComponent,
    setWidth,
    setDirection,
    moveComponent,
    removeComponent,
    applyTemplate,
    setAnchorMode,
    setExistingWidth,
    setSwipe,
    setNotice,
    clearStreets,
    loadDemo,
  } = useEditorStore.getState();

  const [view, setView] = useState<MapView | null>(null);
  const [warnings, setWarnings] = useState<DesignData['warnings']>([]);
  const [renderStats, setRenderStats] = useState<{
    bands: number;
    drawn: boolean;
    rendered: number;
    sourceLoaded: string;
    layerCount: number;
  } | null>(null);
  const mapWrapRef = useRef<HTMLDivElement | null>(null);

  // Memoised so MapCanvas's basemap effect does not see a new object every render.
  const sourceOptions = useMemo(
    () => ({ customUrl: customTileUrl, waybackRelease, arcgisApiKey }),
    [customTileUrl, waybackRelease, arcgisApiKey],
  );

  const section = street?.section;
  const total = section ? totalWidth(section.components) : 0;
  const available = street?.existingWidthMeters ?? 0;
  const fit = section ? checkFit(section.components, available || total) : null;
  const basemap = basemapById(basemapId);

  const startSwipeDrag = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const wrap = mapWrapRef.current;
      if (!wrap) return;

      const move = (e: PointerEvent) => {
        const rect = wrap.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        setSwipe(Math.min(0.98, Math.max(0.02, ratio)));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [setSwipe],
  );

  return (
    <div className="workspace-grid">
      {/* ---------------------------------------------------------------- left rail */}
      <aside className="rail">
        <section className="panel">
          <header className="panel-head">
            <span className="label">Streets</span>
            <span className="label mono">{streets.length}</span>
          </header>
          {streets.length === 0 ? (
            <p className="empty-note">
              No streets. Load the Washington Park example to see what the tool makes.
            </p>
          ) : (
            <ul className="cards">
              {streets.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`card${s.id === selectedStreetId ? ' is-active' : ''}`}
                    onClick={() => selectStreet(s.id)}
                  >
                    <span className="card-title">{s.name}</span>
                    <span className="chip-row" aria-hidden="true">
                      {s.section.components.map((c) => (
                        <i
                          key={c.id}
                          style={{
                            flexGrow: c.widthMeters,
                            background: c.colorOverride ?? PRIMITIVES[c.componentType].color,
                          }}
                        />
                      ))}
                    </span>
                    <span className="card-meta">
                      <span>{s.section.components.length} bands</span>
                      <span className="mono">
                        {formatWidth(totalWidth(s.section.components), units, { withUnit: true })}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={loadDemo}>
              Reload example
            </button>
            <button type="button" className="btn btn-ghost" onClick={clearStreets}>
              Clear
            </button>
          </div>
        </section>

        <section className="panel">
          <header className="panel-head">
            <span className="label">Apply a template</span>
          </header>
          <ul className="cards">
            {TEMPLATES.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="card"
                  disabled={!street}
                  onClick={() => applyTemplate('street', t.id)}
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

        <div className="map-wrap" ref={mapWrapRef}>
          <MapCanvas
            basemapId={basemapId}
            sourceOptions={sourceOptions}
            units={units}
            streets={streets}
            selectedStreetId={selectedStreetId}
            swipe={swipe}
            center={DEMO_CENTER}
            zoom={DEMO_ZOOM}
            onViewChange={setView}
            onSelectStreet={selectStreet}
            onWarnings={setWarnings}
            onRenderStats={setRenderStats}
          />

          {swipe !== null && (
            <div
              className="swipe-divider"
              style={{ left: `${swipe * 100}%` }}
              onPointerDown={startSwipeDrag}
              role="separator"
              aria-label="Before and after divider"
              aria-valuenow={Math.round(swipe * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') setSwipe(Math.max(0.02, swipe - 0.02));
                if (e.key === 'ArrowRight') setSwipe(Math.min(0.98, swipe + 0.02));
              }}
            >
              <span className="swipe-handle" aria-hidden="true">
                ⇄
              </span>
              <span className="swipe-tag swipe-tag-left">existing</span>
              <span className="swipe-tag swipe-tag-right">redesign</span>
            </div>
          )}

          <div className="map-overlay-tl">
            <button
              type="button"
              className="btn btn-pill"
              aria-pressed={swipe !== null}
              onClick={() => setSwipe(swipe === null ? 0.5 : null)}
            >
              {swipe === null ? 'Compare with existing' : 'Show full design'}
            </button>
          </div>

          {warnings.length > 0 && (
            <div className="map-overlay-tr">
              <div className="pill pill-warn">
                <strong>Tight bend</strong>
                <span>{describeWarnings(warnings[0]!.warnings)}</span>
              </div>
            </div>
          )}
        </div>

        <footer className="statusbar">
          {[
            ['Cursor', view ? `${view.lat.toFixed(5)}, ${view.lng.toFixed(5)}` : '—'],
            ['Zoom', view ? `z${view.zoom.toFixed(1)}` : '—'],
            ['Imagery', basemap.label],
            ['Street', street?.name ?? '—'],
            [
              'Section',
              section
                ? `${section.components.length} bands · ${formatWidth(total, units, { withUnit: true })}`
                : '—',
            ],
            [
              'Rendered',
              // Reports the difference between "no geometry" and "geometry that never
              // reached the GPU" — otherwise both look like an empty map.
              renderStats
                ? renderStats.rendered > 0
                  ? `${renderStats.bands} bands`
                  : `${renderStats.bands} bands · not drawn (source loaded: ${renderStats.sourceLoaded})`
                : '—',
            ],
            ['Geometry', 'local plane · ±0.5%'],
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
        {!street || !section ? (
          <section className="panel">
            <p className="empty-note">Select a street to edit its cross-section.</p>
          </section>
        ) : (
          <>
            <section className="panel">
              <header className="panel-head">
                <span className="label">Fit check</span>
                <span className="label">vs measured right-of-way</span>
              </header>

              {fit && (
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
                        width: `${Math.min((total / Math.max(available || total, 0.01)) * 100, 100)}%`,
                        background: fit.fits ? 'var(--good-fill)' : 'var(--bad-fill)',
                      }}
                    />
                  </div>
                  <div className="fit-caption">
                    <span>designed</span>
                    <span className="mono">
                      available {formatWidth(available || total, units, { withUnit: true })}
                    </span>
                  </div>
                </div>
              )}

              <label className="field" style={{ marginTop: 11 }}>
                <span className="label">Measured right-of-way ({units})</span>
                <input
                  className="text-input mono"
                  type="number"
                  min={1}
                  step={stepFor(units)}
                  value={formatWidth(available, units)}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0) return;
                    setExistingWidth(street.id, displayToMetres(v, units));
                  }}
                />
                <span className="hint">
                  Curb-to-curb of the real street. The redesign is honest only if this is.
                </span>
              </label>
            </section>

            <section className="panel">
              <header className="panel-head">
                <span className="label">Anchor</span>
              </header>
              <select
                className="text-input"
                value={anchorModeOf(section)}
                onChange={(e) => setAnchorMode('street', e.target.value as AnchorMode)}
              >
                <option value="travelway">
                  Travelway centre — {formatWidth(resolveAnchorOffset(section), units, { withUnit: true })} from left
                </option>
                <option value="geometric">Geometric centre of section</option>
                <option value="leftEdge">Left edge of section</option>
                {anchorModeOf(section) === 'custom' && <option value="custom">Custom offset</option>}
              </select>
            </section>

            <section className="panel">
              <header className="panel-head">
                <span className="label">Components · left → right</span>
                <span className="label mono">{section.components.length}</span>
              </header>
              <ComponentStack
                components={section.components}
                units={units}
                selectedId={selectedComponentId}
                onSelect={selectComponent}
                onWidth={(id, m) => setWidth('street', id, m)}
                onDirection={(id, d) => setDirection('street', id, d)}
                onMove={(id, delta) => moveComponent('street', id, delta)}
                onRemove={(id) => removeComponent('street', id)}
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
                  selectedId={selectedComponentId}
                  onSelect={selectComponent}
                />
              </div>
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

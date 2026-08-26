import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useEditorStore,
  selectedStreet,
  anchorModeOf,
  DRAFT_SECTION,
} from '../store/useEditorStore';
import type { AnchorMode, Tool } from '../store/useEditorStore';
import { checkFit, resolveAnchorOffset, totalWidth } from '../model/section';
import { displayToMetres, formatWidth, stepFor } from '../lib/units';
import { EDITOR_VERSION } from '../lib/version';
import { PRIMITIVES } from '../library/primitives';
import { TEMPLATES, instantiateTemplate, templateTotalWidth } from '../library/templates';
import { basemapById } from '../map/basemaps';
import MapCanvas from '../map/MapCanvas';
import type { MapHandle, MapView } from '../map/MapCanvas';
import type { DesignData, JunctionSummary } from '../map/designLayers';
import { describeWarnings } from '../geo/curvature';
import { lineLengthMeters } from '../geo/measure';
import { DEFAULT_CURVE, resolveCenterline, tightestRadius } from '../geo/curve';
import type { CurveMode } from '../geo/curve';
import { downloadText, pickTextFile } from '../model/assetFile';
import { parseProject, projectFilename, serializeProject } from '../model/project';
import { DEMO_CENTER, DEMO_ZOOM } from '../demo/washingtonPark';
import CrossSectionSvg from '../components/CrossSectionSvg';
import ComponentStack from '../components/ComponentStack';
import PrimitivePalette from '../components/PrimitivePalette';
import JunctionInspector from '../components/JunctionInspector';
import NoticeBar from '../components/NoticeBar';

/**
 * Route: "/" — the Map Editor.
 *
 * Streets render as real measured polygons over the imagery. The swipe divider shows the
 * design against the untouched street, which is the comparison the whole tool exists to
 * make: does this fit in the width that is already there?
 *
 * The map is modal — select, draw, measure — and this component owns the mode while
 * MapCanvas owns the pointer mechanics. Gestures that span many frames (dragging a
 * vertex) go through the store's live setters bracketed by beginGesture/endGesture, so a
 * drag lands in history as one step rather than two hundred.
 */

const CURVE_MODES: { id: CurveMode; label: string; hint: string }[] = [
  { id: 'straight', label: 'Straight', hint: 'Plain polyline — every control point is a hard corner.' },
  {
    id: 'rounded',
    label: 'Rounded',
    hint: 'Tangent-arc-tangent, the way a road alignment is specified: straight runs joined by arcs of a stated radius.',
  },
  {
    id: 'smooth',
    label: 'Smooth',
    hint: 'A spline through every control point. Best for tracing a street that genuinely curves, where you do not know the radius.',
  },
];

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  {
    id: 'select',
    label: 'Select',
    key: 'V',
    hint: 'Click a band to select it. Drag a vertex to reshape, alt-click one to remove it, drag a hollow handle to add one.',
  },
  {
    id: 'draw',
    label: 'Draw street',
    key: 'D',
    hint: 'Click along the centerline. Enter or double-click finishes it, Backspace removes the last point, Esc cancels.',
  },
  {
    id: 'measure',
    label: 'Measure',
    key: 'M',
    hint: 'Click two points to measure the real street — usually kerb to kerb.',
  },
];

export default function MapEditor() {
  const streets = useEditorStore((s) => s.streets);
  const units = useEditorStore((s) => s.units);
  const projectName = useEditorStore((s) => s.projectName);
  const selectedComponentId = useEditorStore((s) => s.selectedComponentId);
  const selectedStreetId = useEditorStore((s) => s.selectedStreetId);
  const basemapId = useEditorStore((s) => s.basemapId);
  const customTileUrl = useEditorStore((s) => s.customTileUrl);
  const waybackRelease = useEditorStore((s) => s.waybackRelease);
  const arcgisApiKey = useEditorStore((s) => s.arcgisApiKey);
  const swipe = useEditorStore((s) => s.swipe);
  const notice = useEditorStore((s) => s.notice);
  const tool = useEditorStore((s) => s.tool);
  const drawSectionId = useEditorStore((s) => s.drawSectionId);
  const selectedJunctionKey = useEditorStore((s) => s.selectedJunctionKey);
  const junctionOverrides = useEditorStore((s) => s.junctionOverrides);
  const defaultCornerRadiusMeters = useEditorStore((s) => s.defaultCornerRadiusMeters);
  const trimAtJunctions = useEditorStore((s) => s.trimAtJunctions);
  const draftSection = useEditorStore((s) => s.draftSection);
  const street = useEditorStore(selectedStreet);

  const {
    selectStreet,
    selectComponent,
    addComponent,
    setWidth,
    setDirection,
    moveComponent,
    removeComponent,
    applyTemplate,
    fitSectionToWidth,
    setAnchorMode,
    setExistingWidth,
    setSwipe,
    setNotice,
    setProjectName,
    setTool,
    setDrawSectionId,
    addStreet,
    renameStreet,
    toggleStreetVisible,
    duplicateStreet,
    removeStreet,
    loadStreets,
    clearStreets,
    loadDemo,
    selectJunction,
    updateCorner,
    updateLeg,
    resetJunction,
    setTrimAtJunctions,
    beginGesture,
    endGesture,
    moveVertexLive,
    insertVertexLive,
    removeVertex,
    setCurve,
    toggleSharpVertex,
  } = useEditorStore.getState();

  const [view, setView] = useState<MapView | null>(null);
  const [warnings, setWarnings] = useState<DesignData['warnings']>([]);
  const [draft, setDraft] = useState<{ points: number; metres: number }>({
    points: 0,
    metres: 0,
  });
  const [measure, setMeasure] = useState<{ points: number; metres: number } | null>(null);
  const [junctions, setJunctions] = useState<JunctionSummary[]>([]);
  const [renderStats, setRenderStats] = useState<{
    bands: number;
    drawn: boolean;
    rendered: number;
    sourceLoaded: string;
    layerCount: number;
  } | null>(null);
  const mapWrapRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapHandle | null>(null);

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
  const activeTool = TOOLS.find((t) => t.id === tool) ?? TOOLS[0]!;
  const curveMode = street?.curve?.mode ?? 'straight';
  const sharpCount = street?.curve?.sharpVertices?.length ?? 0;
  const actualRadius = street ? tightestRadius(resolveCenterline(street)) : Infinity;
  const selectedJunction = junctions.find((j) => j.key === selectedJunctionKey) ?? null;
  const streetNames = useMemo(
    () => Object.fromEntries(streets.map((s) => [s.id, s.name])),
    [streets],
  );

  /** The section a newly drawn street gets — also the fallback for a bare line import. */
  const drawingSection = useMemo(() => {
    const template = TEMPLATES.find((t) => t.id === drawSectionId);
    return template ? instantiateTemplate(template) : draftSection;
  }, [drawSectionId, draftSection]);

  // Single-key tool shortcuts, the way every map editor does it. Skipped while typing,
  // and while a modifier is held so they never shadow Ctrl+Z or a browser shortcut.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const match = TOOLS.find((t) => t.key.toLowerCase() === event.key.toLowerCase());
      if (!match) return;
      event.preventDefault();
      setTool(match.id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTool]);

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

  // -------------------------------------------------------------------- project file

  function handleSave() {
    if (streets.length === 0) {
      setNotice({
        kind: 'warning',
        title: 'Nothing to save yet',
        details: ['Draw a street first.'],
      });
      return;
    }
    downloadText(
      projectFilename(projectName),
      serializeProject(
        streets,
        { name: projectName, editorVersion: EDITOR_VERSION },
        junctionOverrides,
      ),
      'application/geo+json',
    );
    setNotice({
      kind: 'success',
      title: `Saved ${streets.length} street${streets.length === 1 ? '' : 's'}`,
      details: [
        'Centerlines carry their cross-section; the band polygons travel with them for QGIS.',
      ],
    });
  }

  async function handleOpen() {
    const text = await pickTextFile('application/geo+json,application/json,.geojson,.json');
    if (text === null) return;

    const result = parseProject(text, {
      sectionName: drawingSection.name,
      components: drawingSection.components.map((c) => ({
        componentType: c.componentType,
        widthMeters: c.widthMeters,
        direction: c.direction,
      })),
    });

    if (!result.ok) {
      setNotice({ kind: 'error', title: 'That file could not be loaded', details: result.errors });
      return;
    }

    loadStreets(result.streets, result.junctionOverrides);
    mapRef.current?.zoomTo(result.streets[0]?.centerline ?? []);
    setNotice({
      kind: result.warnings.length ? 'warning' : 'success',
      title: `Loaded ${result.streets.length} street${result.streets.length === 1 ? '' : 's'}`,
      details: result.warnings,
    });
  }

  // ------------------------------------------------------------------------ rendering

  return (
    <div className="workspace-grid">
      {/* ---------------------------------------------------------------- left rail */}
      <aside className="rail">
        <section className="panel">
          <header className="panel-head">
            <span className="label">Project</span>
          </header>
          <input
            className="text-input"
            value={projectName}
            aria-label="Project name"
            onChange={(e) => setProjectName(e.target.value)}
          />
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-solid" onClick={handleSave}>
              Save .geojson
            </button>
            <button type="button" className="btn btn-ghost" onClick={handleOpen}>
              Open…
            </button>
          </div>
          <p className="hint">
            Plain GeoJSON — editable by hand, openable in QGIS, and still fully parametric
            when you load it back.
          </p>
        </section>

        <section className="panel">
          <header className="panel-head">
            <span className="label">Streets</span>
            <span className="label mono">{streets.length}</span>
          </header>

          {streets.length === 0 ? (
            <p className="empty-note">
              No streets yet. Choose <b>Draw street</b> above the map and click along a
              centerline, or load the Washington Park example.
            </p>
          ) : (
            <ul className="cards">
              {streets.map((s) => (
                <li key={s.id}>
                  <div className={`street-card${s.id === selectedStreetId ? ' is-active' : ''}`}>
                    <button
                      type="button"
                      className="card street-card-main"
                      onClick={() => selectStreet(s.id)}
                      onDoubleClick={() => mapRef.current?.zoomTo(s.centerline)}
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
                        <span>
                          {s.section.components.length} bands ·{' '}
                          {formatWidth(lineLengthMeters(resolveCenterline(s)), units, {
                            decimals: 0,
                            withUnit: true,
                          })}{' '}
                          long
                        </span>
                        <span className="mono">
                          {formatWidth(totalWidth(s.section.components), units, {
                            withUnit: true,
                          })}
                        </span>
                      </span>
                    </button>

                    <div className="street-card-tools">
                      <button
                        type="button"
                        className="icon-btn"
                        title={s.visible ? 'Hide' : 'Show'}
                        aria-label={s.visible ? `Hide ${s.name}` : `Show ${s.name}`}
                        onClick={() => toggleStreetVisible(s.id)}
                      >
                        {s.visible ? '◉' : '○'}
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Zoom to"
                        aria-label={`Zoom to ${s.name}`}
                        onClick={() => mapRef.current?.zoomTo(s.centerline)}
                      >
                        ⤢
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Duplicate"
                        aria-label={`Duplicate ${s.name}`}
                        onClick={() => duplicateStreet(s.id)}
                      >
                        ⧉
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Delete"
                        aria-label={`Delete ${s.name}`}
                        onClick={() => removeStreet(s.id)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={loadDemo}>
              Load example
            </button>
            <button type="button" className="btn btn-ghost" onClick={clearStreets}>
              Clear all
            </button>
          </div>
        </section>

        <section className="panel">
          <header className="panel-head">
            <span className="label">Intersections</span>
            <span className="label mono">{junctions.length}</span>
          </header>
          {junctions.length === 0 ? (
            <p className="empty-note">
              None yet. Draw two streets that cross and the intersection appears on its own.
            </p>
          ) : (
            <ul className="cards">
              {junctions.map((j) => (
                <li key={j.key}>
                  <button
                    type="button"
                    className={`card${j.key === selectedJunctionKey ? ' is-active' : ''}`}
                    onClick={() => selectJunction(j.key)}
                    onDoubleClick={() => mapRef.current?.zoomTo([j.position])}
                  >
                    <span className="card-title">
                      {j.legs
                        .map((leg) => streetNames[leg.streetId] ?? 'Street')
                        .filter((name, i, all) => all.indexOf(name) === i)
                        .join(' × ')}
                    </span>
                    <span className="card-meta">
                      <span>
                        {j.legCount} legs · {j.kind}
                      </span>
                      <span className="mono">
                        {formatWidth(
                          Math.max(...j.legs.map((l) => l.crossingDistanceMeters)),
                          units,
                          { withUnit: true },
                        )}{' '}
                        max crossing
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={trimAtJunctions}
              onChange={(e) => setTrimAtJunctions(e.target.checked)}
            />
            <span>Trim streets at intersections</span>
          </label>
        </section>

        <section className="panel">
          <header className="panel-head">
            <span className="label">Apply a template</span>
            <span className="label">to the selected street</span>
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

        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Map tool">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tool === t.id}
                title={`${t.hint} (${t.key})`}
                onClick={() => setTool(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tool === 'draw' && (
            <>
              <label className="control">
                <span className="label">Section</span>
                <select
                  className="select"
                  value={drawSectionId}
                  onChange={(e) => setDrawSectionId(e.target.value)}
                >
                  {TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                  <option value={DRAFT_SECTION}>Asset builder — {draftSection.name}</option>
                </select>
              </label>
              <span className="pill pill-note mono">
                {draft.points} pt ·{' '}
                {formatWidth(draft.metres, units, { decimals: 0, withUnit: true })}
              </span>
              <button
                type="button"
                className="btn btn-solid"
                disabled={draft.points < 2}
                onClick={() => mapRef.current?.finishDraw()}
              >
                Finish
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={draft.points === 0}
                onClick={() => mapRef.current?.undoDraftPoint()}
              >
                Undo point
              </button>
            </>
          )}

          {tool === 'measure' && (
            <>
              <span className="pill pill-note mono">
                {measure && measure.points >= 2
                  ? formatWidth(measure.metres, units, { withUnit: true })
                  : 'click two points'}
              </span>
              <button
                type="button"
                className="btn btn-solid"
                disabled={!street || !measure || measure.points < 2 || measure.metres <= 0}
                onClick={() => {
                  if (!street || !measure) return;
                  setExistingWidth(street.id, measure.metres);
                  setNotice({
                    kind: 'success',
                    title: `Right-of-way set to ${formatWidth(measure.metres, units, {
                      withUnit: true,
                    })}`,
                  });
                }}
              >
                Use as right-of-way
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => mapRef.current?.clearMeasure()}
              >
                Clear
              </button>
            </>
          )}

          <div className="spacer" />

          <button
            type="button"
            className="btn btn-pill"
            aria-pressed={swipe !== null}
            onClick={() => setSwipe(swipe === null ? 0.5 : null)}
          >
            {swipe === null ? 'Compare with existing' : 'Show full design'}
          </button>
        </div>

        <div className="map-wrap" ref={mapWrapRef}>
          <MapCanvas
            ref={mapRef}
            basemapId={basemapId}
            sourceOptions={sourceOptions}
            units={units}
            streets={streets}
            selectedStreetId={selectedStreetId}
            tool={tool}
            swipe={swipe}
            center={DEMO_CENTER}
            zoom={DEMO_ZOOM}
            onViewChange={setView}
            onSelectStreet={selectStreet}
            onSelectJunction={selectJunction}
            onWarnings={setWarnings}
            onJunctions={setJunctions}
            junctionOverrides={junctionOverrides}
            defaultCornerRadiusMeters={defaultCornerRadiusMeters}
            trimAtJunctions={trimAtJunctions}
            selectedJunctionKey={selectedJunctionKey}
            onDraftChange={(points, metres) => setDraft({ points: points.length, metres })}
            onDrawComplete={(points) => addStreet(points)}
            onGestureStart={beginGesture}
            onGestureEnd={endGesture}
            onVertexMove={moveVertexLive}
            onVertexInsert={insertVertexLive}
            onVertexDelete={removeVertex}
            onVertexSharp={toggleSharpVertex}
            onMeasureChange={(points, metres) => setMeasure({ points: points.length, metres })}
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

          {/* Only while a modal tool is active — a permanent hint just covers imagery. */}
          {tool !== 'select' && (
            <div className="map-overlay-tl">
              <div className="pill pill-note">{activeTool.hint}</div>
            </div>
          )}

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
            ['Center', view ? `${view.lat.toFixed(5)}, ${view.lng.toFixed(5)}` : '—'],
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
            [
              'Junctions',
              junctions.length === 0
                ? 'none'
                : `${junctions.length} · ${junctions.reduce((n, j) => n + j.legCount, 0)} legs`,
            ],
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
        {selectedJunction ? (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => selectJunction(null)}
            >
              ← Back to the street
            </button>
            <JunctionInspector
              junction={selectedJunction}
              units={units}
              streetNames={streetNames}
              override={junctionOverrides[selectedJunction.key]}
              onCorner={(index, patch) => updateCorner(selectedJunction.key, index, patch)}
              onLeg={(index, patch) => updateLeg(selectedJunction.key, index, patch)}
              onReset={() => resetJunction(selectedJunction.key)}
            />
          </>
        ) : !street || !section ? (
          <section className="panel">
            <p className="empty-note">
              Select a street to edit its cross-section, or draw a new one.
            </p>
          </section>
        ) : (
          <>
            <section className="panel">
              <header className="panel-head">
                <span className="label">Street</span>
                <span className="label mono">
                  {formatWidth(lineLengthMeters(resolveCenterline(street)), units, {
                    decimals: 0,
                    withUnit: true,
                  })}
                </span>
              </header>
              <input
                className="text-input"
                value={street.name}
                aria-label="Street name"
                onChange={(e) => renameStreet(street.id, e.target.value)}
              />
              <p className="hint">
                {street.centerline.length} control points. Drag one to reshape, alt-click to
                remove it, or drag a hollow handle between two to add one.
              </p>
            </section>

            <section className="panel">
              <header className="panel-head">
                <span className="label">Alignment</span>
                {curveMode !== 'straight' && Number.isFinite(actualRadius) && (
                  <span className="label mono" title="Tightest radius actually on the line">
                    R {formatWidth(actualRadius, units, { decimals: 0, withUnit: true })}
                  </span>
                )}
              </header>

              <div className="segmented" role="group" aria-label="Centerline alignment">
                {CURVE_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={curveMode === mode.id}
                    title={mode.hint}
                    onClick={() => setCurve(street.id, { mode: mode.id })}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              {curveMode === 'rounded' && (
                <label className="field" style={{ marginTop: 9 }}>
                  <span className="label">Corner radius ({units})</span>
                  <input
                    className="text-input mono"
                    type="number"
                    min={0}
                    step={stepFor(units)}
                    value={formatWidth(street.curve?.radiusMeters ?? DEFAULT_CURVE.radiusMeters, units, {
                      decimals: 0,
                    })}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (!Number.isFinite(value) || value < 0) return;
                      setCurve(street.id, { radiusMeters: displayToMetres(value, units) });
                    }}
                  />
                  <span className="hint">
                    A corner is clamped to the largest arc its two segments can carry, so the
                    radius above is what was asked for and the R in the header is what you got.
                  </span>
                </label>
              )}

              {curveMode !== 'straight' && (
                <p className="hint">
                  Shift-click a control point to pin it as a hard corner — useful where a
                  street curves through a bend but has to turn square at a junction.
                  {sharpCount > 0 && ` ${sharpCount} pinned.`}
                </p>
              )}
            </section>

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

                  {available > 0 && Math.abs(fit.differenceMeters) > 0.05 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-block"
                      style={{ marginTop: 9 }}
                      onClick={() => fitSectionToWidth('street', available)}
                    >
                      Scale section to {formatWidth(available, units, { withUnit: true })}
                    </button>
                  )}
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
                  Curb-to-curb of the real street — the Measure tool fills this in. The
                  redesign is honest only if this is.
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
              <p className="hint">
                Where the drawn line sits within the section. Travelway centre lands it on the
                double-yellow you can actually see on the imagery.
              </p>
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
                <span className="label">Add a band</span>
              </header>
              <PrimitivePalette units={units} onAdd={(type) => addComponent('street', type)} />
              <p className="hint">
                Added just inside the right-hand kerb. Reorder with the arrows above.
              </p>
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

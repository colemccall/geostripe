import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { BASEMAPS, WAYBACK_VINTAGES, basemapById } from '../map/basemaps';
import type { BasemapId } from '../map/basemaps';
import { useEditorStore } from '../store/useEditorStore';
import type { DisplayUnits } from '../lib/units';
import { BUILD_ID, BUILT_AT } from '../lib/version';
import UpdateNotice from './UpdateNotice';

/**
 * Persistent chrome shared by both routes.
 *
 * Units, imagery source, and undo/redo live here because they are global to the session
 * rather than to a page — the same cross-section is being edited whichever route you are
 * on, and switching pages should never lose your place in the history.
 */
export default function AppShell() {
  const units = useEditorStore((s) => s.units);
  const basemapId = useEditorStore((s) => s.basemapId);
  const customTileUrl = useEditorStore((s) => s.customTileUrl);
  const waybackRelease = useEditorStore((s) => s.waybackRelease);
  const arcgisApiKey = useEditorStore((s) => s.arcgisApiKey);
  const past = useEditorStore((s) => s.past);
  const future = useEditorStore((s) => s.future);

  const {
    setUnits,
    setBasemap,
    setCustomTileUrl,
    setWaybackRelease,
    setArcgisApiKey,
    undo,
    redo,
  } = useEditorStore.getState();
  const location = useLocation();
  const onMap = location.pathname === '/';

  // Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z, skipped while typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <b>GeoStripe</b>
          {/* The build, not the version. Answers "am I looking at my changes?" without
              guessing between a failed deploy, a stale cache and a build that never ran. */}
          <span className="brand-ver" title={BUILT_AT ? `Built ${BUILT_AT} UTC` : undefined}>
            v0.1 · {BUILD_ID}
          </span>
          <UpdateNotice />
        </div>

        <nav className="tabs" aria-label="Workspace">
          <NavLink to="/" end>
            Map editor
          </NavLink>
          <NavLink to="/builder">Asset builder</NavLink>
        </nav>

        <div className="history">
          <button
            type="button"
            className="icon-btn"
            onClick={undo}
            disabled={past.length === 0}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            ↶
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={redo}
            disabled={future.length === 0}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            ↷
          </button>
        </div>

        <div className="spacer" />

        {onMap && (
          <div className="control">
            <span className="label">Imagery</span>
            <select
              className="select"
              value={basemapId}
              onChange={(e) => setBasemap(e.target.value as BasemapId)}
              title={basemapById(basemapId).detail}
            >
              {BASEMAPS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>

            {/* Wayback is the answer to "this capture is a low-sun winter satellite pass". */}
            {basemapById(basemapId).hasVintage && (
              <select
                className="select mono"
                value={waybackRelease}
                onChange={(e) => setWaybackRelease(e.target.value)}
                aria-label="Imagery capture date"
              >
                {WAYBACK_VINTAGES.map((v) => (
                  <option key={v.release} value={v.release}>
                    {v.label}
                    {v.note ? ` · ${v.note}` : ''}
                  </option>
                ))}
              </select>
            )}

            {basemapId === 'custom' && (
              <input
                className="select mono"
                style={{ width: 220 }}
                placeholder="https://…/{z}/{x}/{y}.png"
                value={customTileUrl}
                onChange={(e) => setCustomTileUrl(e.target.value)}
                aria-label="Custom XYZ tile URL"
              />
            )}

            {basemapById(basemapId).requiresKey && (
              <input
                className="select mono"
                style={{ width: 200 }}
                type="password"
                placeholder="ArcGIS API key"
                value={arcgisApiKey}
                onChange={(e) => setArcgisApiKey(e.target.value)}
                aria-label="ArcGIS API key"
              />
            )}
          </div>
        )}

        <div className="control">
          <span className="label">Units</span>
          <div className="segmented">
            {(['ft', 'm'] as DisplayUnits[]).map((u) => (
              <button
                key={u}
                type="button"
                aria-pressed={units === u}
                onClick={() => setUnits(u)}
              >
                {u.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="workspace">
        <Outlet />
      </main>
    </div>
  );
}

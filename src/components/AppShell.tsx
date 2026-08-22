import { NavLink, Outlet } from 'react-router-dom';

/**
 * Persistent chrome shared by both routes: brand, page switcher, and a slot for
 * global actions (open / download, units, imagery source) once those exist.
 *
 * Layout mirrors the agreed UI prototype: a slim top bar over a full-height workspace.
 */
export default function AppShell() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <b>GeoStripe</b>
          <span className="brand-ver">v0.1</span>
        </div>

        <nav className="tabs" aria-label="Workspace">
          <NavLink to="/" end>
            Map editor
          </NavLink>
          <NavLink to="/builder">Asset builder</NavLink>
        </nav>

        <div className="spacer" />

        {/* Global actions (imagery source, units, open/download) mount here — Phase 1 & 6. */}
      </header>

      <main className="workspace">
        <Outlet />
      </main>
    </div>
  );
}

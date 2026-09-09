import { Suspense, lazy } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/AppShell';

/**
 * One route, lazily loaded so MapLibre is not in the entry chunk.
 *
 * There were two. The Asset Builder was its own page while a cross-section was something
 * you composed before you had anywhere to put it; assets are now what the roads on screen
 * are made of, so the editor for one lives beside them and the route is gone.
 */
const MapEditor = lazy(() => import('./routes/MapEditor'));

/**
 * Routing: HashRouter, deliberately.
 *
 * GitHub Pages serves static files only — it has no rewrite rules, so a hard refresh or
 * a shared deep link to /geostripe/builder asks Pages for a file that does not exist and
 * gets a 404 before any JavaScript runs. The two ways around that:
 *
 *   1. BrowserRouter + a 404.html that stashes the path in sessionStorage and bounces to
 *      index.html, which then restores it. Prettier URLs, but it relies on a redirect
 *      round-trip, briefly flashes an error page, and quietly breaks link previews.
 *   2. HashRouter — everything after '#' is never sent to the server, so Pages always
 *      serves index.html and the client router takes it from there.
 *
 * We use HashRouter. Deep links and refreshes work unconditionally with no redirect hack,
 * and the same build runs correctly at any base path or domain — which matters because a
 * custom domain may be added later. The cost is a '#' in the URL (/geostripe/#/builder).
 */
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route
            path="/"
            element={
              <Suspense fallback={<div className="route-loading">Loading map…</div>}>
                <MapEditor />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

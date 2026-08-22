import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/AppShell';
import MapEditor from './routes/MapEditor';
import AssetBuilder from './routes/AssetBuilder';

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
          <Route path="/" element={<MapEditor />} />
          <Route path="/builder" element={<AssetBuilder />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

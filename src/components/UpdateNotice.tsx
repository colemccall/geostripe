import { useEffect, useState } from 'react';

/**
 * "There is a newer build than the one you are looking at."
 *
 * GitHub Pages serves `index.html` with a ten-minute cache and no way to change that from
 * a repository. Assets are content-hashed, so they are never stale — but the HTML that
 * names them is, which means a returning visitor can load a perfectly current deployment
 * and still be running last week's bundle, with nothing on screen to say so. That is
 * indistinguishable from a failed deploy, and it costs an afternoon every time.
 *
 * So the page checks for itself. `cache: 'reload'` forces a real network fetch, bypassing
 * the HTTP cache that is the whole problem; if the entry script named in the fresh HTML is
 * not the one this page is running, a newer build exists and the only thing needed is a
 * reload.
 *
 * Deliberately a prompt, not an automatic refresh: reloading out from under someone
 * mid-edit would lose their work, and this app has no autosave.
 */

/** How often to look. Long enough to be free, short enough to catch a deploy mid-session. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** The entry script this page is actually running, as the server names it. */
function runningEntry(): string | null {
  const scripts = [...document.querySelectorAll('script[type="module"][src]')];
  for (const script of scripts) {
    const src = (script as HTMLScriptElement).getAttribute('src') ?? '';
    const match = /assets\/[^"']*\.js/.exec(src);
    if (match) return match[0];
  }
  return null;
}

export default function UpdateNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const mine = runningEntry();
    // Nothing to compare against in dev, where the entry is a source path rather than a
    // hashed asset. Checking anyway would light the banner on every reload.
    if (!mine) return;

    let cancelled = false;

    const check = async () => {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}index.html`, {
          cache: 'reload',
        });
        if (!response.ok) return;
        const html = await response.text();
        const served = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(html);
        if (!cancelled && served && served[0] !== mine) setStale(true);
      } catch {
        // Offline, or the check was blocked. Silence is right: this is a convenience, and
        // a failed check says nothing about whether a new build exists.
      }
    };

    void check();
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!stale) return null;

  return (
    <button
      type="button"
      className="update-notice"
      title="A newer build has been deployed. Reload to get it."
      onClick={() => window.location.reload()}
    >
      <span aria-hidden="true">⟳</span> New version — reload
    </button>
  );
}

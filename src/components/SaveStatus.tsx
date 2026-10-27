import { useEffect, useState } from 'react';
import { ago } from '../persist/autosave';
import type { Snapshot } from '../persist/autosave';
import { declineRestore, restoreSnapshot, startSession, useAutosaveState } from '../persist/session';

/**
 * The autosave indicator, and the offer to bring back last time's work.
 *
 * The indicator is always visible because "is this safe" is a question people ask silently
 * and constantly; an answer they have to go looking for is no answer. The restore offer is a
 * banner rather than a dialog so the map stays usable behind it, and autosave is held back
 * until it is answered so that the offered project is not overwritten by the demo underneath.
 */
export function SaveStatus() {
  const state = useAutosaveState();
  const [now, setNow] = useState(() => Date.now());

  // Keeps "12 s ago" moving without re-rendering the editor.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  const text =
    state.status === 'saving'
      ? 'Saving…'
      : state.status === 'dirty'
        ? 'Unsaved changes'
        : state.status === 'saved' && state.savedAt !== null
          ? `Saved ${ago(now, state.savedAt)}`
          : state.status === 'error'
            ? 'Autosave failed'
            : state.status === 'disabled'
              ? 'Autosave off'
              : 'Autosave on';

  return (
    <span
      className={`save-status save-${state.status}`}
      role="status"
      title={state.message ?? 'Your work is kept in this browser.'}
    >
      {text}
    </span>
  );
}

export function RestoreBanner() {
  const [offer, setOffer] = useState<Snapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    void startSession().then(({ restorable }) => {
      if (!cancelled) setOffer(restorable);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!offer) return null;

  return (
    <div className="restore-banner" role="alertdialog" aria-label="Restore previous session">
      <span>
        Restore <strong>{offer.name || 'your last project'}</strong>, saved{' '}
        {ago(Date.now(), offer.savedAt)}?
      </span>
      <button
        type="button"
        className="restore-yes"
        onClick={() => {
          restoreSnapshot(offer);
          setOffer(null);
        }}
      >
        Restore
      </button>
      <button
        type="button"
        onClick={() => {
          declineRestore();
          setOffer(null);
        }}
      >
        Start fresh
      </button>
    </div>
  );
}

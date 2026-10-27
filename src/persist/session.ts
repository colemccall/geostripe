import { useSyncExternalStore } from 'react';
import { AutosaveController, indexedDbStore, memoryStore } from './autosave';
import type { AutosaveState, Snapshot } from './autosave';
import { builtInAssets } from '../library/assets';
import { parseProject, serializeProject } from '../model/io';
import { useEditorStore } from '../store/useEditorStore';

/**
 * Wires autosave to the editor: what is watched, when it flushes, what happens on a return
 * visit.
 *
 * The controller (autosave.ts) knows nothing about the editor; this is the only file that
 * does. It is started once, by the editor route.
 */

const LOCK_NAME = 'streetcity-editor-autosave';

let controller: AutosaveController | null = null;
let started = false;

function ensureController(): AutosaveController {
  controller ??= new AutosaveController({
    store: indexedDbStore() ?? memoryStore(),
    read: () => {
      const { doc, assets, projectName } = useEditorStore.getState();
      // Without the derived band polygons: they are large, and discarded on load anyway.
      return {
        name: projectName,
        text: serializeProject(doc, assets, { name: projectName, includeBands: false }),
      };
    },
  });
  return controller;
}

/** Whether a snapshot holds anything worth offering back. */
function hasContent(text: string): boolean {
  const parsed = parseProject(text, builtInAssets());
  return parsed.doc.segments.length > 0 || parsed.doc.areas.length > 0;
}

export interface StartResult {
  /** The previous session, if there is one to offer. Autosave is paused until it is answered. */
  restorable: Snapshot | null;
}

/** Begin autosaving. Safe to call more than once; only the first call does anything. */
export async function startSession(): Promise<StartResult> {
  const c = ensureController();
  if (started) return { restorable: null };
  started = true;

  // Two tabs writing to one ring of snapshots would each restore the other's work over
  // their own, so only the tab that holds the lock saves.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (!lock) {
        c.disable('This project is open in another tab, so autosave is off here.');
        return undefined;
      }
      // Hold the lock for the life of the tab.
      return new Promise<void>(() => undefined);
    });
  }

  useEditorStore.subscribe((state, previous) => {
    if (
      state.doc !== previous.doc ||
      state.assets !== previous.assets ||
      state.projectName !== previous.projectName
    ) {
      c.markDirty();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (c.hasUnsaved) {
      // Browsers show their own wording; setting returnValue is what asks for the prompt.
      event.preventDefault();
      event.returnValue = '';
    }
    void c.flush();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void c.flush();
  });

  let latest: Snapshot | null = null;
  try {
    const store = indexedDbStore();
    latest = store ? await store.latest() : null;
  } catch {
    latest = null;
  }

  if (latest && hasContent(latest.text)) {
    c.pause();
    return { restorable: latest };
  }
  return { restorable: null };
}

/** Load a snapshot into the editor and resume saving. */
export function restoreSnapshot(snapshot: Snapshot): void {
  const parsed = parseProject(snapshot.text, builtInAssets());
  useEditorStore.getState().loadProject(parsed.doc, parsed.assets, snapshot.name || parsed.name);
  ensureController().resume();
  ensureController().markDirty();
}

/** Start fresh and resume saving; the old snapshots stay in the ring until pushed out. */
export function declineRestore(): void {
  ensureController().resume();
}

export function useAutosaveState(): AutosaveState {
  const c = ensureController();
  return useSyncExternalStore(c.subscribe, c.getState);
}

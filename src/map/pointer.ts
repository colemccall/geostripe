import { useSyncExternalStore } from 'react';
import type { LngLat } from '../geo/crs';

/**
 * Where the pointer is on the ground, and what it would snap to.
 *
 * Kept out of React state: it changes on every mouse move, and only the one-line status
 * strip wants it. The canvas writes here; the strip subscribes. Updates are coalesced to one
 * per animation frame.
 */

export interface PointerInfo {
  position: LngLat | null;
  snap: string | null;
  /** A line of explanation for the status strip, e.g. why a placement is refused. */
  note?: string | null;
}

let current: PointerInfo = { position: null, snap: null };
let pending: PointerInfo | null = null;
const listeners = new Set<() => void>();

export function setPointer(next: PointerInfo): void {
  pending = next;
  if (typeof requestAnimationFrame === 'undefined') {
    flush();
    return;
  }
  requestAnimationFrame(flush);
}

function flush(): void {
  if (!pending) return;
  current = pending;
  pending = null;
  for (const l of listeners) l();
}

export function usePointer(): PointerInfo {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

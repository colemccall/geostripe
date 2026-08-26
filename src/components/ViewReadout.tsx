import { useSyncExternalStore } from 'react';
import type { MapView } from '../map/MapCanvas';

/**
 * Where the map is looking — centre and zoom — as its own component.
 *
 * This was two cells of a table fed by React state in the editor, and the map reports its
 * position on every frame of every pan. So dragging the map re-rendered the whole editor,
 * several times a second, to move six digits: the street list, the library tree, the
 * junction cards, every panel, all of it reconciled because the coordinate readout
 * changed.
 *
 * Reading from an external store instead means a pan re-renders exactly this, and the
 * editor above it does not hear about the map moving at all. `useSyncExternalStore` is the
 * supported way to do that — it is built for values that change outside React's knowledge,
 * which a map's viewport very much is.
 */

export interface ViewSource {
  subscribe: (onChange: () => void) => () => void;
  get: () => MapView | null;
}

/**
 * A view that components can subscribe to without the owner re-rendering.
 *
 * Kept as a plain closure rather than a hook so the editor can hold one in a ref and hand
 * the publish half straight to the map, with nothing in between that could re-render.
 */
export function createViewSource(): ViewSource & { publish: (view: MapView) => void } {
  const listeners = new Set<() => void>();
  let current: MapView | null = null;

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    get: () => current,
    publish(view) {
      current = view;
      for (const listener of listeners) listener();
    },
  };
}

interface Props {
  source: ViewSource;
  /** Rendered around the values, so the caller owns the layout. */
  children: (view: MapView | null) => React.ReactNode;
}

export default function ViewReadout({ source, children }: Props) {
  const view = useSyncExternalStore(source.subscribe, source.get, source.get);
  return <>{children(view)}</>;
}

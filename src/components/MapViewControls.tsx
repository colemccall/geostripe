import { useState } from 'react';
import { LAYER_GROUPS } from '../map/layerGroups';
import type { LayerGroupId } from '../map/layerGroups';

/**
 * View controls, bottom-right of the map: zoom, framing, and what is drawn.
 *
 * The layer switches are not a debugging aid. Turning the lanes off to see the imagery
 * underneath, or fading the imagery back to check a design against the trace, is how you
 * find out whether the bands actually sit on the pavement — which is the one claim this
 * whole tool is making. Burying that in a settings page would be burying the check.
 *
 * The panel is collapsed by default: it is consulted, not operated.
 */

interface Props {
  visibility: Partial<Record<LayerGroupId, boolean>>;
  onVisibility: (id: LayerGroupId, visible: boolean) => void;
  imageryOpacity: number;
  onImageryOpacity: (value: number) => void;
  onZoom: (delta: number) => void;
  onFitAll: () => void;
  /** Null when the before/after swipe is off. */
  swipe: number | null;
  onSwipe: (value: number | null) => void;
}

export default function MapViewControls({
  visibility,
  onVisibility,
  imageryOpacity,
  onImageryOpacity,
  onZoom,
  onFitAll,
  swipe,
  onSwipe,
}: Props) {
  const [open, setOpen] = useState(false);
  const hidden = LAYER_GROUPS.filter((group) => visibility[group.id] === false).length;

  return (
    <div className="viewctl">
      {open && (
        <div className="viewctl-panel">
          <header className="panel-head">
            <span className="label">Drawn on the map</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>

          <ul className="layer-list">
            {LAYER_GROUPS.map((group) => {
              const on = visibility[group.id] !== false;
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    className={`layer-row${on ? ' is-on' : ''}`}
                    title={group.hint}
                    aria-pressed={on}
                    onClick={() => onVisibility(group.id, !on)}
                  >
                    <span className="layer-eye" aria-hidden="true">
                      {on ? '◉' : '○'}
                    </span>
                    <span className="layer-name">{group.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <label className="field">
            <span className="label">
              Imagery <span className="mono">{Math.round(imageryOpacity * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(imageryOpacity * 100)}
              onChange={(e) => onImageryOpacity(Number(e.target.value) / 100)}
            />
            <span className="hint">
              Fade it back to check the design against the trace, or right down to read the
              geometry on its own.
            </span>
          </label>

          <button
            type="button"
            className="btn btn-ghost"
            aria-pressed={swipe !== null}
            onClick={() => onSwipe(swipe === null ? 0.5 : null)}
          >
            {swipe === null ? 'Compare with existing' : 'Show the full design'}
          </button>
        </div>
      )}

      <div className="viewctl-buttons">
        <button
          type="button"
          className={`dock-btn${hidden > 0 ? ' is-warn' : ''}`}
          aria-pressed={open}
          aria-label="Layers"
          title={
            hidden > 0
              ? `Layers — ${hidden} hidden`
              : 'Layers — choose what is drawn, and fade the imagery'
          }
          onClick={() => setOpen(!open)}
        >
          <span className="dock-icon" aria-hidden="true">
            ▤
          </span>
        </button>
        <button
          type="button"
          className="dock-btn"
          aria-label="Frame everything"
          title="Frame everything drawn"
          onClick={onFitAll}
        >
          <span className="dock-icon" aria-hidden="true">
            ⤢
          </span>
        </button>
        <button
          type="button"
          className="dock-btn"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => onZoom(1)}
        >
          <span className="dock-icon" aria-hidden="true">
            +
          </span>
        </button>
        <button
          type="button"
          className="dock-btn"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => onZoom(-1)}
        >
          <span className="dock-icon" aria-hidden="true">
            −
          </span>
        </button>
      </div>
    </div>
  );
}

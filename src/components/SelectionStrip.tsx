import { PRIMITIVES } from '../library/primitives';
import { formatWidth } from '../lib/units';
import type { DisplayUnits } from '../lib/units';
import type { CrossSection } from '../model/types';
import type { FitResult } from '../model/section';

/**
 * What is selected, and the numbers that decide whether it works — over the map.
 *
 * The fit check is the argument this whole tool exists to make: does the design fit the
 * width that is already there? Keeping it in a side panel meant checking it was a glance
 * away from the street you were changing, so the number people came for was the number
 * they looked at least. Here it sits under the thing it describes.
 *
 * Deliberately read-mostly. Editing a width belongs in the stack where every band is
 * visible and comparable; this is the readout plus the two or three actions you reach for
 * without thinking.
 */

interface Props {
  units: DisplayUnits;
  name: string;
  kind: 'street' | 'land' | 'junction' | 'node';
  section?: CrossSection | null;
  fit?: FitResult | null;
  /** Kerb-to-kerb crossing on the worst leg, for a junction. */
  crossingMeters?: number | null;
  onRename?: (name: string) => void;
  onOpenPanel: () => void;
  /** Put it down. The counterpart to selecting, and it has to be as easy. */
  onClear: () => void;
  onDelete?: () => void;
  /** Extra buttons for whatever is selected — a node's "no junction here", say. */
  extra?: React.ReactNode;
}

export default function SelectionStrip({
  units,
  name,
  kind,
  section,
  fit,
  crossingMeters,
  onRename,
  onOpenPanel,
  onClear,
  onDelete,
  extra,
}: Props) {
  return (
    <div className="selstrip">
      <span className={`selstrip-kind is-${kind}`}>{kind}</span>

      {onRename ? (
        <input
          className="selstrip-name"
          value={name}
          aria-label="Name"
          onChange={(e) => onRename(e.target.value)}
        />
      ) : (
        <span className="selstrip-name is-static">{name}</span>
      )}

      {section && (
        <span className="chip-row selstrip-chips" aria-hidden="true">
          {section.components.map((c) => (
            <i
              key={c.id}
              style={{
                flexGrow: c.widthMeters,
                background: c.colorOverride ?? PRIMITIVES[c.componentType].color,
              }}
            />
          ))}
        </span>
      )}

      {fit && (
        <span
          className={`pill ${fit.fits ? 'pill-ok' : 'pill-warn'}`}
          title={
            fit.fits
              ? 'The design fits the width you measured'
              : 'The design is wider than the width you measured'
          }
        >
          {fit.availableMeters > 0 ? (
            <>
              {formatWidth(fit.designedMeters, units, { withUnit: true })} in{' '}
              {formatWidth(fit.availableMeters, units, { withUnit: true })}
              {!fit.fits && (
                <b> · over by {formatWidth(fit.differenceMeters, units, { withUnit: true })}</b>
              )}
            </>
          ) : (
            <>{formatWidth(fit.designedMeters, units, { withUnit: true })} wide</>
          )}
        </span>
      )}

      {crossingMeters != null && (
        <span className="pill pill-note" title="Longest kerb-to-kerb crossing here">
          {formatWidth(crossingMeters, units, { withUnit: true })} crossing
        </span>
      )}

      {extra}

      <button type="button" className="btn btn-ghost" onClick={onOpenPanel}>
        Edit
      </button>

      {onDelete && (
        <button
          type="button"
          className="icon-btn is-danger"
          title="Delete (Del)"
          aria-label="Delete"
          onClick={onDelete}
        >
          🗑
        </button>
      )}

      <button
        type="button"
        className="icon-btn"
        title="Deselect (Esc)"
        aria-label="Deselect"
        onClick={onClear}
      >
        ×
      </button>
    </div>
  );
}

import { useMemo } from 'react';
import type { ApproachFlare, LegOverride } from '../geo/derived';
import { MOVEMENTS, approachesJunction, conventionalAssignment } from '../geo/markings';
import type { Movement } from '../geo/markings';
import { PRIMITIVES } from '../library/primitives';
import type { CrossSection } from '../model/types';
import { displayToMetres, formatWidth, stepFor } from '../lib/units';
import type { DisplayUnits } from '../lib/units';

/**
 * What each lane of one approach is allowed to do, and the pocket some of them need.
 *
 * Lanes are listed in the order the driver sees them — their left first — rather than in
 * the order the cross-section stores them. Those are the same list read in opposite
 * directions depending on which way the leg runs, and asking someone to do that conversion
 * in their head while assigning turns is how you end up with left arrows in the kerbside
 * lane.
 *
 * Nothing is assigned by default. A lane with no movements gets no arrow, which is the
 * honest state for a lane nobody has said anything about — painting a guess on the road
 * and calling it a design is the failure mode this whole tool is built against. The
 * conventional assignment is one button away, and labelled as a convention.
 */

interface Props {
  units: DisplayUnits;
  section: CrossSection;
  /** +1 when the leg heads toward increasing station along its street. */
  sense: 1 | -1;
  /** False at a T-junction leg facing the stem, where straight on is not an option. */
  hasThroughMovement: boolean;
  override: LegOverride | null;
  onChange: (patch: Partial<LegOverride>) => void;
}

const MOVEMENT_LABELS: Record<Movement, { glyph: string; title: string }> = {
  left: { glyph: '↰', title: 'Left turn' },
  through: { glyph: '↑', title: 'Straight through' },
  right: { glyph: '↱', title: 'Right turn' },
  uTurn: { glyph: '↻', title: 'U-turn' },
};

const DEFAULT_FLARE: ApproachFlare = {
  side: 'right',
  componentType: 'turnPocket',
  widthMeters: 3.05,
  storageMeters: 30,
  taperMeters: 15,
  movements: ['right'],
};

export default function ApproachEditor({
  units,
  section,
  sense,
  hasThroughMovement,
  override,
  onChange,
}: Props) {
  const lanes = override?.lanes ?? [];
  const flare = override?.flare ?? null;

  /** Indices of the lanes traffic actually uses to reach this junction, driver's left first. */
  const approach = useMemo(() => {
    const indices: number[] = [];
    section.components.forEach((component, index) => {
      const spec = PRIMITIVES[component.componentType];
      if (!spec.isRoadway || spec.category === 'parking') return;
      if (!approachesJunction(component.direction, sense)) return;
      indices.push(index);
    });
    // Section order runs left-to-right along the drawn line. A leg running against that
    // line is read by its drivers in reverse.
    return sense === 1 ? indices.reverse() : indices;
  }, [section, sense]);

  const setLane = (index: number, movements: Movement[] | null) => {
    const next = section.components.map((_, i) => lanes[i] ?? null);
    next[index] = movements && movements.length > 0 ? movements : null;
    onChange({ lanes: next });
  };

  const toggle = (index: number, movement: Movement) => {
    const current = lanes[index] ?? [];
    const next = current.includes(movement)
      ? current.filter((m) => m !== movement)
      : [...current, movement];
    setLane(index, next);
  };

  const setFlare = (patch: Partial<ApproachFlare> | null) => {
    onChange({ flare: patch === null ? null : { ...(flare ?? DEFAULT_FLARE), ...patch } });
  };

  return (
    <>
      <header className="panel-head" style={{ marginTop: 12 }}>
        <span className="label">Lane assignment</span>
        <span className="label mono">
          {approach.length} approach lane{approach.length === 1 ? '' : 's'}
        </span>
      </header>

      {approach.length === 0 ? (
        <p className="empty-note">
          No traffic reaches the junction along this leg — every lane here runs away from it.
        </p>
      ) : (
        <>
          <ul className="lane-rows">
            {approach.map((index, position) => {
              const component = section.components[index]!;
              const spec = PRIMITIVES[component.componentType];
              const assigned = lanes[index] ?? [];
              return (
                <li key={component.id}>
                  <span className="swatch" style={{ background: spec.color }} />
                  <span className="lane-name">
                    {position === 0 && approach.length > 1 ? 'Inside · ' : ''}
                    {position === approach.length - 1 && approach.length > 1 ? 'Kerbside · ' : ''}
                    {spec.label}
                  </span>
                  <span className="mono lane-width">
                    {formatWidth(component.widthMeters, units)}
                  </span>
                  <span className="movement-row" role="group" aria-label={`${spec.label} movements`}>
                    {MOVEMENTS.map((movement) => (
                      <button
                        key={movement}
                        type="button"
                        className="movement"
                        aria-pressed={assigned.includes(movement)}
                        title={MOVEMENT_LABELS[movement].title}
                        onClick={() => toggle(index, movement)}
                      >
                        {MOVEMENT_LABELS[movement].glyph}
                      </button>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                onChange({ lanes: conventionalAssignment(section, sense, { hasThroughMovement }) })
              }
            >
              Use the convention
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onChange({ lanes: section.components.map(() => null) })}
            >
              Clear
            </button>
          </div>
          <p className="hint">
            The convention is leftmost lane turns left, kerbside lane turns right, everything
            between goes through. It is what most approaches do, not what this one must.
          </p>
        </>
      )}

      <header className="panel-head" style={{ marginTop: 14 }}>
        <span className="label">Turn pocket</span>
      </header>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={flare !== null}
          onChange={(e) => setFlare(e.target.checked ? {} : null)}
        />
        <span>Widen this approach</span>
      </label>

      {flare && (
        <>
          <label className="field" style={{ marginTop: 9 }}>
            <span className="label">Side</span>
            <select
              className="text-input"
              value={flare.side}
              onChange={(e) =>
                setFlare({
                  side: e.target.value as ApproachFlare['side'],
                  movements: e.target.value === 'right' ? ['right'] : ['left'],
                })
              }
            >
              <option value="right">Driver&rsquo;s right — right-turn pocket</option>
              <option value="left">Driver&rsquo;s left — left-turn pocket</option>
            </select>
          </label>

          <label className="field" style={{ marginTop: 9 }}>
            <span className="label">Width ({units})</span>
            <input
              className="text-input mono"
              type="number"
              min={0}
              step={stepFor(units)}
              value={formatWidth(flare.widthMeters, units)}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isFinite(value) || value < 0) return;
                setFlare({ widthMeters: displayToMetres(value, units) });
              }}
            />
          </label>

          <label className="field" style={{ marginTop: 9 }}>
            <span className="label">Storage length ({units})</span>
            <input
              className="text-input mono"
              type="number"
              min={0}
              step={stepFor(units)}
              value={formatWidth(flare.storageMeters, units, { decimals: 0 })}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isFinite(value) || value < 0) return;
                setFlare({ storageMeters: displayToMetres(value, units) });
              }}
            />
            <span className="hint">
              Full width back from the stop line. Too short and the queue spills into the
              through lane, which is the whole reason the pocket exists.
            </span>
          </label>

          <label className="field" style={{ marginTop: 9 }}>
            <span className="label">Taper ({units})</span>
            <input
              className="text-input mono"
              type="number"
              min={0}
              step={stepFor(units)}
              value={formatWidth(flare.taperMeters, units, { decimals: 0 })}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isFinite(value) || value < 0) return;
                setFlare({ taperMeters: displayToMetres(value, units) });
              }}
            />
          </label>

          <p className="hint">
            A pocket widens the approach, so it moves the kerb, the corner return and the
            crossing with it. Watch the crossing distance above — that is what it costs.
          </p>
        </>
      )}
    </>
  );
}

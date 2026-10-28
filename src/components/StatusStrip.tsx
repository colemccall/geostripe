import { usePointer } from '../map/pointer';
import { useEditorStore } from '../store/useEditorStore';
import type { Tool } from '../store/useEditorStore';

/**
 * A one-line strip of what the pointer is doing: where it is, what a click would snap to, and
 * what the armed tool wants next. The same facts a drafting program keeps in its status bar,
 * so a planner never has to guess at the ground position or whether a snap is active.
 */

const HINTS: Record<Tool, string> = {
  select: 'Click to select · drag a junction to move it · double-click a road to add a bend, a bend to remove it',
  build: 'Click to place · Tab cycles snaps · Alt ignores snapping · Esc cancels',
  roundabout: 'Click to place a roundabout · the armed road type is used',
  lane: 'Point near the end of a road, on the side the lane goes · click to add',
  ramp: 'Hover a road: the side you point to gets the exit or entrance · click to build',
  upgrade: 'Click a road to change it to the armed type',
  area: 'Click corners · double-click or Enter to finish',
  zone: 'Drag to paint · E erases · [ ] change size · Outline: click corners · Fill: click a block',
  building: 'Click to place · R turns · it faces the nearest road',
  district: 'Drag to paint a district · E erases · [ ] change size',
  bulldoze: 'Click to remove',
};

export default function StatusStrip() {
  const { position, snap, note } = usePointer();
  const tool = useEditorStore((s) => s.tool);

  return (
    <div className="status-strip" role="status" aria-live="off">
      <span className="status-coords">
        {position ? `${position[1].toFixed(6)}°, ${position[0].toFixed(6)}°` : '—'}
      </span>
      <span className={`status-snap${snap ? ' is-on' : ''}`}>{snap ? `Snap: ${snap}` : 'No snap'}</span>
      <span className={`status-hint${note ? ' is-warning' : ''}`}>{note ?? HINTS[tool]}</span>
    </div>
  );
}

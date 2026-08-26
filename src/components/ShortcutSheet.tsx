/**
 * Every keyboard shortcut, in one place, reachable by clicking.
 *
 * Shortcuts in this editor are accelerators and nothing more: everything listed here has a
 * button somewhere on screen, and this sheet says which. That is the point of writing it
 * down rather than leaving the keys in tooltips — a tooltip only tells you about a key
 * once you have already found the button, which is backwards for the person who is stuck.
 *
 * Read-only and deliberately plain. It is a reference, not a settings page; rebindable
 * keys would be a promise to keep them working across every tool mode, and the honest
 * version of that promise is "use the buttons".
 */

interface Row {
  keys: string;
  action: string;
  /** Where the same thing lives as a button, so the sheet is never the only route. */
  button: string;
}

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: 'Tools',
    rows: [
      { keys: 'V', action: 'Select and edit', button: 'Dock, top group' },
      { keys: 'D', action: 'Draw a street', button: 'Dock, top group' },
      { keys: 'A', action: 'Draw land cover', button: 'Dock, top group' },
      { keys: 'N', action: 'Place an intersection', button: 'Dock, top group' },
      { keys: 'M', action: 'Measure', button: 'Dock, top group' },
    ],
  },
  {
    title: 'While drawing',
    rows: [
      { keys: 'S', action: 'Straight segments', button: 'Straight / Arc, above the map' },
      { keys: 'C', action: 'Curved segments', button: 'Straight / Arc, above the map' },
      { keys: 'Enter', action: 'Finish the line', button: 'Finish, above the map' },
      { keys: 'Backspace', action: 'Take back the last point', button: 'Undo point, above the map' },
      { keys: 'Esc', action: 'Throw the line away', button: 'Cancel, above the map' },
    ],
  },
  {
    title: 'With something selected',
    rows: [
      { keys: 'Esc', action: 'Deselect', button: '× on the selection strip' },
      { keys: 'Del', action: 'Delete it', button: '🗑 on the selection strip' },
      { keys: 'Alt-click a point', action: 'Remove that point', button: 'Remove, above the map' },
      { keys: 'Shift-click a point', action: 'Pin it as a hard corner', button: 'Pin corner, above the map' },
    ],
  },
  {
    title: 'Anywhere',
    rows: [
      { keys: 'Ctrl+Z', action: 'Undo', button: 'Dock, bottom group' },
      { keys: 'Ctrl+Shift+Z', action: 'Redo', button: 'Dock, bottom group' },
    ],
  },
];

interface Props {
  onClose: () => void;
}

export default function ShortcutSheet({ onClose }: Props) {
  return (
    <div
      className="sheet-scrim"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header className="sheet-head">
          <div>
            <h2>Keyboard shortcuts</h2>
            <p className="hint">
              All optional. Everything here is also a button — the third column says where.
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="sheet-body">
          {GROUPS.map((group) => (
            <section key={group.title} className="sheet-group">
              <h3 className="label">{group.title}</h3>
              <table className="sheet-table">
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={`${group.title}-${row.keys}-${row.action}`}>
                      <td>
                        <kbd>{row.keys}</kbd>
                      </td>
                      <td>{row.action}</td>
                      <td className="sheet-where">{row.button}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

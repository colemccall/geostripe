/**
 * The tool dock: the controls that belong on the map rather than beside it.
 *
 * Everything here is reachable without moving the eye off the imagery you are tracing.
 * That is the whole reason it exists — a side rail makes you look away from the thing you
 * are working on, once per action, and drawing a street is a hundred actions.
 *
 * Three bands, in order of how often they are used:
 *
 *   tools    the modal choice. What a click on the map means.
 *   act      what to do with what is selected: frame it, copy it, delete it.
 *   history  undo and redo, which are needed most in exactly the moment you are
 *            concentrating hardest and least willing to go looking.
 *
 * Every button carries its keyboard shortcut in the tooltip, because the dock is the
 * discovery surface for shortcuts as much as it is a way to click them.
 */

interface Tool {
  id: string;
  label: string;
  key: string;
  hint: string;
  icon: string;
}

interface Action {
  id: string;
  label: string;
  icon: string;
  hint: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

interface Props {
  tools: readonly Tool[];
  activeTool: string;
  onTool: (id: string) => void;
  actions: readonly Action[];
  history: readonly Action[];
  /** Collapses the side rail, so the map can have the whole window. */
  railOpen: boolean;
  onRail: (open: boolean) => void;
}

export default function MapDock({
  tools,
  activeTool,
  onTool,
  actions,
  history,
  railOpen,
  onRail,
}: Props) {
  return (
    <div className="dock" role="toolbar" aria-orientation="vertical" aria-label="Map tools">
      <button
        type="button"
        className="dock-btn dock-rail"
        title={railOpen ? 'Hide the side panel' : 'Show the side panel'}
        aria-label={railOpen ? 'Hide the side panel' : 'Show the side panel'}
        aria-pressed={!railOpen}
        onClick={() => onRail(!railOpen)}
      >
        {railOpen ? '⇤' : '⇥'}
      </button>

      <div className="dock-group">
        {tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className="dock-btn"
            aria-pressed={activeTool === tool.id}
            aria-label={tool.label}
            title={`${tool.label} (${tool.key.toUpperCase()}) — ${tool.hint}`}
            onClick={() => onTool(tool.id)}
          >
            <span className="dock-icon" aria-hidden="true">
              {tool.icon}
            </span>
            <span className="dock-key mono" aria-hidden="true">
              {tool.key.toUpperCase()}
            </span>
          </button>
        ))}
      </div>

      {actions.length > 0 && (
        <div className="dock-group">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`dock-btn${action.danger ? ' is-danger' : ''}`}
              disabled={action.disabled}
              aria-label={action.label}
              title={`${action.label} — ${action.hint}`}
              onClick={action.onClick}
            >
              <span className="dock-icon" aria-hidden="true">
                {action.icon}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="dock-group">
        {history.map((action) => (
          <button
            key={action.id}
            type="button"
            className="dock-btn"
            disabled={action.disabled}
            aria-label={action.label}
            title={`${action.label} — ${action.hint}`}
            onClick={action.onClick}
          >
            <span className="dock-icon" aria-hidden="true">
              {action.icon}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

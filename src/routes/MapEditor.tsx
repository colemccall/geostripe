import { useRef } from 'react';
import { MapCanvas } from '../map/MapCanvas';
import AssetPalette from '../components/AssetPalette';
import Inspector from '../components/Inspector';
import NoticeBar from '../components/NoticeBar';
import { useEditorStore } from '../store/useEditorStore';
import type { Tool } from '../store/useEditorStore';
import { parseProject, projectFilename, serializeProject } from '../model/io';
import { builtInAssets } from '../library/assets';
import { LAYER_GROUPS } from '../map/layerGroups';
import { DEMOS } from '../demo';

/**
 * The editor.
 *
 * One page now, where there were two. The Asset Builder was a separate route because a
 * cross-section used to be a thing you made BEFORE you had anywhere to put it; an asset is
 * a thing the roads on screen are already made of, so editing one belongs beside them. The
 * split also cost a round trip through the router every time somebody wanted a lane wider.
 */

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'select', label: 'Select', hint: 'Click to select, drag nodes and bends' },
  { id: 'build', label: 'Build', hint: 'Click to lay the active asset, node to node' },
  { id: 'area', label: 'Ground', hint: 'Click a shape, double-click to close it' },
  { id: 'bulldoze', label: 'Bulldoze', hint: 'Click to remove' },
];

export default function MapEditor() {
  const fileInput = useRef<HTMLInputElement | null>(null);

  const units = useEditorStore((s) => s.units);
  const tool = useEditorStore((s) => s.tool);
  const notice = useEditorStore((s) => s.notice);
  const projectName = useEditorStore((s) => s.projectName);
  const buildLevel = useEditorStore((s) => s.buildLevel);
  const railOpen = useEditorStore((s) => s.railOpen);
  const layerVisibility = useEditorStore((s) => s.layerVisibility);
  const imageryOpacity = useEditorStore((s) => s.imageryOpacity);
  const showAllCenterlines = useEditorStore((s) => s.showAllCenterlines);
  const doc = useEditorStore((s) => s.doc);

  const store = useEditorStore.getState();

  const onSave = () => {
    const state = useEditorStore.getState();
    const text = serializeProject(state.doc, state.assets, { name: state.projectName });
    const blob = new Blob([text], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = projectFilename(state.projectName);
    link.click();
    URL.revokeObjectURL(url);
    store.setNotice({ kind: 'success', title: `Saved ${link.download}` });
  };

  const onOpen = async (file: File) => {
    const text = await file.text();
    const result = parseProject(text, builtInAssets());
    const name = file.name.replace(/\.(geo)?json$/i, '') || result.name;

    if (result.doc.segments.length === 0 && result.doc.areas.length === 0) {
      store.setNotice({
        kind: 'error',
        title: 'Nothing to open in that file',
        details: result.warnings,
      });
      return;
    }

    store.loadProject(result.doc, result.assets, name);
    store.setNotice({
      kind: result.converted ? 'warning' : 'success',
      title: result.converted
        ? `Converted ${name} from the old street model`
        : `Opened ${name}`,
      details: result.warnings,
    });
  };

  return (
    <div className={`editor${railOpen ? '' : ' rail-closed'}`}>
      <div className="editor-map">
        <MapCanvas className="map-canvas" />

        <div className="map-toolbar" role="toolbar" aria-label="Tools">
          {TOOLS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tool === entry.id ? 'is-active' : ''}
              onClick={() => store.setTool(entry.id)}
              title={entry.hint}
            >
              {entry.label}
            </button>
          ))}

          {tool === 'build' && (
            <span className="toolbar-level" title="Page Up and Page Down">
              {buildLevel === 0
                ? 'At grade'
                : buildLevel > 0
                  ? `Elevated +${buildLevel}`
                  : `Below ${buildLevel}`}
            </span>
          )}
        </div>

        <div className="map-status">
          {doc.segments.length} road(s) · {doc.nodes.length} node(s) · {doc.areas.length} area(s)
        </div>
      </div>

      <aside className="editor-rail">
        <header className="rail-head">
          <input
            className="project-name"
            type="text"
            value={projectName}
            onChange={(event) => store.setProjectName(event.target.value)}
            aria-label="Project name"
          />
          <div className="rail-file">
            <button type="button" onClick={onSave}>
              Save
            </button>
            <button type="button" onClick={() => fileInput.current?.click()}>
              Open
            </button>
            <select
              value=""
              aria-label="Open an example project"
              onChange={(event) => {
                if (event.target.value) store.openDemo(event.target.value as never);
              }}
            >
              <option value="">Examples…</option>
              {DEMOS.map((demo) => (
                <option key={demo.id} value={demo.id}>
                  {demo.label}
                </option>
              ))}
            </select>
            <input
              ref={fileInput}
              type="file"
              accept=".geojson,.json,application/geo+json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onOpen(file);
                event.target.value = '';
              }}
            />
          </div>
        </header>

        <NoticeBar notice={notice} onDismiss={() => store.setNotice(null)} />

        <AssetPalette units={units} />
        <Inspector units={units} />

        <details className="rail-layers">
          <summary>View</summary>
          {LAYER_GROUPS.map((group) => (
            <label key={group.id} title={group.hint}>
              <input
                type="checkbox"
                checked={layerVisibility[group.id] !== false}
                onChange={(event) => store.setLayerVisible(group.id, event.target.checked)}
              />
              {group.label}
            </label>
          ))}
          <label title="Fade the imagery back to check the design sits on the pavement">
            Imagery
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={imageryOpacity}
              onChange={(event) => store.setImageryOpacity(Number(event.target.value))}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={showAllCenterlines}
              onChange={(event) => store.setShowAllCenterlines(event.target.checked)}
            />
            All centerlines
          </label>
        </details>
      </aside>

      <button
        type="button"
        className="rail-toggle"
        onClick={() => store.setRailOpen(!railOpen)}
        aria-label={railOpen ? 'Hide panel' : 'Show panel'}
      >
        {railOpen ? '›' : '‹'}
      </button>
    </div>
  );
}

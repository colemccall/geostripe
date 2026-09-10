import { useRef } from 'react';
import { MapCanvas } from '../map/MapCanvas';
import HotBar from '../components/HotBar';
import Inspector from '../components/Inspector';
import NoticeBar from '../components/NoticeBar';
import { useEditorStore } from '../store/useEditorStore';
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

export default function MapEditor() {
  const fileInput = useRef<HTMLInputElement | null>(null);

  const units = useEditorStore((s) => s.units);
  const notice = useEditorStore((s) => s.notice);
  const projectName = useEditorStore((s) => s.projectName);
  const layerVisibility = useEditorStore((s) => s.layerVisibility);
  const imageryOpacity = useEditorStore((s) => s.imageryOpacity);
  const showAllCenterlines = useEditorStore((s) => s.showAllCenterlines);
  const doc = useEditorStore((s) => s.doc);
  const selectedSegmentId = useEditorStore((s) => s.selectedSegmentId);
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId);
  const selectedAreaId = useEditorStore((s) => s.selectedAreaId);
  const editingAssetId = useEditorStore((s) => s.editingAssetId);

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

  const hasSelection = Boolean(
    doc.segments.find((x) => x.id === selectedSegmentId) ||
      doc.nodes.find((x) => x.id === selectedNodeId) ||
      doc.areas.find((x) => x.id === selectedAreaId) ||
      editingAssetId,
  );

  return (
    <div className="editor">
      <MapCanvas className="map-canvas" />

      {/* Project and files, top-left, out of the way of the build menu. */}
      <div className="hud hud-tl">
        <input
          className="project-name"
          type="text"
          value={projectName}
          onChange={(event) => store.setProjectName(event.target.value)}
          aria-label="Project name"
        />
        <button type="button" onClick={onSave} title="Save as GeoJSON">
          Save
        </button>
        <button type="button" onClick={() => fileInput.current?.click()} title="Open a project">
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

      {/* Layers and imagery, bottom-right, where a map's view controls belong. */}
      <details className="hud hud-br">
        <summary title="What is drawn">View</summary>
        <div className="hud-panel">
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
            <span>Imagery</span>
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
        </div>
      </details>

      <div className="hud hud-count">
        {doc.segments.length} roads · {doc.nodes.length} nodes · {doc.areas.length} areas
      </div>

      <NoticeBar notice={notice} onDismiss={() => store.setNotice(null)} />

      {/* The inspector only exists while something is selected. Nothing to dismiss, and no
          empty column sitting there the rest of the time. */}
      {hasSelection && (
        <aside className="hud hud-inspector">
          <Inspector units={units} />
        </aside>
      )}

      <HotBar units={units} />
    </div>
  );
}

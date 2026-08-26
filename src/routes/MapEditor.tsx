import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useEditorStore,
  selectedStreet,
  anchorModeOf,
  DRAFT_SECTION,
} from '../store/useEditorStore';
import type { AnchorMode, Tool } from '../store/useEditorStore';
import { checkFit, resolveAnchorOffset, totalWidth } from '../model/section';
import { displayToMetres, formatWidth, stepFor } from '../lib/units';
import { EDITOR_VERSION } from '../lib/version';
import { PRIMITIVES } from '../library/primitives';
import { TEMPLATES, TEMPLATE_CATEGORIES, instantiateTemplate } from '../library/templates';
import { basemapById } from '../map/basemaps';
import MapCanvas from '../map/MapCanvas';
import type { EntityKind, MapHandle } from '../map/MapCanvas';
import type { DesignData, JunctionSummary } from '../map/designLayers';
import { describeWarnings } from '../geo/curvature';
import { lineLengthMeters } from '../geo/measure';
import { DEFAULT_CURVE, resolveCenterline, tightestRadius } from '../geo/curve';
import { LANDCOVERS } from '../library/landcover';
import type { CurveMode } from '../geo/curve';
import { downloadText, pickTextFile } from '../model/assetFile';
import { parseProject, projectFilename, serializeProject } from '../model/project';
import { DEMO_CENTER, DEMO_ZOOM } from '../demo/washingtonPark';
import CrossSectionSvg from '../components/CrossSectionSvg';
import ComponentStack from '../components/ComponentStack';
import PrimitivePalette from '../components/PrimitivePalette';
import LandcoverPalette from '../components/LandcoverPalette';
import TemplatePicker from '../components/TemplatePicker';
import JunctionInspector from '../components/JunctionInspector';
import MapDock from '../components/MapDock';
import { planConnections } from '../geo/connect';
import { levelAt, stationAt } from '../geo/grade';
import type { Connection } from '../geo/connect';
import ShortcutSheet from '../components/ShortcutSheet';
import ViewReadout, { createViewSource } from '../components/ViewReadout';
import MapViewControls from '../components/MapViewControls';
import SelectionStrip from '../components/SelectionStrip';
import NoticeBar from '../components/NoticeBar';

/**
 * Route: "/" — the Map Editor.
 *
 * Streets render as real measured polygons over the imagery. The swipe divider shows the
 * design against the untouched street, which is the comparison the whole tool exists to
 * make: does this fit in the width that is already there?
 *
 * The map is modal — select, draw, measure — and this component owns the mode while
 * MapCanvas owns the pointer mechanics. Gestures that span many frames (dragging a
 * vertex) go through the store's live setters bracketed by beginGesture/endGesture, so a
 * drag lands in history as one step rather than two hundred.
 */

const CURVE_MODES: { id: CurveMode; label: string; hint: string }[] = [
  { id: 'straight', label: 'Straight', hint: 'Plain polyline — every control point is a hard corner.' },
  {
    id: 'rounded',
    label: 'Rounded',
    hint: 'Tangent-arc-tangent, the way a road alignment is specified: straight runs joined by arcs of a stated radius.',
  },
  {
    id: 'smooth',
    label: 'Smooth',
    hint: 'A spline through every control point. Best for tracing a street that genuinely curves, where you do not know the radius.',
  },
];

/**
 * The left rail, one section at a time.
 *
 * These used to be five panels stacked in a single scrolling column, which meant the
 * intersection you were editing could be four screens below the street list and there was
 * no way to tell what was down there without going to look.
 */
type RailTab = 'project' | 'streets' | 'land' | 'junctions' | 'sections';

const RAIL_TABS: { id: RailTab; label: string; icon: string; hint: string }[] = [
  { id: 'project', label: 'Project', icon: '◲', hint: 'Name it, save it, open one' },
  { id: 'streets', label: 'Streets', icon: '═', hint: 'Every street, and what it is made of' },
  { id: 'land', label: 'Land', icon: '▰', hint: 'Parks, water, buildings, plazas' },
  { id: 'junctions', label: 'Junctions', icon: '✛', hint: 'Where streets meet, and how' },
  { id: 'sections', label: 'Sections', icon: '≡', hint: 'Cross-sections to apply' },
];

const TOOLS: { id: Tool; label: string; key: string; hint: string; icon: string }[] = [
  {
    id: 'select',
    label: 'Select',
    key: 'V',
    icon: '↖',
    hint: 'Click a band to select it. Drag a vertex to reshape, alt-click one to remove it, drag a hollow handle to add one.',
  },
  {
    id: 'draw',
    label: 'Draw street',
    key: 'D',
    icon: '╱',
    hint: 'Click along the centerline; points snap to lines already drawn. Shift adds 15° angle snapping, Alt turns snapping off. Enter or double-click finishes, Backspace removes the last point, Esc cancels.',
  },
  {
    id: 'area',
    label: 'Land',
    key: 'A',
    icon: '▰',
    hint: 'Click around a patch of ground to cover it; points snap to what is already drawn, and Alt turns that off. Enter or double-click closes the shape, Esc cancels.',
  },
  {
    id: 'node',
    label: 'Intersection',
    key: 'N',
    icon: '⊕',
    hint: 'Click where roads meet to place an intersection you own — one you can select, drag, disable or delete. Click an existing one to select it.',
  },
  {
    id: 'measure',
    label: 'Measure',
    key: 'M',
    icon: '⟺',
    hint: 'Click two points to measure the real street — usually kerb to kerb. Both ends snap to lines already drawn; Alt turns that off.',
  },
];

export default function MapEditor() {
  const streets = useEditorStore((s) => s.streets);
  const units = useEditorStore((s) => s.units);
  const projectName = useEditorStore((s) => s.projectName);
  const selectedComponentId = useEditorStore((s) => s.selectedComponentId);
  const selectedStreetId = useEditorStore((s) => s.selectedStreetId);
  const basemapId = useEditorStore((s) => s.basemapId);
  const customTileUrl = useEditorStore((s) => s.customTileUrl);
  const waybackRelease = useEditorStore((s) => s.waybackRelease);
  const arcgisApiKey = useEditorStore((s) => s.arcgisApiKey);
  const swipe = useEditorStore((s) => s.swipe);
  const notice = useEditorStore((s) => s.notice);
  const tool = useEditorStore((s) => s.tool);
  const drawSectionId = useEditorStore((s) => s.drawSectionId);
  const areas = useEditorStore((s) => s.areas);
  const selectedAreaId = useEditorStore((s) => s.selectedAreaId);
  const drawLandcover = useEditorStore((s) => s.drawLandcover);
  const selectedJunctionKey = useEditorStore((s) => s.selectedJunctionKey);
  const junctionOverrides = useEditorStore((s) => s.junctionOverrides);
  const defaultCornerRadiusMeters = useEditorStore((s) => s.defaultCornerRadiusMeters);
  const trimAtJunctions = useEditorStore((s) => s.trimAtJunctions);
  const junctionMergeSlackMeters = useEditorStore((s) => s.junctionMergeSlackMeters);
  const showAllCenterlines = useEditorStore((s) => s.showAllCenterlines);
  const layerVisibility = useEditorStore((s) => s.layerVisibility);
  const imageryOpacity = useEditorStore((s) => s.imageryOpacity);
  const railOpen = useEditorStore((s) => s.railOpen);
  const nodes = useEditorStore((s) => s.nodes);
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId);
  const junctionMode = useEditorStore((s) => s.junctionMode);
  const autoConnect = useEditorStore((s) => s.autoConnect);
  const pointAction = useEditorStore((s) => s.pointAction);
  const segmentMode = useEditorStore((s) => s.segmentMode);
  const drawRadiusMeters = useEditorStore((s) => s.drawRadiusMeters);
  // Subscribed rather than read once: the dock's undo button has to grey out the moment
  // there is nothing left to undo, which is a re-render, not a snapshot.
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const draftSection = useEditorStore((s) => s.draftSection);
  const recentComponentTypes = useEditorStore((s) => s.recentComponentTypes);
  const recentTemplateIds = useEditorStore((s) => s.recentTemplateIds);
  const street = useEditorStore(selectedStreet);

  const {
    selectStreet,
    selectComponent,
    addComponent,
    setWidth,
    setDirection,
    setComponentMarkings,
    duplicateComponent,
    mirrorSection,
    moveComponent,
    removeComponent,
    applyTemplate,
    fitSectionToWidth,
    setAnchorMode,
    setExistingWidth,
    setSwipe,
    setNotice,
    setProjectName,
    setTool,
    setDrawSectionId,
    addStreet,
    renameStreet,
    toggleStreetVisible,
    duplicateStreet,
    removeStreet,
    loadStreets,
    clearStreets,
    loadDemo,
    selectJunction,
    updateCorner,
    updateLeg,
    setJunctionForm,
    resetJunction,
    setTrimAtJunctions,
    setJunctionMergeSlack,
    setShowAllCenterlines,
    setLayerVisible,
    setImageryOpacity,
    setRailOpen,
    undo,
    redo,
    addNode,
    removeNode,
    renameNode,
    toggleNodeDisabled,
    selectNode,
    moveNodeLive,
    placeNodeAt,
    setJunctionMode,
    setAutoConnect,
    setPointAction,
    connectEnd,
    setSegmentMode,
    setDrawRadius,
    clearSelection,
    beginGesture,
    endGesture,
    moveVertexLive,
    insertVertexLive,
    removeVertex,
    setCurve,
    setStreetLevel,
    setStreetGrade,
    gradeSeparateAt,
    toggleSharpVertex,
    addArea,
    selectArea,
    renameArea,
    setAreaLandcover,
    setAreaCurve,
    toggleAreaVisible,
    duplicateArea,
    removeArea,
    moveAreaVertexLive,
    insertAreaVertexLive,
    removeAreaVertex,
    toggleAreaSharpVertex,
    setDrawLandcover,
  } = useEditorStore.getState();

  // The map's viewport lives outside React. It changes on every frame of a pan, and the
  // only thing that wants it is a two-cell readout in the status bar — routing that
  // through component state re-rendered the entire editor several times a second.
  const viewSource = useRef(createViewSource()).current;
  const [warnings, setWarnings] = useState<DesignData['warnings']>([]);
  const [draft, setDraft] = useState<{ points: number; metres: number }>({
    points: 0,
    metres: 0,
  });
  const [measure, setMeasure] = useState<{ points: number; metres: number } | null>(null);
  const [junctions, setJunctions] = useState<JunctionSummary[]>([]);
  const [offsetPairs, setOffsetPairs] = useState<DesignData['offsetPairs']>([]);
  const [renderStats, setRenderStats] = useState<{
    bands: number;
    drawn: boolean;
    rendered: number;
    sourceLoaded: string;
    layerCount: number;
  } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [railTab, setRailTab] = useState<RailTab>('streets');
  const mapWrapRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapHandle | null>(null);

  // Memoised so MapCanvas's basemap effect does not see a new object every render.
  const sourceOptions = useMemo(
    () => ({ customUrl: customTileUrl, waybackRelease, arcgisApiKey }),
    [customTileUrl, waybackRelease, arcgisApiKey],
  );

  const section = street?.section;
  const total = section ? totalWidth(section.components) : 0;
  const available = street?.existingWidthMeters ?? 0;
  const fit = section ? checkFit(section.components, available || total) : null;
  const basemap = basemapById(basemapId);
  const activeTool = TOOLS.find((t) => t.id === tool) ?? TOOLS[0]!;
  const curveMode = street?.curve?.mode ?? 'straight';
  const sharpCount = street?.curve?.sharpVertices?.length ?? 0;
  const actualRadius = street ? tightestRadius(resolveCenterline(street)) : Infinity;
  const area = areas.find((a) => a.id === selectedAreaId) ?? null;
  const selectedJunction = junctions.find((j) => j.key === selectedJunctionKey) ?? null;
  const streetNames = useMemo(
    () => Object.fromEntries(streets.map((s) => [s.id, s.name])),
    [streets],
  );
  // The inspector lists a leg's own lanes, so it needs the section behind each leg.
  const streetSections = useMemo(
    () => Object.fromEntries(streets.map((s) => [s.id, s.section])),
    [streets],
  );
  const offsetNeighbours = useMemo(() => {
    if (!selectedJunctionKey) return [];
    return offsetPairs
      .filter((pair) => pair.keys.includes(selectedJunctionKey))
      .map((pair) => ({
        key: pair.keys[0] === selectedJunctionKey ? pair.keys[1] : pair.keys[0],
        separationMeters: pair.separationMeters,
      }));
  }, [offsetPairs, selectedJunctionKey]);

  /**
   * Ends that do not meet what they were drawn to meet.
   *
   * Computed rather than stored, and computed by the same function the Connect button
   * runs, so the count on the button and the rings on the map can never disagree with what
   * pressing it actually does.
   */
  const loosePlan = useMemo(() => planConnections(streets), [streets]);
  const looseEndPoints = useMemo(
    () => loosePlan.map((c) => c.point),
    [loosePlan],
  );

  /**
   * The junctions along the selected street, with how far each sits from its start.
   *
   * Station is measured rather than stored: a junction knows where it IS, and a grade
   * profile is written against distance along the street it belongs to, so the two have to
   * be reconciled somewhere. Here, where the street is already resolved.
   */
  const crossingsAlong = useMemo(() => {
    if (!street) return [];
    const line = resolveCenterline(street);
    return junctions
      .filter((j) => j.legs.some((leg) => leg.streetId === street.id))
      .map((j) => ({
        key: j.key,
        position: j.position,
        stationMeters: stationAt(line, j.position),
        level: levelAt(street.grade, stationAt(line, j.position), street.level ?? 0),
        label: j.legs
          .map((leg) => streetNames[leg.streetId] ?? 'Street')
          .filter((name, i, all) => all.indexOf(name) === i && name !== street.name)
          .join(' × ') || 'Crossing',
      }))
      .sort((a, b) => a.stationMeters - b.stationMeters);
  }, [street, junctions, streetNames]);

  /** The section a newly drawn street gets — also the fallback for a bare line import. */
  const drawingSection = useMemo(() => {
    const template = TEMPLATES.find((t) => t.id === drawSectionId);
    return template ? instantiateTemplate(template) : draftSection;
  }, [drawSectionId, draftSection]);

  // Single-key tool shortcuts, the way every map editor does it. Skipped while typing,
  // and while a modifier is held so they never shadow Ctrl+Z or a browser shortcut.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // The pen's shape, while it is in use. Checked before the tool keys so that S and C
      // mean "straight" and "curve" in the middle of drawing a line rather than jumping to
      // another tool and throwing the line away.
      const key = event.key.toLowerCase();
      if (tool === 'draw' || tool === 'area') {
        if (key === 's' || key === 'c') {
          event.preventDefault();
          setSegmentMode(key === 's' ? 'straight' : 'curved');
          return;
        }
      }

      const match = TOOLS.find((t) => t.key.toLowerCase() === key);
      if (!match) return;
      event.preventDefault();
      setTool(match.id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTool, setSegmentMode, tool]);

  const startSwipeDrag = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const wrap = mapWrapRef.current;
      if (!wrap) return;

      const move = (e: PointerEvent) => {
        const rect = wrap.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        setSwipe(Math.min(0.98, Math.max(0.02, ratio)));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [setSwipe],
  );

  // -------------------------------------------------------------------- project file

  function handleSave() {
    if (streets.length === 0 && areas.length === 0) {
      setNotice({
        kind: 'warning',
        title: 'Nothing to save yet',
        details: ['Draw a street first.'],
      });
      return;
    }
    downloadText(
      projectFilename(projectName),
      serializeProject(
        streets,
        { name: projectName, editorVersion: EDITOR_VERSION },
        junctionOverrides,
        areas,
        nodes,
      ),
      'application/geo+json',
    );
    setNotice({
      kind: 'success',
      title:
        `Saved ${streets.length} street${streets.length === 1 ? '' : 's'}` +
        (areas.length > 0 ? ` and ${areas.length} land area${areas.length === 1 ? '' : 's'}` : ''),
      details: [
        'Centerlines carry their cross-section; the band polygons travel with them for QGIS.',
      ],
    });
  }

  async function handleOpen() {
    const text = await pickTextFile('application/geo+json,application/json,.geojson,.json');
    if (text === null) return;

    const result = parseProject(text, {
      sectionName: drawingSection.name,
      components: drawingSection.components.map((c) => ({
        componentType: c.componentType,
        widthMeters: c.widthMeters,
        direction: c.direction,
      })),
    });

    if (!result.ok) {
      setNotice({ kind: 'error', title: 'That file could not be loaded', details: result.errors });
      return;
    }

    loadStreets(result.streets, result.junctionOverrides, result.areas, result.nodes);
    mapRef.current?.zoomTo(result.streets[0]?.centerline ?? []);
    setNotice({
      kind: result.warnings.length ? 'warning' : 'success',
      title:
        `Loaded ${result.streets.length} street${result.streets.length === 1 ? '' : 's'}` +
        (result.areas.length > 0
          ? ` and ${result.areas.length} land area${result.areas.length === 1 ? '' : 's'}`
          : ''),
      details: result.warnings,
    });
  }

  /**
   * Weld one loose end, and say exactly what moved.
   *
   * Reports rather than acting silently: this MOVES geometry the user drew, so it has to
   * be visible that it did, and undoable if it guessed wrong.
   */
  const handleConnect = (connection: Connection) => {
    if (!connectEnd(connection.streetId, connection.end)) return;
    setNotice({
      kind: 'success',
      title: `${streetNames[connection.streetId] ?? 'Street'} — ${connection.label}`,
      details: ['Ctrl+Z puts it back.'],
    });
  };

  /** One place for "get rid of what is selected", shared by the key, the dock and the strip. */
  const deleteSelection = () => {
    if (selectedNodeId) removeNode(selectedNodeId);
    else if (street) removeStreet(street.id);
    else if (area) removeArea(area.id);
  };

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  // ------------------------------------------------------------------------ rendering

  return (
    <div className={`workspace-grid${railOpen ? '' : ' is-collapsed'}`}>
      {/* ---------------------------------------------------------------- left rail */}
      <aside className="rail">
        {/* One panel at a time, not six stacked in an endless scroll.
            The counts are the point of putting them here: the tab strip doubles as the
            project's readout, so "how many streets, are any ends loose" is answered
            without opening anything. */}
        <nav className="rail-tabs" role="tablist" aria-label="Project">
          {RAIL_TABS.map((t) => {
            const count =
              t.id === 'streets'
                ? streets.length
                : t.id === 'land'
                  ? areas.length
                  : t.id === 'junctions'
                    ? junctions.length + nodes.length
                    : null;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={railTab === t.id}
                title={t.hint}
                onClick={() => setRailTab(t.id)}
              >
                <span className="rail-tab-icon" aria-hidden="true">
                  {t.icon}
                </span>
                <span className="rail-tab-label">{t.label}</span>
                {count !== null && count > 0 && <span className="rail-tab-count mono">{count}</span>}
                {t.id === 'junctions' && loosePlan.length > 0 && (
                  <span className="rail-tab-dot" title={`${loosePlan.length} loose ends`} />
                )}
              </button>
            );
          })}
        </nav>

        <div className="rail-body">
        {railTab === 'project' && (
          <section className="panel">
            <header className="panel-head">
              <span className="label">Project</span>
            </header>
            <input
              className="text-input"
              value={projectName}
              aria-label="Project name"
              onChange={(e) => setProjectName(e.target.value)}
            />
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-solid" onClick={handleSave}>
                Save .geojson
              </button>
              <button type="button" className="btn btn-ghost" onClick={handleOpen}>
                Open…
              </button>
            </div>
            <p className="hint">
              Plain GeoJSON — editable by hand, openable in QGIS, and still fully parametric
              when you load it back.
            </p>
          </section>
        )}

        {railTab === 'streets' && (
          <section className="panel">
            <header className="panel-head">
              <span className="label">Streets</span>
              <span className="label mono">{streets.length}</span>
            </header>

            {streets.length === 0 ? (
              <p className="empty-note">
                No streets yet. Choose <b>Draw street</b> above the map and click along a
                centerline, or load the Washington Park example.
              </p>
            ) : (
              <ul className="cards">
                {streets.map((s) => (
                  <li key={s.id}>
                    <div className={`street-card${s.id === selectedStreetId ? ' is-active' : ''}`}>
                      <button
                        type="button"
                        className="card street-card-main"
                        onClick={() => selectStreet(s.id)}
                        onDoubleClick={() => mapRef.current?.zoomTo(s.centerline)}
                      >
                        <span className="card-title">{s.name}</span>
                        <span className="chip-row" aria-hidden="true">
                          {s.section.components.map((c) => (
                            <i
                              key={c.id}
                              style={{
                                flexGrow: c.widthMeters,
                                background: c.colorOverride ?? PRIMITIVES[c.componentType].color,
                              }}
                            />
                          ))}
                        </span>
                        <span className="card-meta">
                          <span>
                            {s.section.components.length} bands ·{' '}
                            {formatWidth(lineLengthMeters(resolveCenterline(s)), units, {
                              decimals: 0,
                              withUnit: true,
                            })}{' '}
                            long
                          </span>
                          <span className="mono">
                            {formatWidth(totalWidth(s.section.components), units, {
                              withUnit: true,
                            })}
                          </span>
                        </span>
                      </button>

                      <div className="street-card-tools">
                        <button
                          type="button"
                          className="icon-btn"
                          title={s.visible ? 'Hide' : 'Show'}
                          aria-label={s.visible ? `Hide ${s.name}` : `Show ${s.name}`}
                          onClick={() => toggleStreetVisible(s.id)}
                        >
                          {s.visible ? '◉' : '○'}
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Zoom to"
                          aria-label={`Zoom to ${s.name}`}
                          onClick={() => mapRef.current?.zoomTo(s.centerline)}
                        >
                          ⤢
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Duplicate"
                          aria-label={`Duplicate ${s.name}`}
                          onClick={() => duplicateStreet(s.id)}
                        >
                          ⧉
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Delete"
                          aria-label={`Delete ${s.name}`}
                          onClick={() => removeStreet(s.id)}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={showAllCenterlines}
                onChange={(e) => setShowAllCenterlines(e.target.checked)}
              />
              <span>Show every centerline</span>
            </label>
            <p className="hint">
              A centerline is an editing handle, not part of the design — it is the one line on
              the map that does not exist on the ground. Off, it appears only for the street
              you have selected, which is the moment it means anything.
            </p>

            <div className="btn-row">
              <button
                type="button"
                className="btn btn-ghost"
                title="Ten streets in downtown Cincinnati, with the intersections already designed"
                onClick={() => loadDemo('cincinnati')}
              >
                Load example
              </button>
              <button type="button" className="btn btn-ghost" onClick={clearStreets}>
                Clear all
              </button>
            </div>
          </section>
        )}

        {railTab === 'land' && (
          <section className="panel">
            <header className="panel-head">
              <span className="label">Land cover</span>
              <span className="label mono">{areas.length}</span>
            </header>
            {areas.length === 0 ? (
              <p className="empty-note">
                None yet. Choose <b>Land</b> above the map to cover ground with grass, plaza,
                water and the rest.
              </p>
            ) : (
              <ul className="cards">
                {areas.map((a) => (
                  <li key={a.id}>
                    <div className={`street-card${a.id === selectedAreaId ? ' is-active' : ''}`}>
                      <button
                        type="button"
                        className="card street-card-main"
                        onClick={() => selectArea(a.id)}
                        onDoubleClick={() => mapRef.current?.zoomTo(a.ring)}
                      >
                        <span className="card-title">{a.name}</span>
                        <span className="card-meta">
                          <span>
                            <i
                              className="swatch swatch-inline"
                              style={{ background: LANDCOVERS[a.landcover].color }}
                            />
                            {LANDCOVERS[a.landcover].label}
                          </span>
                          <span className="mono">{a.ring.length} pts</span>
                        </span>
                      </button>
                      <div className="street-card-tools">
                        <button
                          type="button"
                          className="icon-btn"
                          title={a.visible ? 'Hide' : 'Show'}
                          aria-label={a.visible ? `Hide ${a.name}` : `Show ${a.name}`}
                          onClick={() => toggleAreaVisible(a.id)}
                        >
                          {a.visible ? '◉' : '○'}
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Zoom to"
                          aria-label={`Zoom to ${a.name}`}
                          onClick={() => mapRef.current?.zoomTo(a.ring)}
                        >
                          ⤢
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Duplicate"
                          aria-label={`Duplicate ${a.name}`}
                          onClick={() => duplicateArea(a.id)}
                        >
                          ⧉
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Delete"
                          aria-label={`Delete ${a.name}`}
                          onClick={() => removeArea(a.id)}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {railTab === 'junctions' && (
          <section className="panel">
            <header className="panel-head">
              <span className="label">Intersections</span>
              <span className="label mono">{junctions.length}</span>
            </header>

            {/* Which model is in charge. Placed nodes always win where they sit; this
                decides whether anything happens where they do not. */}
            <div className="form-row" role="group" aria-label="How intersections are decided">
              {(
                [
                  ['auto', 'Found automatically'],
                  ['nodes', 'Only where I place one'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className="btn btn-ghost"
                  aria-pressed={junctionMode === mode}
                  onClick={() => setJunctionMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>

            {selectedJunction && !selectedJunction.nodeId && (
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  title="Take ownership of this one crossing, so you can drag it, disable it or keep its design when the streets change"
                  onClick={() => {
                    placeNodeAt(selectedJunction.position);
                    setNotice({
                      kind: 'success',
                      title: 'This intersection is yours now',
                      details: ['Drag it, rename it, disable it, or delete it to hand it back.'],
                    });
                  }}
                >
                  Make this one mine
                </button>
              </div>
            )}
            <p className="hint">
              {junctionMode === 'nodes'
                ? 'Nothing is an intersection unless you put one there. Two roads that cross without a node simply overlap.'
                : 'Crossings become intersections on their own. Anywhere you place a node, the node is in charge instead — including a node set to no junction, which is how two roads cross without meeting.'}
            </p>
            {nodes.length > 0 && (
              <ul className="cards" style={{ marginTop: 9 }}>
                {nodes.map((node, index) => (
                  <li key={node.id}>
                    <div className={`street-card${node.id === selectedNodeId ? ' is-active' : ''}`}>
                      <button
                        type="button"
                        className="card street-card-main"
                        onClick={() => selectNode(node.id)}
                        onDoubleClick={() => mapRef.current?.zoomTo([node.position])}
                      >
                        <span className="card-title">
                          {node.name || `Intersection ${index + 1}`}
                        </span>
                        <span className="card-meta">
                          <span>
                            {node.disabled
                              ? 'no junction — the roads just cross'
                              : (junctions.find((j) => j.nodeId === node.id)?.legCount ?? 0) +
                                ' legs'}
                          </span>
                          <span className="mono">placed</span>
                        </span>
                      </button>
                      <div className="street-card-tools">
                        <button
                          type="button"
                          className="icon-btn"
                          title={node.disabled ? 'Make it a junction again' : 'No junction here'}
                          aria-label={node.disabled ? 'Enable' : 'Disable'}
                          onClick={() => toggleNodeDisabled(node.id)}
                        >
                          {node.disabled ? '○' : '◉'}
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Zoom to"
                          aria-label="Zoom to"
                          onClick={() => mapRef.current?.zoomTo([node.position])}
                        >
                          ⤢
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Delete"
                          aria-label="Delete"
                          onClick={() => removeNode(node.id)}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {selectedNode && (
              <label className="field" style={{ marginTop: 9 }}>
                <span className="label">Name this intersection</span>
                <input
                  className="text-input"
                  value={selectedNode.name ?? ''}
                  placeholder="Fifth and Race"
                  onChange={(e) => renameNode(selectedNode.id, e.target.value)}
                />
              </label>
            )}

            {/* Loose ends first, above the junctions that DID form. An end that does not
                meet anything is the reason a junction is missing from the list below, so
                reading the list without it is reading half the story. */}
            {loosePlan.length > 0 && (
              <div className="loose-note">
                <p>
                  <b>
                    {loosePlan.length} street end{loosePlan.length === 1 ? '' : 's'}
                  </b>{' '}
                  {loosePlan.length === 1 ? 'does' : 'do'} not quite meet what{' '}
                  {loosePlan.length === 1 ? 'it was' : 'they were'} drawn to meet — ringed in
                  orange on the map. Until they do, an overshoot reads as an extra leg and a
                  gap reads as no junction at all.
                </p>
                <ul className="loose-list">
                  {loosePlan.map((c) => (
                    <li key={`${c.streetId}:${c.end}`}>
                      <button
                        type="button"
                        className="loose-zoom"
                        title="Show me where"
                        onClick={() => mapRef.current?.zoomTo([c.point])}
                      >
                        {streetNames[c.streetId] ?? 'Street'} <span className="mono">{c.label}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => handleConnect(c)}
                      >
                        Join
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {junctions.length === 0 && nodes.length === 0 ? (
              <p className="empty-note">
                None yet. Draw two streets that cross, or use the <b>Intersection</b> tool to
                place one exactly where you want it.
              </p>
            ) : (
              <ul className="cards">
                {junctions.map((j) => (
                  <li key={j.key}>
                    <button
                      type="button"
                      className={`card${j.key === selectedJunctionKey ? ' is-active' : ''}`}
                      onClick={() => selectJunction(j.key)}
                      onDoubleClick={() => mapRef.current?.zoomTo([j.position])}
                    >
                      <span className="card-title">
                        {j.legs
                          .map((leg) => streetNames[leg.streetId] ?? 'Street')
                          .filter((name, i, all) => all.indexOf(name) === i)
                          .join(' × ')}
                      </span>
                      <span className="card-meta">
                        <span>
                          {j.legCount} legs · {j.form === 'merge' ? 'merge' : j.kind}
                        </span>
                        <span className="mono">
                          {formatWidth(
                            Math.max(...j.legs.map((l) => l.crossingDistanceMeters)),
                            units,
                            { withUnit: true },
                          )}{' '}
                          max crossing
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={trimAtJunctions}
                onChange={(e) => setTrimAtJunctions(e.target.checked)}
              />
              <span>Trim streets at intersections</span>
            </label>

            <label className="field" style={{ marginTop: 9 }}>
              <span className="label">
                Merge nearby crossings <span className="mono">{junctionMergeSlackMeters} m</span>
              </span>
              <input
                type="range"
                min={-12}
                max={30}
                step={1}
                value={junctionMergeSlackMeters}
                onChange={(e) => setJunctionMergeSlack(Number(e.target.value))}
              />
              <span className="hint">
                Two crossings inside one street&rsquo;s width are treated as one junction, which
                is right nearly always. Push this up for a plaza that reads as a single place,
                and down to keep a staggered pair of T&rsquo;s apart.
              </span>
            </label>
          </section>
        )}

        {railTab === 'sections' && (
          <section className="panel">
            <header className="panel-head">
              <span className="label">Cross-sections</span>
              <span className="label">apply to the selected street</span>
            </header>
            <TemplatePicker
              recent={recentTemplateIds}
              units={units}
              disabled={!street}
              onPick={(t) => applyTemplate('street', t.id)}
            />
          </section>
        )}

        </div>
      </aside>

      {/* -------------------------------------------------------------------- stage */}
      <main className="stage">
        <NoticeBar notice={notice} onDismiss={() => setNotice(null)} />

        {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}

        <div className="map-wrap" ref={mapWrapRef}>
          {/* Rendered only when the active tool has something to say — an empty strip
              sitting over the imagery is worse than no strip. In select mode that means
              once something is selected, where the point controls become relevant. */}
          {(tool !== 'select' || street || area) && (
          <div className="toolbar is-floating">
            {tool === 'draw' && (
              <>
                <label className="control">
                  <span className="label">Section</span>
                  <select
                    className="select"
                    value={drawSectionId}
                    onChange={(e) => setDrawSectionId(e.target.value)}
                  >
                    {TEMPLATE_CATEGORIES.map((group) => (
                      <optgroup key={group.id} label={group.label}>
                        {TEMPLATES.filter((t) => t.category === group.id).map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    <option value={DRAFT_SECTION}>Asset builder — {draftSection.name}</option>
                  </select>
                </label>
                <div className="segmented" role="group" aria-label="Segment shape">
                  {(
                    [
                      ['straight', 'Straight', 'S'],
                      ['curved', 'Arc', 'C'],
                    ] as const
                  ).map(([mode, label, key]) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={segmentMode === mode}
                      title={
                        mode === 'straight'
                          ? 'Each point placed stays a hard corner (S)'
                          : 'The line curves through each point placed, at the radius below (C)'
                      }
                      onClick={() => setSegmentMode(mode)}
                    >
                      {label} <span className="dock-key mono">{key}</span>
                    </button>
                  ))}
                </div>

                {segmentMode === 'curved' && (
                  <label className="control">
                    <span className="label">Radius ({units})</span>
                    <input
                      className="text-input mono"
                      style={{ width: 72 }}
                      type="number"
                      min={1}
                      step={stepFor(units)}
                      value={formatWidth(drawRadiusMeters, units, { decimals: 0 })}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        if (!Number.isFinite(value) || value <= 0) return;
                        setDrawRadius(displayToMetres(value, units));
                      }}
                    />
                  </label>
                )}

                  <span className="pill pill-note mono">
                    {draft.points} pt ·{' '}
                    {formatWidth(draft.metres, units, { decimals: 0, withUnit: true })}
                  </span>
                <button
                  type="button"
                  className="btn btn-solid"
                  disabled={draft.points < 2}
                  onClick={() => mapRef.current?.finishDraw()}
                >
                  Finish
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={draft.points === 0}
                  onClick={() => mapRef.current?.undoDraftPoint()}
                >
                  Undo point
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={draft.points === 0}
                  title="Throw the line away and start again (Esc)"
                  onClick={() => mapRef.current?.cancelDraw()}
                >
                  Cancel
                </button>
                <label className="control control-inline">
                  <input
                    type="checkbox"
                    checked={autoConnect}
                    onChange={(e) => setAutoConnect(e.target.checked)}
                  />
                  <span
                    className="label"
                    title="When a line finishes near a street it was aiming at, its end is moved onto that street so the two really meet"
                  >
                    Join ends
                  </span>
                </label>
              </>
            )}

            {tool === 'area' && (
              <>
                <label className="control">
                  <span className="label">Land type</span>
                  <LandcoverPalette
                    value={drawLandcover}
                    onChange={setDrawLandcover}
                    variant="compact"
                  />
                </label>
                <span className="pill pill-note mono">{draft.points} pt</span>
                <button
                  type="button"
                  className="btn btn-solid"
                  disabled={draft.points < 3}
                  onClick={() => mapRef.current?.finishDraw()}
                >
                  Close shape
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={draft.points === 0}
                  onClick={() => mapRef.current?.undoDraftPoint()}
                >
                  Undo point
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={draft.points === 0}
                  title="Throw the shape away and start again (Esc)"
                  onClick={() => mapRef.current?.cancelDraw()}
                >
                  Cancel
                </button>
              </>
            )}

            {tool === 'select' && (street || area) && (
              <>
                <div className="segmented" role="group" aria-label="What a click on a point does">
                  {(
                    [
                      ['move', 'Move', 'Drag a point to reshape the line'],
                      ['sharp', 'Pin corner', 'Click a point to keep it a hard corner through a curve'],
                      ['remove', 'Remove', 'Click a point to take it out of the line'],
                    ] as const
                  ).map(([mode, label, hint]) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={pointAction === mode}
                      title={hint}
                      onClick={() => setPointAction(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {street &&
                  loosePlan
                    .filter((c) => c.streetId === street.id)
                    .map((c) => (
                      <button
                        key={c.end}
                        type="button"
                        className="btn btn-ghost"
                        title={c.label}
                        onClick={() => handleConnect(c)}
                      >
                        Join {c.end === 'start' ? 'start' : 'end'}
                      </button>
                    ))}

                <span className="pill pill-note">
                  {pointAction === 'move'
                    ? 'drag a point · Alt-click removes · Shift-click pins'
                    : pointAction === 'sharp'
                      ? 'click a point to pin it as a corner'
                      : 'click a point to remove it'}
                </span>
              </>
            )}

            {tool === 'measure' && (
              <>
                <span className="pill pill-note mono">
                  {measure && measure.points >= 2
                    ? formatWidth(measure.metres, units, { withUnit: true })
                    : 'click two points'}
                </span>
                <button
                  type="button"
                  className="btn btn-solid"
                  disabled={!street || !measure || measure.points < 2 || measure.metres <= 0}
                  onClick={() => {
                    if (!street || !measure) return;
                    setExistingWidth(street.id, measure.metres);
                    setNotice({
                      kind: 'success',
                      title: `Right-of-way set to ${formatWidth(measure.metres, units, {
                        withUnit: true,
                      })}`,
                    });
                  }}
                >
                  Use as right-of-way
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => mapRef.current?.clearMeasure()}
                >
                  Clear
                </button>
              </>
            )}

          </div>
          )}
          <MapDock
            tools={TOOLS}
            activeTool={tool}
            onTool={(id) => setTool(id as Tool)}
            railOpen={railOpen}
            onRail={setRailOpen}
            actions={[
              {
                id: 'deselect',
                label: 'Deselect',
                icon: '⊘',
                hint: 'Put down whatever is selected (Esc)',
                disabled: !street && !area && !selectedJunction && !selectedNodeId,
                onClick: clearSelection,
              },
              {
                id: 'frame',
                label: 'Frame the selection',
                icon: '⌖',
                hint: 'Zoom to whatever is selected',
                disabled: !street && !area && !selectedJunction && !selectedNode,
                onClick: () => {
                  if (selectedNode) mapRef.current?.zoomTo([selectedNode.position]);
                  else if (street) mapRef.current?.zoomTo(street.centerline);
                  else if (area) mapRef.current?.zoomTo(area.ring);
                  else if (selectedJunction) mapRef.current?.zoomTo([selectedJunction.position]);
                },
              },
              {
                id: 'connect',
                label:
                  loosePlan.length > 0
                    ? `${loosePlan.length} loose end${loosePlan.length === 1 ? '' : 's'}`
                    : 'Every end is joined',
                icon: '⚯',
                hint:
                  loosePlan.length > 0
                    ? 'Go to the next end that does not meet what it was drawn to meet'
                    : 'No street ends are left hanging',
                disabled: loosePlan.length === 0,
                // Takes you there rather than fixing it from across the map: each of these
                // is a judgement about a specific corner, and it should be made looking at
                // that corner.
                onClick: () => {
                  const next = loosePlan[0];
                  if (!next) return;
                  selectStreet(next.streetId);
                  setRailTab('junctions');
                  mapRef.current?.zoomTo([next.point]);
                },
              },
              {
                id: 'duplicate',
                label: 'Duplicate',
                icon: '⧉',
                hint: 'Copy the selected street or land cover',
                disabled: !street && !area,
                onClick: () => {
                  if (street) duplicateStreet(street.id);
                  else if (area) duplicateArea(area.id);
                },
              },
              {
                id: 'mirror',
                label: 'Mirror the section',
                icon: '⇄',
                hint: 'Flip the cross-section end for end',
                disabled: !street,
                onClick: () => mirrorSection('street'),
              },
              {
                id: 'hide',
                label: street?.visible === false || area?.visible === false ? 'Show' : 'Hide',
                icon: street?.visible === false || area?.visible === false ? '○' : '◉',
                hint: 'Hide it without deleting it',
                disabled: !street && !area,
                onClick: () => {
                  if (street) toggleStreetVisible(street.id);
                  else if (area) toggleAreaVisible(area.id);
                },
              },
              {
                id: 'delete',
                label: 'Delete',
                icon: '×',
                hint: 'Remove the selection (Del). Ctrl+Z brings it back.',
                danger: true,
                disabled: !street && !area && !selectedNodeId,
                onClick: deleteSelection,
              },
            ]}
            history={[
              {
                id: 'shortcuts',
                label: 'Keyboard shortcuts',
                icon: '?',
                hint: 'Every shortcut, and the button that does the same thing',
                onClick: () => setShortcutsOpen(true),
              },
              {
                id: 'undo',
                label: 'Undo',
                icon: '↶',
                hint: 'Ctrl+Z',
                disabled: !canUndo,
                onClick: undo,
              },
              {
                id: 'redo',
                label: 'Redo',
                icon: '↷',
                hint: 'Ctrl+Shift+Z',
                disabled: !canRedo,
                onClick: redo,
              },
            ]}
          />

          <MapViewControls
            visibility={layerVisibility}
            onVisibility={setLayerVisible}
            imageryOpacity={imageryOpacity}
            onImageryOpacity={setImageryOpacity}
            onZoom={(delta) => mapRef.current?.zoomBy(delta)}
            onFitAll={() => mapRef.current?.zoomToAll()}
            swipe={swipe}
            onSwipe={setSwipe}
          />

          <MapCanvas
            ref={mapRef}
            basemapId={basemapId}
            sourceOptions={sourceOptions}
            units={units}
            streets={streets}
            selectedStreetId={selectedStreetId}
            tool={tool}
            swipe={swipe}
            center={DEMO_CENTER}
            zoom={DEMO_ZOOM}
            onViewChange={viewSource.publish}
            onSelectStreet={selectStreet}
            onSelectJunction={selectJunction}
            onWarnings={setWarnings}
            onJunctions={(list, _warnings, pairs) => {
              setJunctions(list);
              setOffsetPairs(pairs);
            }}
            junctionOverrides={junctionOverrides}
            defaultCornerRadiusMeters={defaultCornerRadiusMeters}
            trimAtJunctions={trimAtJunctions}
            junctionMergeSlackMeters={junctionMergeSlackMeters}
            showAllCenterlines={showAllCenterlines}
            nodes={nodes}
            junctionMode={junctionMode}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
            onPlaceNode={(position) => addNode(position)}
            onMoveNode={moveNodeLive}
            onClearSelection={clearSelection}
            onDeleteSelection={deleteSelection}
            layerVisibility={layerVisibility}
            imageryOpacity={imageryOpacity}
            selectedJunctionKey={selectedJunctionKey}
            onDraftChange={(points, metres) => setDraft({ points: points.length, metres })}
            segmentMode={segmentMode}
            drawRadiusMeters={drawRadiusMeters}
            looseEnds={looseEndPoints}
            pointAction={pointAction}
            onDrawComplete={(points, sharpVertices) =>
              addStreet(points, {
                // Every point pinned means the line is straight throughout, and saying so
                // keeps a plain polyline out of the curve machinery entirely.
                mode: sharpVertices.length === points.length ? 'straight' : 'rounded',
                radiusMeters: drawRadiusMeters,
                ...(sharpVertices.length > 0 ? { sharpVertices } : {}),
              })
            }
            onGestureStart={beginGesture}
            onGestureEnd={endGesture}
            areas={areas}
            selectedAreaId={selectedAreaId}
            onSelectArea={selectArea}
            onAreaComplete={(ring) => addArea(ring)}
            onVertexMove={(kind: EntityKind, id, index, point) =>
              kind === 'area'
                ? moveAreaVertexLive(id, index, point)
                : moveVertexLive(id, index, point)
            }
            onVertexInsert={(kind: EntityKind, id, index, point) =>
              kind === 'area'
                ? insertAreaVertexLive(id, index, point)
                : insertVertexLive(id, index, point)
            }
            onVertexDelete={(kind: EntityKind, id, index) =>
              kind === 'area' ? removeAreaVertex(id, index) : removeVertex(id, index)
            }
            onVertexSharp={(kind: EntityKind, id, index) =>
              kind === 'area' ? toggleAreaSharpVertex(id, index) : toggleSharpVertex(id, index)
            }
            onMeasureChange={(points, metres) => setMeasure({ points: points.length, metres })}
            onRenderStats={setRenderStats}
          />

          {swipe !== null && (
            <div
              className="swipe-divider"
              style={{ left: `${swipe * 100}%` }}
              onPointerDown={startSwipeDrag}
              role="separator"
              aria-label="Before and after divider"
              aria-valuenow={Math.round(swipe * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') setSwipe(Math.max(0.02, swipe - 0.02));
                if (e.key === 'ArrowRight') setSwipe(Math.min(0.98, swipe + 0.02));
              }}
            >
              <span className="swipe-handle" aria-hidden="true">
                ⇄
              </span>
              <span className="swipe-tag swipe-tag-left">existing</span>
              <span className="swipe-tag swipe-tag-right">redesign</span>
            </div>
          )}

          {/* What is selected, and the number the design has to answer to, under the
              thing it describes rather than in a panel a glance away. */}
          {(tool === 'select' || tool === 'node') &&
            (street || area || selectedJunction || selectedNode) && (
            <SelectionStrip
              units={units}
              kind={
                selectedNode ? 'node' : street ? 'street' : area ? 'land' : 'junction'
              }
              name={
                selectedNode?.name ||
                (selectedNode ? 'Intersection' : undefined) ||
                street?.name ||
                area?.name ||
                (selectedJunction
                  ? selectedJunction.legs
                      .map((leg) => streetNames[leg.streetId] ?? 'Street')
                      .filter((n, i, all) => all.indexOf(n) === i)
                      .join(' × ')
                  : '')
              }
              section={street?.section ?? null}
              fit={street ? fit : null}
              crossingMeters={
                selectedJunction
                  ? Math.max(...selectedJunction.legs.map((l) => l.crossingDistanceMeters))
                  : null
              }
              onRename={
                selectedNode
                  ? (value) => renameNode(selectedNode.id, value)
                  : street
                    ? (value) => renameStreet(street.id, value)
                    : area
                      ? (value) => renameArea(area.id, value)
                      : undefined
              }
              onOpenPanel={() => setRailOpen(true)}
              onClear={clearSelection}
              onDelete={selectedNode || street || area ? deleteSelection : undefined}
              extra={
                selectedNode ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    aria-pressed={selectedNode.disabled === true}
                    title="Two roads that cross without meeting"
                    onClick={() => toggleNodeDisabled(selectedNode.id)}
                  >
                    {selectedNode.disabled ? 'No junction' : 'Junction'}
                  </button>
                ) : null
              }
            />
          )}

          {/* Only while a modal tool is active — a permanent hint just covers imagery. */}
          {tool !== 'select' && (
            <div className="map-overlay-tl">
              <div className="pill pill-note">{activeTool.hint}</div>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="map-overlay-tr">
              <div className="pill pill-warn">
                <strong>Tight bend</strong>
                <span>{describeWarnings(warnings[0]!.warnings)}</span>
              </div>
            </div>
          )}
        </div>

        <footer className="statusbar">
          <ViewReadout source={viewSource}>
            {(view) => (
              <>
                <div className="cell">
                  <span className="label">Center</span>
                  <b className="mono">
                    {view ? `${view.lat.toFixed(5)}, ${view.lng.toFixed(5)}` : '—'}
                  </b>
                </div>
                <div className="cell">
                  <span className="label">Zoom</span>
                  <b className="mono">{view ? `z${view.zoom.toFixed(1)}` : '—'}</b>
                </div>
              </>
            )}
          </ViewReadout>
          {[
            ['Imagery', basemap.label],
            ['Street', street?.name ?? '—'],
            [
              'Section',
              section
                ? `${section.components.length} bands · ${formatWidth(total, units, { withUnit: true })}`
                : '—',
            ],
            [
              'Rendered',
              // Reports the difference between "no geometry" and "geometry that never
              // reached the GPU" — otherwise both look like an empty map.
              renderStats
                ? renderStats.rendered > 0
                  ? `${renderStats.bands} bands`
                  : `${renderStats.bands} bands · not drawn (source loaded: ${renderStats.sourceLoaded})`
                : '—',
            ],
            [
              'Junctions',
              junctions.length === 0
                ? 'none'
                : `${junctions.length} · ${junctions.reduce((n, j) => n + j.legCount, 0)} legs`,
            ],
          ].map(([k, v]) => (
            <div className="cell" key={k}>
              <span className="label">{k}</span>
              <b className="mono">{v}</b>
            </div>
          ))}
        </footer>
      </main>

      {/* --------------------------------------------------------------- right rail */}
      <aside className="rail rail-right">
        {area ? (
          <>
            <section className="panel">
              <header className="panel-head">
                <span className="label">Land cover</span>
                <span className="label mono">{area.ring.length} points</span>
              </header>
              <input
                className="text-input"
                value={area.name}
                aria-label="Area name"
                onChange={(e) => renameArea(area.id, e.target.value)}
              />
              <p className="hint">
                Drag a point to reshape, alt-click to remove it, or drag a hollow handle
                between two to add one. {LANDCOVERS[area.landcover].note}
              </p>
            </section>

            <section className="panel">
              <header className="panel-head">
                <span className="label">Edge</span>
              </header>
              <div className="segmented" role="group" aria-label="Area edge">
                {CURVE_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={(area.curve?.mode ?? 'straight') === mode.id}
                    title={mode.hint}
                    onClick={() => setAreaCurve(area.id, { mode: mode.id })}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              {(area.curve?.mode ?? 'straight') === 'rounded' && (
                <label className="field" style={{ marginTop: 9 }}>
                  <span className="label">Corner radius ({units})</span>
                  <input
                    className="text-input mono"
                    type="number"
                    min={0}
                    step={stepFor(units)}
                    value={formatWidth(
                      area.curve?.radiusMeters ?? DEFAULT_CURVE.radiusMeters,
                      units,
                      { decimals: 0 },
                    )}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (!Number.isFinite(value) || value < 0) return;
                      setAreaCurve(area.id, { radiusMeters: displayToMetres(value, units) });
                    }}
                  />
                </label>
              )}
            </section>

            <section className="panel">
              <header className="panel-head">
                <span className="label">Material</span>
              </header>
              <LandcoverPalette
                value={area.landcover}
                onChange={(type) => setAreaLandcover(area.id, type)}
              />
            </section>
          </>
        ) : selectedJunction ? (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => selectJunction(null)}
            >
              ← Back to the street
            </button>
            <JunctionInspector
              junction={selectedJunction}
              sections={streetSections}
              offsetNeighbours={offsetNeighbours}
              units={units}
              streetNames={streetNames}
              override={junctionOverrides[selectedJunction.key]}
              onCorner={(index, patch) => updateCorner(selectedJunction.key, index, patch)}
              onLeg={(index, patch) => updateLeg(selectedJunction.key, index, patch)}
              onForm={(patch) => setJunctionForm(selectedJunction.key, patch)}
              onReset={() => resetJunction(selectedJunction.key)}
            />
          </>
        ) : !street || !section ? (
          <section className="panel">
            <p className="empty-note">
              Select a street to edit its cross-section, or draw a new one.
            </p>
          </section>
        ) : (
          <>
            <section className="panel">
              <header className="panel-head">
                <span className="label">Street</span>
                <span className="label mono">
                  {formatWidth(lineLengthMeters(resolveCenterline(street)), units, {
                    decimals: 0,
                    withUnit: true,
                  })}
                </span>
              </header>
              <input
                className="text-input"
                value={street.name}
                aria-label="Street name"
                onChange={(e) => renameStreet(street.id, e.target.value)}
              />
              <p className="hint">
                {street.centerline.length} control points. Drag one to reshape, alt-click to
                remove it, or drag a hollow handle between two to add one.
              </p>
            </section>

            <section className="panel">
              <header className="panel-head">
                <span className="label">Alignment</span>
                {curveMode !== 'straight' && Number.isFinite(actualRadius) && (
                  <span className="label mono" title="Tightest radius actually on the line">
                    R {formatWidth(actualRadius, units, { decimals: 0, withUnit: true })}
                  </span>
                )}
              </header>

              <div className="segmented" role="group" aria-label="Centerline alignment">
                {CURVE_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    aria-pressed={curveMode === mode.id}
                    title={mode.hint}
                    onClick={() => setCurve(street.id, { mode: mode.id })}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              {curveMode === 'rounded' && (
                <label className="field" style={{ marginTop: 9 }}>
                  <span className="label">Corner radius ({units})</span>
                  <input
                    className="text-input mono"
                    type="number"
                    min={0}
                    step={stepFor(units)}
                    value={formatWidth(street.curve?.radiusMeters ?? DEFAULT_CURVE.radiusMeters, units, {
                      decimals: 0,
                    })}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (!Number.isFinite(value) || value < 0) return;
                      setCurve(street.id, { radiusMeters: displayToMetres(value, units) });
                    }}
                  />
                  <span className="hint">
                    A corner is clamped to the largest arc its two segments can carry, so the
                    radius above is what was asked for and the R in the header is what you got.
                  </span>
                </label>
              )}

              <label className="field" style={{ marginTop: 9 }}>
                <span className="label">Level, end to end</span>
                <select
                  className="text-input"
                  value={street.grade ? 'profile' : String(street.level ?? 0)}
                  onChange={(e) => {
                    if (e.target.value === 'profile') return;
                    setStreetLevel(street.id, Number(e.target.value));
                  }}
                >
                  <option value={-1}>Tunnel — below grade</option>
                  <option value={0}>At grade</option>
                  <option value={1}>Overpass — above grade</option>
                  {street.grade && (
                    <option value="profile">Rises and falls — set per crossing below</option>
                  )}
                </select>
                <span className="hint">
                  For a street that is elevated its whole length. One that climbs over a
                  single road and comes back down is set crossing by crossing, below.
                </span>
              </label>

              {/* -------------------------------------------------- grade separation */}
              {crossingsAlong.length > 0 && (
                <div className="field" style={{ marginTop: 11 }}>
                  <span className="label">Crossings along this street</span>
                  <p className="hint" style={{ marginTop: 2 }}>
                    Carry it over or under any one of these. The ramps either side are part
                    of the profile, so the road comes back to ground before the next
                    crossing — which is what makes this an interchange rather than a
                    viaduct.
                  </p>
                  <ul className="grade-list">
                    {crossingsAlong.map((c) => (
                      <li key={c.key}>
                        <button
                          type="button"
                          className="grade-where"
                          title="Show me this crossing"
                          onClick={() => {
                            selectJunction(c.key);
                            mapRef.current?.zoomTo([c.position]);
                          }}
                        >
                          <span>{c.label}</span>
                          <span className="mono">
                            {formatWidth(c.stationMeters, units, { decimals: 0, withUnit: true })}{' '}
                            along
                          </span>
                        </button>
                        <div className="segmented grade-pick" role="group" aria-label="Grade">
                          {(
                            [
                              [-1, '↓', 'Run under it'],
                              [0, '—', 'Meet it at grade'],
                              [1, '↑', 'Carry over it'],
                            ] as const
                          ).map(([dir, glyph, hint]) => (
                            <button
                              key={dir}
                              type="button"
                              aria-pressed={Math.round(c.level) === dir}
                              title={hint}
                              onClick={() => {
                                if (dir === 0) setStreetGrade(street.id, null);
                                else gradeSeparateAt(street.id, c.stationMeters, dir);
                              }}
                            >
                              {glyph}
                            </button>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {curveMode !== 'straight' && (
                <p className="hint">
                  Shift-click a control point to pin it as a hard corner — useful where a
                  street curves through a bend but has to turn square at a junction.
                  {sharpCount > 0 && ` ${sharpCount} pinned.`}
                </p>
              )}
            </section>

            <section className="panel">
              <header className="panel-head">
                <span className="label">Fit check</span>
                <span className="label">vs measured right-of-way</span>
              </header>

              {fit && (
                <div className="fit">
                  <div className="fit-top">
                    <span
                      className="fit-value mono"
                      style={{ color: fit.fits ? 'var(--good)' : 'var(--bad)' }}
                    >
                      {formatWidth(total, units, { withUnit: true })}
                    </span>
                    <span
                      className="fit-verdict"
                      style={{ color: fit.fits ? 'var(--good)' : 'var(--bad)' }}
                    >
                      {fit.fits
                        ? `Fits · ${formatWidth(Math.abs(fit.differenceMeters), units, { withUnit: true })} spare`
                        : `Over by ${formatWidth(Math.abs(fit.differenceMeters), units, { withUnit: true })}`}
                    </span>
                  </div>
                  <div className="fit-track">
                    <div
                      className="fit-bar"
                      style={{
                        width: `${Math.min((total / Math.max(available || total, 0.01)) * 100, 100)}%`,
                        background: fit.fits ? 'var(--good-fill)' : 'var(--bad-fill)',
                      }}
                    />
                  </div>
                  <div className="fit-caption">
                    <span>designed</span>
                    <span className="mono">
                      available {formatWidth(available || total, units, { withUnit: true })}
                    </span>
                  </div>

                  {available > 0 && Math.abs(fit.differenceMeters) > 0.05 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-block"
                      style={{ marginTop: 9 }}
                      onClick={() => fitSectionToWidth('street', available)}
                    >
                      Scale section to {formatWidth(available, units, { withUnit: true })}
                    </button>
                  )}
                </div>
              )}

              <label className="field" style={{ marginTop: 11 }}>
                <span className="label">Measured right-of-way ({units})</span>
                <input
                  className="text-input mono"
                  type="number"
                  min={1}
                  step={stepFor(units)}
                  value={formatWidth(available, units)}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0) return;
                    setExistingWidth(street.id, displayToMetres(v, units));
                  }}
                />
                <span className="hint">
                  Curb-to-curb of the real street — the Measure tool fills this in. The
                  redesign is honest only if this is.
                </span>
              </label>
            </section>

            <section className="panel">
              <header className="panel-head">
                <span className="label">Anchor</span>
              </header>
              <select
                className="text-input"
                value={anchorModeOf(section)}
                onChange={(e) => setAnchorMode('street', e.target.value as AnchorMode)}
              >
                <option value="travelway">
                  Travelway centre — {formatWidth(resolveAnchorOffset(section), units, { withUnit: true })} from left
                </option>
                <option value="geometric">Geometric centre of section</option>
                <option value="leftEdge">Left edge of section</option>
                {anchorModeOf(section) === 'custom' && <option value="custom">Custom offset</option>}
              </select>
              <p className="hint">
                Where the drawn line sits within the section. Travelway centre lands it on the
                double-yellow you can actually see on the imagery.
              </p>
            </section>

            <section className="panel">
              <header className="panel-head">
                <span className="label">Components · left → right</span>
                <span className="label mono">{section.components.length}</span>
              </header>
              <ComponentStack
                components={section.components}
                units={units}
                selectedId={selectedComponentId}
                onSelect={selectComponent}
                onWidth={(id, m) => setWidth('street', id, m)}
                onDirection={(id, d) => setDirection('street', id, d)}
                onMove={(id, delta) => moveComponent('street', id, delta)}
                onRemove={(id) => removeComponent('street', id)}
                onDuplicate={(id) => duplicateComponent('street', id)}
                onMarkings={(id, patch) => setComponentMarkings('street', id, patch)}
              />
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => mirrorSection('street')}
                >
                  Mirror the section
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!street?.existingWidthMeters}
                  title="Scale every band so the section matches the width you measured"
                  onClick={() =>
                    street?.existingWidthMeters &&
                    fitSectionToWidth('street', street.existingWidthMeters)
                  }
                >
                  Fit to measured width
                </button>
              </div>
            </section>

            <section className="panel">
              <header className="panel-head">
                <span className="label">Add a band</span>
              </header>
              <PrimitivePalette
                units={units}
                recent={recentComponentTypes}
                onAdd={(type) => addComponent('street', type)}
              />
              <p className="hint">
                Added just inside the right-hand kerb. Reorder with the arrows above.
              </p>
            </section>

            <section className="panel">
              <header className="panel-head">
                <span className="label">Cross-section</span>
              </header>
              <div className="section-preview">
                <CrossSectionSvg
                  section={section}
                  units={units}
                  variant="compact"
                  selectedId={selectedComponentId}
                  onSelect={selectComponent}
                />
              </div>
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

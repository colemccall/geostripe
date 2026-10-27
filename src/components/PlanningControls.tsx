import { LAND_USES, LAND_USE_CATEGORIES, LAND_USE_IDS } from '../library/landuse';
import { BUILDING_TYPES, BUILDING_TYPE_IDS } from '../library/buildingTypes';
import { useEditorStore } from '../store/useEditorStore';
import { formatLength } from '../lib/units';
import type { DisplayUnits } from '../lib/units';

/**
 * The controls for the planning tools, floating above the build menu while one is armed.
 *
 * Zoning, buildings and districts are not road families, so they do not use the asset
 * drawer; each gets the handful of controls it actually has. Everything here is state in the
 * store, so the keyboard (`E`, `[`, `]`, `R`) and these buttons stay in step.
 */

function BrushRow({ units }: { units: DisplayUnits }) {
  const paintMode = useEditorStore((s) => s.paintMode);
  const radius = useEditorStore((s) => s.brushRadiusMeters);
  const eraseMode = useEditorStore((s) => s.eraseMode);
  const { setPaintMode, setBrushRadius, setEraseMode } = useEditorStore.getState();

  return (
    <div className="pp-row">
      <div className="pp-seg" role="group" aria-label="Paint mode">
        <button type="button" aria-pressed={paintMode === 'brush'} onClick={() => setPaintMode('brush')}>
          Brush
        </button>
        <button type="button" aria-pressed={paintMode === 'outline'} onClick={() => setPaintMode('outline')}>
          Outline
        </button>
        <button
          type="button"
          aria-pressed={paintMode === 'fill'}
          onClick={() => setPaintMode('fill')}
          title="Fill the whole block between roads with one click"
        >
          Fill block
        </button>
      </div>
      <button
        type="button"
        className={`pp-toggle${eraseMode ? ' is-on' : ''}`}
        aria-pressed={eraseMode}
        onClick={() => setEraseMode(!eraseMode)}
        title="Erase instead of paint (E)"
      >
        Erase
      </button>
      {paintMode === 'brush' && (
        <label className="pp-slider" title="Brush size ([ and ])">
          Size
          <input
            type="range"
            min={3}
            max={120}
            value={radius}
            onChange={(event) => setBrushRadius(Number(event.target.value))}
          />
          <span>{formatLength(radius, units)}</span>
        </label>
      )}
      {paintMode === 'outline' && <span className="pp-hint">Click corners, double-click or Enter to finish</span>}
      {paintMode === 'fill' && <span className="pp-hint">Click inside a block; the roads are left out</span>}
    </div>
  );
}

function ZoningControls({ units }: { units: DisplayUnits }) {
  const active = useEditorStore((s) => s.activeLandUse);
  const eraseMode = useEditorStore((s) => s.eraseMode);
  const setLandUse = useEditorStore((s) => s.setLandUse);

  return (
    <>
      <BrushRow units={units} />
      <div className="pp-groups">
        {LAND_USE_CATEGORIES.map((category) => (
          <div key={category.id} className="pp-group">
            <span className="pp-group-label">{category.label}</span>
            <div className="pp-chips">
              {LAND_USE_IDS.filter((id) => LAND_USES[id].category === category.id).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`pp-chip${active === id && !eraseMode ? ' is-active' : ''}`}
                  aria-pressed={active === id}
                  onClick={() => setLandUse(id)}
                  title={LAND_USES[id].note}
                >
                  <i style={{ background: LAND_USES[id].color }} />
                  {LAND_USES[id].label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function BuildingControls() {
  const active = useEditorStore((s) => s.activeBuildingType);
  const turn = useEditorStore((s) => s.buildingTurn);
  const { setBuildingType, turnBuilding } = useEditorStore.getState();

  return (
    <>
      <div className="pp-row">
        <button type="button" onClick={() => turnBuilding(-15)} title="Turn left">
          ⟲
        </button>
        <span className="pp-hint">Faces the nearest road · turned {turn}° · R turns 15°, Shift+R 1°</span>
        <button type="button" onClick={() => turnBuilding(15)} title="Turn right (R)">
          ⟳
        </button>
      </div>
      <div className="pp-chips">
        {BUILDING_TYPE_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={`pp-chip${active === id ? ' is-active' : ''}`}
            aria-pressed={active === id}
            onClick={() => setBuildingType(id)}
            title={`${BUILDING_TYPES[id].widthMetres} × ${BUILDING_TYPES[id].depthMetres} m`}
          >
            <i style={{ background: BUILDING_TYPES[id].color }} />
            {BUILDING_TYPES[id].label}
          </button>
        ))}
      </div>
    </>
  );
}

function DistrictControls({ units }: { units: DisplayUnits }) {
  const districts = useEditorStore((s) => s.doc.districts);
  const active = useEditorStore((s) => s.activeDistrictId);
  const { newDistrict, setActiveDistrict, renameDistrict, setDistrictColor } = useEditorStore.getState();
  const current = districts.find((d) => d.id === active);

  return (
    <>
      <BrushRow units={units} />
      <div className="pp-row">
        <button type="button" className="pp-toggle" onClick={newDistrict}>
          + New district
        </button>
        {current && (
          <>
            <input
              className="pp-name"
              type="text"
              value={current.name}
              aria-label="District name"
              onChange={(event) => renameDistrict(current.id, event.target.value)}
            />
            <input
              type="color"
              value={current.color}
              aria-label="District colour"
              onChange={(event) => setDistrictColor(current.id, event.target.value)}
            />
          </>
        )}
      </div>
      <div className="pp-chips">
        {districts.map((district) => (
          <button
            key={district.id}
            type="button"
            className={`pp-chip${district.id === active ? ' is-active' : ''}`}
            aria-pressed={district.id === active}
            onClick={() => setActiveDistrict(district.id)}
          >
            <i style={{ background: district.color }} />
            {district.name}
          </button>
        ))}
        {districts.length === 0 && <span className="pp-hint">No districts yet.</span>}
      </div>
    </>
  );
}

export default function PlanningControls({ units }: { units: DisplayUnits }) {
  const tool = useEditorStore((s) => s.tool);
  if (tool !== 'zone' && tool !== 'building' && tool !== 'district') return null;

  return (
    <div className="plan-panel" role="group" aria-label="Planning tool options">
      {tool === 'zone' && <ZoningControls units={units} />}
      {tool === 'building' && <BuildingControls />}
      {tool === 'district' && <DistrictControls units={units} />}
    </div>
  );
}

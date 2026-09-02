import cincinnati from './cincinnati.geojson?raw';
import i75 from './i75.geojson?raw';
import { parseProject } from '../model/project';
import { TEMPLATES, instantiateTemplate } from '../library/templates';
import type { JunctionOverride } from '../geo/derived';
import type { Area, Street } from '../model/types';

/**
 * Downtown Cincinnati — the baseline this editor is tuned against.
 *
 * Ten real streets traced off imagery, with the intersections already designed: corner
 * radii, crosswalks, stop bars. Unlike the two-street Washington Park demo, this is a
 * *project*, with the shapes real work produces — a smooth curved alignment traced through
 * eleven control points, staggered T's, a boulevard, junctions that share streets with
 * each other. Those are the shapes that expose cost: junction trimming is a polygon
 * boolean per band, and every street that meets a moved junction has to be re-clipped.
 *
 * Stored as the project file the editor writes, and loaded through the ordinary importer
 * rather than a bespoke reader. That way the demo exercises the round-trip on every load,
 * and a change that breaks reading projects breaks the demo loudly rather than quietly.
 *
 * The band polygons are stripped: they are a render product exported for QGIS and thrown
 * away on load anyway, and keeping them made the file sixty-nine times larger than the
 * design it describes. Coordinates are held to seven decimals — about a centimetre, which
 * is finer than the imagery this was traced from.
 */

export interface DemoProject {
  streets: Street[];
  areas: Area[];
  junctionOverrides: Record<string, JunctionOverride>;
  name: string;
}

/**
 * The I-75 alternative: two eight-lane mainlines and eight ramps.
 *
 * The freeway case, and the reason the cross-section had to be allowed to vary along a
 * street. These are interstates that cannot simply be joined at a node — where a ramp
 * leaves, the mainline carries fewer lanes afterwards than before, and that is one road
 * with one alignment and two widths rather than two roads meeting.
 */
export function createI75Project(): DemoProject {
  return load(i75, 'I-75 alternative');
}

function load(text: string, fallbackName: string): DemoProject {
  const fallback = instantiateTemplate(TEMPLATES[1]!);
  const parsed = parseProject(text, {
    sectionName: fallback.name,
    components: fallback.components,
  });

  if (!parsed.ok) {
    // Bundled at build time, so this cannot be a bad upload — it is a broken build, and an
    // empty project says so more usefully than a crash on first paint.
    return { streets: [], areas: [], junctionOverrides: {}, name: fallbackName };
  }

  return {
    streets: parsed.streets,
    areas: parsed.areas,
    junctionOverrides: parsed.junctionOverrides,
    name: fallbackName,
  };
}

export function createCincinnatiProject(): DemoProject {
  return load(cincinnati, 'Downtown Cincinnati');
}


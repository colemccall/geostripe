import cincinnati from './cincinnati.geojson?raw';
import { parseProject } from '../model/project';
import { TEMPLATES, instantiateTemplate } from '../library/templates';
import type { JunctionOverride } from '../geo/derived';
import type { Street } from '../model/types';

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
  junctionOverrides: Record<string, JunctionOverride>;
  name: string;
}

export function createCincinnatiProject(): DemoProject {
  // The fallback section is only used for a feature that arrives with no components of its
  // own, which this file has none of. It is required by the importer's contract.
  const fallback = instantiateTemplate(TEMPLATES[1]!);
  const parsed = parseProject(cincinnati, {
    sectionName: fallback.name,
    components: fallback.components,
  });

  if (!parsed.ok) {
    // Bundled at build time, so this cannot be a bad upload — it is a broken build, and
    // an empty project says so more usefully than a crash on first paint.
    return { streets: [], junctionOverrides: {}, name: 'Downtown Cincinnati' };
  }

  return {
    streets: parsed.streets,
    junctionOverrides: parsed.junctionOverrides,
    name: 'Downtown Cincinnati',
  };
}

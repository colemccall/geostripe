/**
 * One place for the editor version, which is written into every exported project file.
 *
 * A literal rather than an import of package.json: Vite would have to inline the whole
 * manifest into the bundle to get one string out of it.
 */
export const EDITOR_VERSION = '0.1.0';

/**
 * Which build is actually running.
 *
 * Defined by Vite at build time from the git SHA and the clock. Shown in the status bar so
 * "I don't see my changes" can be answered by looking rather than by guessing between a
 * failed deploy, a stale cache and a build that never ran.
 */
declare const __BUILD_ID__: string;
declare const __BUILT_AT__: string;

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
export const BUILT_AT: string = typeof __BUILT_AT__ === 'string' ? __BUILT_AT__ : '';

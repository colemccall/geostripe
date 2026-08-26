/**
 * Which version this is, and which build of it.
 *
 * These were three separate strings that never agreed: a literal `v0.1` in the header, a
 * different literal `0.1.0` written into every exported project, and package.json, which
 * nothing read. So the number on screen was decoration — it could not tell you what you
 * were running, which is the only job it had.
 *
 * Now there is one number, `package.json`'s, inlined by Vite at build time. `npm version`
 * moves it and everything follows: the header, every saved file, the reload prompt.
 *
 * Version and build are different questions and both are worth answering:
 *
 *   version  what the software is. Changes when the work changes.
 *   build    which compilation of it you happen to have. Changes every deploy, and is the
 *            one that settles "did my change ship" — which matters here because GitHub
 *            Pages serves index.html with a ten-minute cache, so a browser can hold a
 *            week-old bundle while the server is perfectly current.
 *
 * The build is shown as a timestamp rather than a commit hash. Two hashes cannot be put in
 * order by eye; two times can, which is exactly the comparison being made.
 */

declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
declare const __BUILT_AT__: string;

/** The one version number. Shown in the header, written into every exported project. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';

/**
 * Recorded in the `editorVersion` field of every project file.
 *
 * Deliberately the same string as the header shows. A file that says which version wrote
 * it is only useful if that version is one somebody can point at.
 */
export const EDITOR_VERSION = APP_VERSION;

/** Short commit hash of the build, or 'dev' when running from source. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/** When the running bundle was built, ISO 8601. Empty in dev, where there is no build. */
export const BUILT_AT: string = typeof __BUILT_AT__ === 'string' ? __BUILT_AT__ : '';

/**
 * The build, as something a person can compare against their own clock.
 *
 * Local time, not UTC: the question is always "is this from before or after I pushed", and
 * that is asked against the clock on the wall.
 */
export function buildStamp(): string {
  if (!BUILT_AT) return 'dev';
  const built = new Date(BUILT_AT);
  if (Number.isNaN(built.getTime())) return 'dev';

  return built.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The long form, for the tooltip: everything needed to identify the build exactly. */
export function buildDetail(): string {
  if (!BUILT_AT) return 'Running from source — no build stamp';
  return `Version ${APP_VERSION}\nBuilt ${new Date(BUILT_AT).toLocaleString()}\nCommit ${BUILD_ID}`;
}

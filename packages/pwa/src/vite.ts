/**
 * The build-time entry point: `@massing/pwa/vite`.
 *
 * Separate from `.` because that one is imported by the running app. A single barrel would drag the plugin into
 * the browser bundle, and a bundler cannot tree-shake what it cannot prove is side-effect free across a
 * re-export boundary. Keeping them apart makes "this is build-time" a fact about the import path rather than a
 * comment someone has to read.
 */

export { massingPwa, type PwaPluginOptions, type VitePluginLike } from "./plugin.js";

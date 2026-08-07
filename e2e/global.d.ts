// The debug/E2E hook the demo installs on `window`. Declared here so the spec files can use it without each
// re-declaring the global — and so a change to the hook's shape breaks the specs at typecheck rather than at
// runtime in a browser.
import type { Viewport, SceneElement } from "@massingviewer/viewport";

declare global {
  interface Window {
    __massingviewer?: {
      viewport: Viewport;
      elements: readonly SceneElement[];
      triangles: number;
      renderNow(): void;
      sampleFramebuffer(step?: number): { sampled: number; nonBackground: number; coverage: number };
    };
  }
}

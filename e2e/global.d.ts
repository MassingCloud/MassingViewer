// The debug/E2E hook the demo installs on `window`. Declared here so the spec files can use it without each
// re-declaring the global — and so a change to the hook's shape breaks the specs at typecheck rather than at
// runtime in a browser.
import type { Viewport, SceneElement } from "@massing/viewport";

declare global {
  interface Window {
    __massingviewer?: {
      viewport: Viewport;
      // Getters on the app side, because authoring replaces the model. Declared readonly here so a spec cannot
      // capture one and then assert against a stale snapshot while appearing to assert the current state.
      readonly elements: readonly SceneElement[];
      readonly triangles: number;
      readonly authored: number;
      readonly cameraDistance: number;
      readonly topics: readonly { guid: string; title: string; type: string; pin?: { guids: readonly string[] } }[];
      kernelId: string;
      readonly toolCount: number;
      /**
       * The draft controller, or null before `wireDraft` has run.
       *
       * Declared so `arm()` can wait on the real precondition instead of on the kernel panel's text, which is a
       * proxy for it. The two were published in the wrong order in the app until 2026-08-15.
       */
      readonly draft: unknown | null;
      remount(cycles: number): {
        geometries: number;
        textures: number;
        programs: number;
        cacheSize: number;
        sceneChildren: number;
      };
      renderNow(): void;
      sampleFramebuffer(grid?: number): { sampled: number; nonBackground: number; coverage: number };
      renderSignature(grid?: number): { renderer: string; cells: number[]; luminance: number[] };
    };
  }
}

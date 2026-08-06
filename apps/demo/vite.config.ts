import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built demo works from a subpath (GitHub Pages) without a rebuild.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2023" },
  server: { port: 5173, open: false },
  // The fixture is imported as a raw string via `?raw`, so it is inlined at build time and the demo makes
  // ZERO network requests after first paint — which is the property M1 is supposed to demonstrate.
  assetsInclude: ["**/*.ifc"],
});

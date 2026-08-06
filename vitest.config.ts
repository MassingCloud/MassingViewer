import { defineConfig } from "vitest/config";

// One root Vitest run across every workspace package. Deliberately not per-package projects: the
// import-graph and provenance gates are repo-wide assertions that need to see every file at once, and
// splitting the run would let a package pass in isolation while violating a layering rule.
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    // Only the packages that touch the DOM opt into happy-dom, via `// @vitest-environment happy-dom`
    // at the top of the file. Defaulting to node keeps the pure-math suite fast, which is what makes
    // it the suite people actually run before pushing.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts", "**/*.d.ts"],
      thresholds: {
        // Per-package floors. geometry-math and kernel-api are the load-bearing pure layers; the
        // conformance suite depends on them being right, so they carry the highest floor.
        "packages/geometry-math/src/**": { statements: 90, branches: 85, functions: 90, lines: 90 },
        "packages/kernel-api/src/**": { statements: 90, branches: 80, functions: 90, lines: 90 },
        "packages/core/src/**": { statements: 80, branches: 75, functions: 80, lines: 80 },
      },
    },
  },
});

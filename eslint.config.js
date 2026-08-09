import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `site/` is the generated Pages artifact — rendered documentation plus a copy of the demo's build output. It is
  // gitignored, but a flat config does not read .gitignore, so linting it produced 1,423 errors about `self` and
  // `caches` being undefined in a service worker nobody wrote by hand.
  { ignores: ["**/dist/**", "site/**", "**/node_modules/**", "**/*.tsbuildinfo", "**/public/wasm/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2023 },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "off", // the ported geometry uses `pts[i]!` under noUncheckedIndexedAccess
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["error", { allow: ["warn", "error"] }],

      // A published library must not reach for globals that don't exist in every host. `window` and
      // `document` are legal only in the presentation packages, enforced structurally below rather
      // than by convention, because "don't touch the DOM in core" is exactly the rule that erodes.
      "no-restricted-globals": [
        "error",
        { name: "window", message: "Core packages must stay DOM-free. Move this to viewport, ribbon or ui-react." },
        { name: "document", message: "Core packages must stay DOM-free. Move this to viewport, ribbon or ui-react." },
      ],
    },
  },
  {
    // Presentation packages legitimately own the DOM.
    files: [
      "packages/viewport/**/*.ts",
      // The ribbon renders in vanilla DOM on purpose, so that massing can mount the same code —
      // see docs/adr/0009-ribbon-renders-in-vanilla-dom.md. It is a presentation package like the
      // others here, not a core one.
      "packages/ribbon/**/*.ts",
      // fileio owns a drop target and a file picker, which are DOM by definition. Same argument as the ribbon:
      // a vanilla one works in massing's shell and in a React host; a React one works in one of them.
      "packages/fileio/**/*.ts",
      "packages/ui-react/**/*.{ts,tsx}",
      "apps/**/*.{ts,tsx}",
    ],
    rules: { "no-restricted-globals": "off" },
  },
  {
    /**
     * React's hook rules, for `ui-react` alone.
     *
     * Not style. `exhaustive-deps` catches the two bugs that make a React wrapper around imperative UI fail —
     * a stale closure over props captured at mount, and an effect that rebuilds its widget on every render — and
     * `rules-of-hooks` catches a conditional hook, which corrupts state in a way that surfaces somewhere else.
     *
     * `Ribbon.tsx` carries the one deliberate suppression, with the reasoning written above it: its creating
     * effect *must* have empty deps, and everything variable is read through a ref. A suppression the linter
     * knows about is reviewable; a rule that is simply absent is not.
     */
    files: ["packages/ui-react/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // Node-side code: tests, repo gates, benchmarks, config. These legitimately print to stdout — a gate
    // that cannot report what it found is useless — and they run outside the browser, so the DOM-globals
    // restriction does not apply either.
    files: ["**/*.test.ts", "scripts/**/*.mjs", "bench/**/*.mjs", "fixtures/**/*.mjs", "*.config.{ts,js,mjs}"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off", "no-restricted-globals": "off" },
  },
  {
    // Playwright specs and the deployed-smoke script are the one place where Node and browser code share a
    // file: the test body runs in Node, and the callback passed to `page.evaluate` runs in the page. Both sets
    // of globals are legitimately in scope, and there is no lint configuration that can tell which half of the
    // file a given line belongs to — so both are allowed here and nowhere else.
    files: ["e2e/**/*.ts", "scripts/smoke-deployed.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "no-console": "off", "no-restricted-globals": "off" },
  },
);

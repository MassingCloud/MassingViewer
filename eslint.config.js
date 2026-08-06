import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "**/public/wasm/**"] },
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
        { name: "window", message: "Core packages must stay DOM-free. Move this to viewport or ui-react." },
        { name: "document", message: "Core packages must stay DOM-free. Move this to viewport or ui-react." },
      ],
    },
  },
  {
    // Presentation packages legitimately own the DOM.
    files: ["packages/viewport/**/*.ts", "packages/ui-react/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}"],
    rules: { "no-restricted-globals": "off" },
  },
  {
    // Node-side code: tests, repo gates, benchmarks, config. These legitimately print to stdout — a gate
    // that cannot report what it found is useless — and they run outside the browser, so the DOM-globals
    // restriction does not apply either.
    files: ["**/*.test.ts", "scripts/**/*.mjs", "bench/**/*.mjs", "fixtures/**/*.mjs", "*.config.{ts,js,mjs}"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off", "no-restricted-globals": "off" },
  },
);

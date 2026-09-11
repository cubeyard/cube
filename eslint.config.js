// Correctness-only lint (pnpm lint). Formatting is deliberately out of
// scope — no prettier, no stylistic rules — so the diff of a lint fix is
// always a real finding, never churn.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "spikes/",
    "repos/",
    ".claude/",
    ".agents/",
    "images/",
    "scripts/vm/base/",
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  svelte.configs.recommended,
  {
    languageOptions: { globals: globals.node },
  },
  {
    files: ["packages/web/**"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: [".svelte"] },
    },
  },
  {
    rules: {
      // `any` is used on purpose at the SQLite row / JSON boundaries.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Deliberate: ANSI/NUL stripping regexes, literal YAML indentation in
      // the release contract test, and error messages that quote the cause
      // as text rather than attaching it.
      "no-control-regex": "off",
      "no-regex-spaces": "off",
      "preserve-caught-error": "off",
      // The plugin misreads `<!-- svelte-ignore code: reason -->` (each word
      // of the reason is reported), and unkeyed each blocks are the right
      // choice for positional diff rows.
      "svelte/no-unused-svelte-ignore": "off",
      "svelte/require-each-key": "off",
    },
  },
]);

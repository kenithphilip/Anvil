// Flat config for ESLint v9. Keep rules minimal so the existing codebase passes.

export default [
  {
    ignores: [
      "node_modules/**",
      "public/index.html",
      "src/legacy/**",
      ".vercel/**",
      "coverage/**",
    ],
  },
  {
    files: ["api/**/*.js", "src/client/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        crypto: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "warn",
      "eqeqeq": ["warn", "smart"],
    },
  },
  {
    files: ["src/scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];

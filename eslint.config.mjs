// Flat config for ESLint v9. Keep rules minimal so the existing codebase passes.
//
// src/api/** was outside every glob until now, so ~200 server files — the
// entire API, everything under _lib, every cron worker — were never linted at
// all. That is where the code that runs unattended lives, and it is the only
// part of the tree with no type checking either: `npm run check` runs tsc,
// which skips plain .js, so a server file's only gate was `node --check`, and
// that parses syntax without ever resolving an identifier.

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
    files: ["api/**/*.js", "src/api/**/*.js"],
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
        TextDecoder: "readonly",
        crypto: "readonly",
        // The rest of the Node/undici surface src/api actually uses. Listed
        // by hand because this repo has no `globals` package; no-undef is only
        // as good as this list, so a missing entry shows up as a false error
        // rather than a silent gap.
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        queueMicrotask: "readonly",
        structuredClone: "readonly",
        performance: "readonly",
        atob: "readonly",
        btoa: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        ReadableStream: "readonly",
        AbortSignal: "readonly",
        globalThis: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "warn",
      "eqeqeq": ["warn", "smart"],
      // AN ERROR, and clean across the whole tree today.
      //
      // This is the class that `node --check` cannot see: a name that is used
      // and never declared parses perfectly and throws at runtime. It bit
      // twice in one day — a cron worker referencing a settings cache that was
      // never declared, and a component reading a note variable that was
      // never declared. In the cron worker it is worse than a normal crash:
      // any throw inside advanceJob is caught by the handler, which marks the
      // job 'failed', so one undeclared name would have failed EVERY
      // background extraction rather than erroring visibly once.
      "no-undef": "error",
      // A WARNING, deliberately, and this is the honest reason.
      //
      // The bug worth catching is a write into a const's temporal dead zone —
      // docai/index.js assigned to `last` inside a loop while the only `last`
      // in scope was a const declared further down the SAME function, so every
      // adapter that threw made the dispatcher throw. That is a real crash.
      //
      // But ESLint cannot tell that apart from the ordinary and harmless habit
      // of calling a module-level helper defined lower in the file: by the
      // time anything invokes the caller, module evaluation has finished and
      // the binding exists. All 29 current hits are that second kind. Making
      // it an error would demand 29 reorderings that change nothing at
      // runtime, and a rule that costs a day of churn to satisfy is a rule
      // that gets switched off.
      "no-use-before-define": ["warn", { variables: true, functions: false, classes: false }],
    },
  },
  {
    // The browser client. Same rules, different globals — it was grouped with
    // the server files, which was harmless while no-undef was off and wrong
    // the moment it went on: localStorage, sessionStorage and window are not
    // Node globals, and the file is full of them.
    files: ["src/client/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        console: "readonly",
        fetch: "readonly",
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        crypto: "readonly",
        atob: "readonly",
        btoa: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        Blob: "readonly",
        FormData: "readonly",
        Headers: "readonly",
        Response: "readonly",
        Request: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        navigator: "readonly",
        location: "readonly",
        CustomEvent: "readonly",
        Event: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "warn",
      "eqeqeq": ["warn", "smart"],
      "no-undef": "error",
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

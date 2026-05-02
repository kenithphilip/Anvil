<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Anvil v3 · Operator console</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0E0F11" />
<meta name="description" content="Anvil — sales-ops execution layer for Obara India." />

<!-- Skip-link for keyboard users (WCAG 2.4.1) -->
<style>
  .skip-link {
    position: absolute; left: -9999px; top: 0;
    background: var(--ink); color: var(--paper);
    padding: 8px 12px; z-index: 1000; font-size: 12px;
  }
  .skip-link:focus { left: 8px; top: 8px; }
</style>

<!-- v3 design tokens + components (inlined by build) -->
<style id="v3-styles">/* %V3_STYLES% */</style>

<!-- React + Babel from CDN. Production swaps to local copies. -->
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js"></script>

<!-- v3 modules (inlined by build) -->
<script>/* %V3_RBAC% */</script>
<script>/* %V3_PREFS% */</script>

<!-- Backend client (from src/client/obara-client.js) -->
<script>/* %V3_CLIENT% */</script>

<!-- Mark a flag so legacy code can detect we're in v3 mode -->
<script>
window.ANVIL_V3 = true;
// Escape hatch: ?v3=0 unpins v3 and goes back to /. The pin survives across
// reloads via localStorage["obara:v3_pinned"]; index.html honors it.
(function(){
  try {
    var qs = new URLSearchParams(window.location.search);
    if (qs.get("v3") === "0") {
      localStorage.removeItem("obara:v3_pinned");
      window.location.replace("/");
    }
  } catch (_) {}
})();
</script>

</head>
<body>
  <a href="#v3-root" class="skip-link">Skip to main content</a>
  <div id="v3-root" role="application" aria-label="Anvil operator console"></div>

  <!-- v3 React modules. Babel transpiles in-browser for now (dev).
       Load order matters: each script attaches values to window, later
       assignments overwrite earlier ones. screens-system.jsx exports a
       static-demo CmdK that we DO NOT want to win over shell.jsx's
       interactive CmdK, so shell loads AFTER screens. Same logic for any
       future name collisions.
  -->
  <script type="text/babel" data-presets="env,react">/* %V3_PRIMITIVES% */</script>
  <!-- Screen modules (concatenated by build) -->
  <script type="text/babel" data-presets="env,react">/* %V3_SCREENS% */</script>
  <!-- Shell loads after screens so its exports take precedence on collisions -->
  <script type="text/babel" data-presets="env,react">/* %V3_SHELL% */</script>
  <!-- App router last so window.* names from screens + shell are present -->
  <script type="text/babel" data-presets="env,react">/* %V3_APP% */</script>

  <!-- Live status check + error boundary fallback -->
  <noscript>
    <div style="padding: 32px; font-family: system-ui, sans-serif; max-width: 640px; margin: 64px auto; background: #fff; border: 1px solid #ddd;">
      <h1 style="margin: 0 0 12px;">JavaScript required</h1>
      <p style="margin: 0; color: #555;">Anvil v3 is a single-page app. Enable JavaScript to continue.</p>
    </div>
  </noscript>
</body>
</html>

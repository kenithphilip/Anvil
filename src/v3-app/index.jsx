// Vite entry. Pulls in the design-system stylesheet, applies persisted UI
// preferences, then mounts the React app at <div id="root">.

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app.jsx";
import { Prefs } from "./lib/preferences.js";

// Reuse the legacy stylesheet directly so we don't fork the design system.
// Vite resolves the relative path and inlines/serves the CSS file. Once the
// cutover lands, this file moves under src/v3-app/.
import "../v3/styles.css";

Prefs.apply();

const root = createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

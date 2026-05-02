// Vite entry. Pulls in the design-system stylesheet, applies persisted UI
// preferences, then mounts the React app at <div id="root">.

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { Prefs } from "./lib/preferences";

// Design-system stylesheet. Lifted into src/v3-app/ at cutover; previously
// shared with the deleted src/v3/ legacy build.
import "./styles.css";

Prefs.apply();

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

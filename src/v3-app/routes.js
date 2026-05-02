// Route -> lazy import map for the Vite v3 app.
//
// The legacy build concatenates every screen into one HTML script. Here
// each route is a separate dynamic import so Vite emits one chunk per
// route. Visiting #/home only downloads home + its deps; the SO Workspace
// chunk and the BOM importer chunk are deferred until the user navigates
// there.
//
// Add a new route by writing src/v3-app/screens/<id>.jsx with `export
// default function Screen() {}` and adding a row below.

import { lazy } from "react";

export const ROUTES = {
  home:        { label: "Home",        load: () => import("./screens/home.jsx") },
  so:          { label: "Sales orders",load: () => import("./screens/orders.jsx") },
};

// React.lazy components for every entry. Built once at module load so the
// router does not recreate them on every render.
export const LAZY_COMPONENTS = Object.fromEntries(
  Object.entries(ROUTES).map(([id, route]) => [id, lazy(route.load)])
);

// Default landing route when the URL has no #/...
export const DEFAULT_ROUTE = "home";

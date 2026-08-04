// Vite entry for the CUSTOMER PORTAL — a separate bundle from the staff app
// (src/v3-app/index.tsx). The customer never loads staff code.
import React from "react";
import { createRoot } from "react-dom/client";
import { PortalApp } from "./portal/PortalApp";
import "./portal/portal.css";

const el = document.getElementById("portal-root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <PortalApp />
    </React.StrictMode>
  );
}

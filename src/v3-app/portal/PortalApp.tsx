import React, { useState } from "react";
import { PortalAPI } from "./api";
import { LoginView } from "./LoginView";
import { PortalHome } from "./PortalHome";

// Root of the customer portal — a completely separate app from the staff v3-app
// (no internal shell, nav, or RBAC). Session-gated: login → read-only home.
export const PortalApp: React.FC = () => {
  const [authed, setAuthed] = useState<boolean>(PortalAPI.isAuthed());
  if (!authed) return <LoginView onLogin={() => setAuthed(true)} />;
  return <PortalHome onLogout={() => { PortalAPI.logout(); setAuthed(false); }} />;
};

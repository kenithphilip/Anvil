// Standard placeholder shown when a route resolves to a screen that has
// not been ported to the Vite app yet. The legacy bundle still serves the
// real surface at the equivalent `?v3=1` URL until each screen is
// migrated by Sub-PR 2c.

import React from "react";
import { Card, WSTitle, Btn } from "./primitives.jsx";
import { Icon } from "./icons.jsx";

export const Placeholder = ({ name, legacyHash }) => (
  <div className="ws ws-no-rail" style={{ padding: 22 }}>
    <WSTitle
      eyebrow="Migration in progress"
      title={name}
      meta="not yet ported to the Vite build"
    />
    <Card>
      <div className="body" style={{ padding: 16, display: "grid", gap: 10, color: "var(--ink-2)" }}>
        <p>
          This screen exists in the legacy <code>v3.html</code> bundle but
          has not been converted to a Vite ESM module yet. The route is
          registered so deep links keep working.
        </p>
        <p className="mono-sm" style={{ color: "var(--ink-3)" }}>
          See <code>docs/V3_ARCHITECTURE_AUDIT.md</code> for the migration
          plan and per-screen conversion status.
        </p>
        <div>
          <Btn sm onClick={() => { window.location.href = `/v3.html${legacyHash || window.location.hash}`; }}>
            {Icon.ext} Open in legacy v3
          </Btn>
        </div>
      </div>
    </Card>
  </div>
);

// Convenience factory: returns a default-export component bound to a
// specific screen name. Each not-yet-ported screen file just calls this.
export const placeholderFor = (name) => () => <Placeholder name={name} />;

export default Placeholder;

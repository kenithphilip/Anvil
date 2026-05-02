// Minimal app shell for the Vite v3 build.
//
// Hash-based routing keeps parity with the legacy app (#/home, #/so?id=...).
// Sub-PR 1 ships a tiny shell to prove lazy chunks load. Sub-PR 2 brings
// over the full Shell (header + sidebar + dock) once enough screens are
// converted that the sidebar list is meaningful again.

import React, { Suspense, useEffect, useState } from "react";
import { LAZY_COMPONENTS, DEFAULT_ROUTE, ROUTES } from "./routes.js";

const parseHash = () => {
  const raw = (typeof window !== "undefined" && window.location.hash) || "";
  const trimmed = raw.replace(/^#\/?/, "");
  const [route, query] = trimmed.split("?");
  return { route: route || DEFAULT_ROUTE, query: query || "" };
};

const useHashRoute = () => {
  const [state, setState] = useState(parseHash);
  useEffect(() => {
    const onChange = () => setState(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return state;
};

const Fallback = ({ label }) => (
  <div style={{ padding: 24, color: "var(--ink-3, #888)", fontFamily: "var(--mono, monospace)" }}>
    Loading {label}…
  </div>
);

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("[v3-app] route crash", error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24 }}>
        <h2>Something broke loading this route.</h2>
        <pre style={{ color: "var(--rust, #c33)", whiteSpace: "pre-wrap" }}>
          {String(this.state.error.stack || this.state.error.message || this.state.error)}
        </pre>
      </div>
    );
  }
}

export default function App() {
  const { route } = useHashRoute();
  const Component = LAZY_COMPONENTS[route];
  const meta = ROUTES[route];

  if (!Component) {
    return (
      <div style={{ padding: 24 }}>
        <h2>Unknown route: <code>{route}</code></h2>
        <p>Available: {Object.keys(ROUTES).map((id) => (
          <a key={id} href={`#/${id}`} style={{ marginRight: 8 }}>{id}</a>
        ))}</p>
      </div>
    );
  }

  return (
    <div className="v3-app-root">
      <nav style={{ display: "flex", gap: 12, padding: 12, borderBottom: "1px solid var(--hairline, #333)" }}>
        <strong style={{ marginRight: 12 }}>Anvil v3 (vite)</strong>
        {Object.entries(ROUTES).map(([id, r]) => (
          <a key={id} href={`#/${id}`}
             style={{
               textDecoration: "none",
               color: id === route ? "var(--accent, #cf6)" : "var(--ink-2, #aaa)",
               fontWeight: id === route ? 600 : 400,
             }}>
            {r.label}
          </a>
        ))}
      </nav>
      <main className="ws">
        <ErrorBoundary>
          <Suspense fallback={<Fallback label={meta?.label || route} />}>
            <Component />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}

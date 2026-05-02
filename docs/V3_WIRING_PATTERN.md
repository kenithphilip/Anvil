# v3 Wiring Pattern

How to convert a static design-system screen into a wired screen.

## File location

Static screen: `src/v3/screens/screens-<area>.jsx` (kept as design reference, never edited).

Wired screen: `src/v3/screens-wired/wired-<name>.jsx`. The build concatenates these into the same babel block AFTER the static screens, so a `window.X = WiredX` at the bottom of a wired file overrides the static `Object.assign(window, { X })`.

## Skeleton

```jsx
// ============================================================
// ANVIL v3 — wired <Screen Name>
// ============================================================

const Wired<Name> = () => {
  // Read live data via ObaraBackend.* (or fetch fallback).
  const data = useFetch(() => window.ObaraBackend?.<area>?.list?.() || Promise.resolve([]), []);
  // OR: const [state, setState] = React.useState({ rows: [], loading: true });

  if (data.loading) return <LoadingShell title="..." />;
  if (data.error) return <ErrorShell error={data.error} onRetry={data.reload} />;

  return (
    <>
      <WSTitle eyebrow="..." title="..." meta="..." right={<Btn .../>} />
      <WSTabs tabs={...} active={active} onChange={setActive} />
      <div className="ws-content">
        <KPIRow cols={...}>...</KPIRow>
        <Card flush>
          <table className="tbl">...</table>
        </Card>
      </div>
    </>
  );
};

window.<Name> = Wired<Name>;
```

## Available helpers (declared at top of `wired-home.jsx`)

These are top-level in the same babel block, so any wired file later in the bundle can use them directly. **Do not redeclare them**, or you'll get a `const` redeclaration error.

- `useFetch(thunk, deps)` returns `{ data, error, loading, reload }`.
- `ageLabel(iso)` formats a date as `14m` / `2h` / `1d 3h`.
- `fmtINRShort(n)` formats numbers as `₹ 4.8 L` / `₹ 23k`.
- `stageOf(orderStatus)` returns `{ label, k }` for the order status chip.
- `sevOf(order)` returns `"high" | "med" | "low"` for the leading severity bar.

## Available primitives (read `src/v3/primitives.jsx`)

- Layout: `WSTitle`, `WSTabs`, `Card`, `RailPanel`.
- Display: `KPI`, `KPIRow`, `Banner`, `Stream`, `KV`, `Steps`.
- Atoms: `Btn`, `Chip`, `Dot`, `Sev`, `Prov`.
- Icons: `Icon.<name>` (47 of them, see primitives.jsx).

## API access

- The full client lives in `src/client/obara-client.js` and is bundled into v3.html as `window.ObaraBackend`.
- Top-level namespaces: `documents`, `orders`, `customers`, `aliases`, `audit`, `events`, `findings`, `duplicates`, `anomaly`, `evalSuite` / `evalExt`, `auth`, `ocr`, `scan`, `fx`, `delivery`, `inventory`, `masterData`, `bom`, `profileVersions`, `tallyExt`, `sourcePos`, `communications`, `cost`, `salesHistory`, `security`, `spareMatrix`, `sales`, `service`, `einvoice`, `forecast`, `scheduleLines`, `admin`, `email`.
- For namespaces that don't have a wrapper yet, fall back to `fetch('/api/<path>')` directly. Example: approvals doesn't have a wrapper, use `fetch('/api/admin/quote_approvals')`.

## RBAC integration

- Hide whole UI sections when the role can't access: `{window.RBAC?.canRead("admin") && <AdminButton />}`.
- Disable specific actions when the role can't perform them:
  ```jsx
  <Btn
    kind="primary"
    disabled={!window.RBAC?.canDo("so.push_tally")}
    onClick={pushToTally}
  >
    Push to Tally
  </Btn>
  ```
- Action ids are listed in `docs/RBAC.md` and `src/v3/rbac.js`.

## Loading / error / empty states

Always render all three. The user expects no blank pages.

```jsx
if (loading) return (
  <div className="ws ws-no-rail">
    <WSTitle eyebrow="loading" title="..." />
    <div className="ws-content"><Card><div className="body">Loading…</div></Card></div>
  </div>
);

if (error) return (
  <div className="ws ws-no-rail">
    <WSTitle eyebrow="error" title="Could not load" />
    <div className="ws-content">
      <Banner kind="bad" icon={Icon.alert} title="Backend unreachable" action={<Btn sm onClick={reload}>Retry</Btn>}>
        <span className="mono-sm">{String(error.message || error)}</span>
      </Banner>
    </div>
  </div>
);

if (rows.length === 0) return (
  <div className="ws ws-no-rail">
    <WSTitle eyebrow="..." title="..." />
    <div className="ws-content">
      <Card>
        <div className="body" style={{ textAlign: "center", padding: 22, color: "var(--ink-3)" }}>
          Nothing here yet. <a onClick={...} style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>Create one</a>
        </div>
      </Card>
    </div>
  </div>
);
```

## Navigation between screens

Use the URL hash. `#/<navId>` for the top-level route, `#/<navId>?id=<rowId>` for detail.

```jsx
onClick={() => window.location.hash = `#/so?id=${order.id}`}
```

The App router in `app.jsx` reads the hash on `popstate` and updates the active screen.

## WCAG checklist per screen

- Every interactive `<div>` becomes a `<Btn>` (or has `tabIndex={0}` + `onKeyDown`).
- Color is never the sole signal: pair every chip with a label, every icon with text or `title=`.
- Tables use `<thead>` + `<th>`.
- Focus indicators inherit from `styles.css` (do not strip `outline:none`).
- Live regions: announce dynamic count changes with `aria-live="polite"` on KPIRow when KPIs change.

## Adding the file to the build

Edit `src/scripts/build-v3.mjs` and append the new file path to the `SCREEN_FILES` array, AFTER all existing wired files. Order within a wave doesn't matter; order between waves should match the wave order.

```js
const SCREEN_FILES = [
  // ... static screens ...
  "screens-wired/wired-home.jsx",
  "screens-wired/wired-orders.jsx",
  // Wave A
  "screens-wired/wired-inbox.jsx",
  // ...
];
```

Then `npm run build:v3` and `npm run verify`.

## Common pitfalls

1. **Top-level const collision**. If two wired files declare `const helper = ...` at top level, babel-standalone errors. Either alias (`useStateW` vs `useStateD`) or scope inside the component.
2. **Fetching during render**. Always fetch in `useEffect`, never inline. Use `useFetch` helper.
3. **Missing window export**. The App router looks at `window.<Name>`; if you forget the assignment, the screen falls back to the static demo.
4. **Hardcoded sample data**. The static screen has it; copy the layout, NOT the data.
5. **Modal-driven flow**. v3 prefers tabs / panels over modals. If the legacy used a modal, find the right tab on the SO Workspace or a sub-route under the same nav id.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { NAV, ROLES } from "../lib/nav";
import { MATRIX, type Role } from "../lib/rbac";
import { CORE_NAV_IDS, applyNavSettingsLocal, type NavDisabledMap } from "../lib/nav-settings";

// ============================================================
// Admin · Navigation visibility
// Per-role control over which left-nav items (and the screens behind them)
// are activated. Stored as a DISABLED set per role in tenant_settings via
// /api/admin/nav_settings. A disabled item is hidden from the sidebar AND
// blocked on direct URL access (hard gate, enforced in app.tsx + the API).
//
// Visibility is intersected with RBAC: an item still only appears for a role
// that already has read access to it. Items a role cannot access by RBAC are
// shown muted and locked here so the choice is never misleading.
// ============================================================

const ROLE_LABEL = (id: string) => ROLES.find((r) => r.id === id)?.label || id.replace(/_/g, " ");
const hasRoleAccess = (navId: string, role: string): boolean =>
  /[rwax]/.test((MATRIX[navId] && MATRIX[navId][role as Role]) || "");

export const NavVisibilityAdmin: React.FC = () => {
  const [role, setRole] = useState<string>("sales_engineer");
  const [map, setMap] = useState<NavDisabledMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>("");
  const [flash, setFlash] = useState<string>("");

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true); setErr("");
      try {
        const resp: any = await ObaraBackend?.admin?.navSettings?.();
        const m = resp?.nav_disabled;
        if (!cancel) setMap(m && typeof m === "object" && !Array.isArray(m) ? m : {});
      } catch (e: any) {
        if (!cancel) setErr(String(e?.message || e));
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, []);

  const disabledForRole = map[role] || [];
  const isOn = (id: string) => CORE_NAV_IDS.has(id) || !disabledForRole.includes(id);

  const setDisabledForRole = (ids: string[]) => {
    setMap((prev) => {
      const next = { ...prev };
      const cleaned = Array.from(new Set(ids.filter((id) => !CORE_NAV_IDS.has(id)))).sort();
      if (cleaned.length) next[role] = cleaned; else delete next[role];
      return next;
    });
    setFlash("");
  };

  const toggle = (id: string) => {
    if (CORE_NAV_IDS.has(id) || !hasRoleAccess(id, role)) return;
    setDisabledForRole(isOn(id) ? [...disabledForRole, id] : disabledForRole.filter((x) => x !== id));
  };

  // Only items the role can actually reach are togglable.
  const accessibleIds = useMemo(
    () => NAV.flatMap((g) => g.items).map((i) => i.id).filter((id) => hasRoleAccess(id, role) && !CORE_NAV_IDS.has(id)),
    [role],
  );
  const enableAll = () => setDisabledForRole([]);
  const disableAll = () => setDisabledForRole(accessibleIds);

  const onSave = async () => {
    setSaving(true); setErr("");
    try {
      const resp: any = await ObaraBackend?.admin?.updateNavSettings?.({ nav_disabled: map });
      const saved = resp?.nav_disabled && typeof resp.nav_disabled === "object" ? resp.nav_disabled : map;
      setMap(saved);
      applyNavSettingsLocal(saved); // reflect in the live sidebar immediately
      setFlash("Navigation settings saved.");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const totalDisabled = Object.values(map).reduce((n, ids) => n + (ids?.length || 0), 0);

  return (
    <>
      <Card
        title="Navigation visibility"
        eyebrow="per role · choose which left-nav items are activated"
        right={<>
          <Btn sm kind="ghost" onClick={enableAll} disabled={loading || saving} title="Show every item this role can access">Enable all</Btn>
          <Btn sm kind="ghost" onClick={disableAll} disabled={loading || saving} title="Hide every item for this role">Disable all</Btn>
          <Btn sm kind="primary" onClick={onSave} disabled={loading || saving}>{saving ? "Saving…" : <>{Icon.check} Save</>}</Btn>
        </>}
      >
        {err && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load / save navigation settings">
            <span className="mono-sm">{err}</span>
          </Banner>
        )}
        {flash && (
          <Banner kind="good" icon={Icon.check} title="Saved" action={<Btn sm onClick={() => setFlash("")}>Dismiss</Btn>}>
            <span className="mono-sm">{flash}</span>
          </Banner>
        )}

        <div className="body" style={{ color: "var(--ink-3)", marginBottom: 12 }}>
          Turn items off to hide them from the sidebar and block the screen entirely for the selected role.
          Visibility is combined with role permissions — an item only appears for a role that already has access.
          Core items (My Day, Admin Center) stay on so admins can’t be locked out.
        </div>

        {/* Role selector */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
          {ROLES.map((r) => {
            const cnt = (map[r.id] || []).length;
            return (
              <Btn key={r.id} sm kind={role === r.id ? "primary" : "ghost"} onClick={() => setRole(r.id)}>
                {r.label}{cnt ? <span style={{ opacity: 0.7 }}> · {cnt} off</span> : null}
              </Btn>
            );
          })}
        </div>
        <div className="mono-sm" style={{ color: "var(--ink-4)", marginBottom: 4 }}>
          Editing <span className="pri">{ROLE_LABEL(role)}</span> · {totalDisabled} item(s) hidden across all roles
        </div>
      </Card>

      {loading ? (
        <Card><div className="body" style={{ padding: 22, color: "var(--ink-3)" }}>Loading navigation settings…</div></Card>
      ) : (
        NAV.map((group) => {
          const items = group.items;
          const accessible = items.filter((it) => hasRoleAccess(it.id, role) || CORE_NAV_IDS.has(it.id));
          const onCount = accessible.filter((it) => isOn(it.id)).length;
          return (
            <Card key={group.label} title={group.label} eyebrow={`${onCount}/${accessible.length} on`}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
                {items.map((it) => {
                  const core = CORE_NAV_IDS.has(it.id);
                  const access = core || hasRoleAccess(it.id, role);
                  const on = isOn(it.id);
                  return (
                    <label
                      key={it.id}
                      title={!access ? "This role has no permission for this screen" : core ? "Core item — always on" : on ? "Click to hide for this role" : "Click to show for this role"}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
                        border: "1px solid var(--hairline)", borderRadius: 6,
                        cursor: access && !core ? "pointer" : "default",
                        opacity: access ? 1 : 0.5,
                        background: on && access ? "var(--paper-3)" : "transparent",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={access ? on : false}
                        disabled={!access || core}
                        onChange={() => toggle(it.id)}
                        aria-label={`Toggle ${it.label} for ${ROLE_LABEL(role)}`}
                      />
                      <span style={{ flex: 1, fontSize: 12.5 }}>{it.label}</span>
                      {core && <Chip k="ghost">core</Chip>}
                      {!access && !core && <Chip k="ghost">no role access</Chip>}
                    </label>
                  );
                })}
              </div>
            </Card>
          );
        })
      )}
    </>
  );
};

export default NavVisibilityAdmin;

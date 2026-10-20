import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { NAV, ROLES } from "../lib/nav";
import { applyNavSettingsLocal, pilotNavPreset, type NavDisabledMap } from "../lib/nav-settings";

// Admin > Sales & quotes > Mode B lane readiness (plan C-8, R-M5).
//
// The checks come from /api/admin/lane_readiness, which writes nothing. The
// pilot nav preset (C-D9) is applied only when an admin clicks "Apply pilot
// preset", through the same /api/admin/nav_settings write as Admin >
// Navigation, so the admin can change any role back there. The card shows
// what the preset hides and shows before the click.

type Status = "ok" | "warn" | "missing";
type Check = { group: string; id: string; label: string; status: Status; reason: string };
type Readiness = { summary: Record<Status, number>; checks: Check[]; window_days: number };

const GROUPS: Array<[string, string]> = [
  ["flags", "Flags"],
  ["migrations", "Migrations"],
  ["cron", "Cron"],
  ["services", "Mail, recipients and ClamAV"],
  ["schema", "Schema (OPS-3)"],
  ["usage", "Use of each step"],
];
const CHIP: Record<Status, string> = { ok: "good", warn: "warn", missing: "bad" };
const NAV_LABEL = (id: string) => NAV.flatMap((g) => g.items).find((i) => i.id === id)?.label || id;
const ROLE_LABEL = (id: string) => ROLES.find((r) => r.id === id)?.label || id;

export const LaneReadinessCard: React.FC = () => {
  const [data, setData] = useState<Readiness | null>(null);
  const [map, setMap] = useState<NavDisabledMap | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [r, n]: any[] = await Promise.all([
          AnvilBackend?.admin?.laneReadiness?.(),
          AnvilBackend?.admin?.navSettings?.(),
        ]);
        if (cancel) return;
        setData(r || null);
        const m = n?.nav_disabled;
        setMap(m && typeof m === "object" && !Array.isArray(m) ? m : {});
      } catch (e: any) {
        if (!cancel) setErr(String(e?.message || e));
      }
    })();
    return () => { cancel = true; };
  }, []);

  const preset = map ? pilotNavPreset(map) : null;
  const changes = preset ? preset.changes.filter((c) => c.hide.length || c.show.length) : [];

  const apply = async () => {
    if (!preset) return;
    setBusy(true); setErr(""); setFlash("");
    try {
      const resp: any = await AnvilBackend?.admin?.updateNavSettings?.({ nav_disabled: preset.next });
      const saved = resp?.nav_disabled && typeof resp.nav_disabled === "object" ? resp.nav_disabled : preset.next;
      setMap(saved);
      applyNavSettingsLocal(saved);
      setFlash("Pilot preset applied. Change any role in Admin > Navigation.");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card
        title="Mode B lane readiness"
        eyebrow={data ? `${data.summary.ok} ok · ${data.summary.warn} warn · ${data.summary.missing} missing` : "loading"}
      >
        {err && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load or save">
            <span className="mono-sm">{err}</span>
          </Banner>
        )}
        {data && GROUPS.map(([group, title]) => {
          const rows = data.checks.filter((c) => c.group === group);
          if (!rows.length) return null;
          return (
            <div key={group} style={{ marginTop: 10 }}>
              <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 4 }}>{title}</div>
              <table className="tbl">
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.group + c.id} data-testid={`lane-check-${c.id}`}>
                      <td style={{ width: "28%" }}>{c.label}</td>
                      <td style={{ width: 80 }}><Chip k={CHIP[c.status]}>{c.status}</Chip></td>
                      <td>{c.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </Card>

      <Card
        title="Pilot nav preset"
        eyebrow="C-D9 defaults · desktop sidebar and phone tabs"
        right={<Btn sm kind="primary" onClick={apply} disabled={!preset || busy || !changes.length}>{busy ? "Applying…" : "Apply pilot preset"}</Btn>}
      >
        {flash && (
          <Banner kind="good" icon={Icon.check} title="Saved">
            <span className="mono-sm">{flash}</span>
          </Banner>
        )}
        <div className="body" style={{ color: "var(--ink-3)", marginBottom: 8 }}>
          The sales engineer sees My Day, Inbox (new POs), Sales Orders and Approvals. The order-processing
          clerk (an operator seat) sees My Day and Sales Orders. Admin keeps every item. Other roles do not change.
          These are the C-D5 and C-D9 defaults; change them after the discovery with the pilot team (DISC-1).
        </div>
        {preset && !changes.length && <div className="mono-sm" data-testid="pilot-preset-none">The preset is already applied.</div>}
        {changes.map((c) => (
          <div key={c.role} data-testid={`pilot-preset-${c.role}`} style={{ marginBottom: 6 }}>
            <span className="pri">{ROLE_LABEL(c.role)}</span>
            {c.hide.length > 0 && <span>: hides {c.hide.map(NAV_LABEL).join(", ")}</span>}
            {c.show.length > 0 && <span>{c.hide.length ? "; " : ": "}shows {c.show.map(NAV_LABEL).join(", ")}</span>}
          </div>
        ))}
      </Card>
    </>
  );
};

export default LaneReadinessCard;

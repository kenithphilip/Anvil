// ============================================================
// ANVIL v3 — wired Admin Center
// Wave F · Admin
// Members · Settings · Holidays · Lead times · FX rates ·
// Approval thresholds · Diagnostics.
// Admin-only.
// ============================================================

const ADMIN_TABS = [
  { id: "members",   label: "Members" },
  { id: "settings",  label: "Settings" },
  { id: "holidays",  label: "Holidays" },
  { id: "leadtimes", label: "Lead times" },
  { id: "fx",        label: "FX rates" },
  { id: "thresh",    label: "Approval thresholds" },
  { id: "diag",      label: "Diagnostics" },
];

const ROLES = ["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "viewer"];

const DRAWING_BASE_URL_KEY = "obara:drawing_base_url";

const trimTrailingSlash = (s) => (s || "").replace(/\/+$/, "");

const composeDrawingUrl = (base, drawingNo) => {
  const b = trimTrailingSlash(base);
  if (!b || !drawingNo) return null;
  return `${b}/${encodeURIComponent(drawingNo)}.pdf`;
};

const adminRows = (resp, key) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp[key])) return resp[key];
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const fxRowsFromResp = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.rates)) return resp.rates;
  if (Array.isArray(resp.rows)) return resp.rows;
  if (resp.pairs && typeof resp.pairs === "object") {
    return Object.entries(resp.pairs).map(([pair, info]) => ({
      pair,
      rate: typeof info === "object" ? (info.rate || info.spot) : info,
      as_of: typeof info === "object" ? (info.as_of || info.timestamp) : null,
    }));
  }
  return [];
};

const WiredAdmin = () => {
  const isAdmin = !!(window.RBAC && window.RBAC.isAdmin && window.RBAC.isAdmin());

  const [active, setActive] = useStateW("members");
  const [busy, setBusy] = useStateW(false);
  const [flash, setFlash] = useStateW(null);
  const [memberForm, setMemberForm] = useStateW({ email: "", role: "sales_engineer" });
  const [holidayForm, setHolidayForm] = useStateW({ country: "IN", date: "", name: "" });

  // Drawing-link configuration (Settings tab) — persisted in localStorage.
  const [drawingBase, setDrawingBase] = useStateW(() => {
    try { return localStorage.getItem(DRAWING_BASE_URL_KEY) || ""; }
    catch (_) { return ""; }
  });
  const [drawingDraft, setDrawingDraft] = useStateW(() => {
    try { return localStorage.getItem(DRAWING_BASE_URL_KEY) || ""; }
    catch (_) { return ""; }
  });

  const members = useFetch(
    () => fetch("/api/admin/members")
      .then((r) => r.ok ? r.json() : { members: [] })
      .catch(() => ({ members: [] })),
    []
  );
  const holidays = useFetch(
    () => fetch("/api/admin/holidays")
      .then((r) => r.ok ? r.json() : { holidays: [] })
      .catch(() => ({ holidays: [] })),
    []
  );
  const leadTimes = useFetch(
    () => fetch("/api/admin/lead_times")
      .then((r) => r.ok ? r.json() : { lead_times: [] })
      .catch(() => ({ lead_times: [] })),
    []
  );
  const fxRates = useFetch(
    () => window.ObaraBackend?.fx?.lookup?.({ pairs: ["USD/INR", "JPY/INR", "CNY/INR"] }) || Promise.resolve({ rates: [] }),
    []
  );
  const thresholds = useFetch(
    () => fetch("/api/admin/quote_approvals?settings=1")
      .then((r) => r.ok ? r.json() : { thresholds: [] })
      .catch(async () => {
        try {
          return await window.ObaraBackend?.admin?.listApprovalThresholds?.();
        } catch (_) {
          return { thresholds: [] };
        }
      }),
    []
  );
  const diagnostics = useFetch(
    () => {
      const call = window.ObaraBackend?.admin?.diagnostics;
      if (typeof call === "function") return call();
      return fetch("/api/admin/diagnostics")
        .then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)));
    },
    []
  );
  // Used for the "Test" button in the Settings drawing-link card. We pull
  // the first item_master row to get a real drawing_no to compose against.
  const itemMaster = useFetch(
    () => {
      const call = window.ObaraBackend?.admin?.listItemMaster;
      if (typeof call === "function") return call({ limit: 1 });
      return fetch("/api/admin/item_master?limit=1")
        .then((r) => r.ok ? r.json() : { items: [] })
        .catch(() => ({ items: [] }));
    },
    []
  );

  if (!isAdmin) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Admin" title="Restricted" meta="admin only" />
        <div className="ws-content">
          <Banner kind="warn" icon={Icon.lock} title="Insufficient permissions">
            <span className="mono-sm">Admin Center is only available to users with the admin role.</span>
          </Banner>
        </div>
      </div>
    );
  }

  const memberRows = adminRows(members.data, "members");
  const holidayRows = adminRows(holidays.data, "holidays");
  const leadTimeRows = adminRows(leadTimes.data, "lead_times");
  const fxRows = fxRowsFromResp(fxRates.data);
  const thresholdRows = adminRows(thresholds.data, "thresholds");

  const tenantSlug = (window.ObaraBackend && window.ObaraBackend.getConfig
    && window.ObaraBackend.getConfig().tenantId)
    || localStorage.getItem("obara:v3_tenant_code") || "—";

  const onAddMember = async (ev) => {
    ev.preventDefault();
    if (!memberForm.email) {
      setFlash({ kind: "bad", msg: "Email required" });
      return;
    }
    setBusy(true); setFlash(null);
    try {
      const resp = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: memberForm.email, role: memberForm.role }),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      setFlash({ kind: "good", msg: `Invited ${memberForm.email}` });
      setMemberForm({ email: "", role: "sales_engineer" });
      members.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  };

  const onChangeRole = async (userId, role) => {
    setBusy(true); setFlash(null);
    try {
      const resp = await fetch("/api/admin/members", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, role }),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      setFlash({ kind: "good", msg: "Role updated" });
      members.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  };

  const onRemoveMember = async (userId) => {
    setBusy(true); setFlash(null);
    try {
      const resp = await fetch(`/api/admin/members?user_id=${encodeURIComponent(userId)}`, { method: "DELETE" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      setFlash({ kind: "good", msg: "Member removed" });
      members.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  };

  const onAddHoliday = async (ev) => {
    ev.preventDefault();
    if (!holidayForm.date || !holidayForm.name) {
      setFlash({ kind: "bad", msg: "Date and name required" });
      return;
    }
    setBusy(true); setFlash(null);
    try {
      const resp = await fetch("/api/admin/holidays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(holidayForm),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      setFlash({ kind: "good", msg: `Added holiday "${holidayForm.name}"` });
      setHolidayForm({ country: "IN", date: "", name: "" });
      holidays.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  };

  const refreshFx = async () => {
    setBusy(true); setFlash(null);
    try {
      await window.ObaraBackend?.fx?.refresh?.();
      setFlash({ kind: "good", msg: "FX rates refreshed" });
      fxRates.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <WSTitle
        eyebrow="Admin · Settings"
        title="Admin Center"
        meta={`${memberRows.length} members · ${holidayRows.length} holidays · ${thresholdRows.length} approval rules`}
        right={<>
          <Btn icon kind="ghost" sm onClick={() => { members.reload(); holidays.reload(); leadTimes.reload(); fxRates.reload(); thresholds.reload(); }} title="Refresh all">{Icon.cycle}</Btn>
        </>}
      />
      <WSTabs tabs={ADMIN_TABS} active={active} onChange={setActive} />

      <div className="ws-content">
        {flash && (
          <Banner kind={flash.kind} icon={flash.kind === "bad" ? Icon.alert : Icon.check} title={flash.kind === "bad" ? "Action failed" : "Action complete"}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
        )}

        {active === "members" && (
          <>
            {members.error && (
              <Banner kind="bad" icon={Icon.alert} title="Failed to load members" action={<Btn sm onClick={members.reload}>Retry</Btn>}>
                <span className="mono-sm">{String(members.error.message || members.error)}</span>
              </Banner>
            )}
            <Card flush>
              {members.loading ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading members…</div>
              ) : memberRows.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No members yet.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                    <th scope="col">Joined</th>
                    <th scope="col" style={{ width: 220 }}>Actions</th>
                  </tr></thead>
                  <tbody>
                    {memberRows.map((m) => (
                      <tr key={m.user_id || m.id || m.email}>
                        <td className="mono-sm">{m.email || m.user_email || "—"}</td>
                        <td>
                          <select
                            className="input"
                            value={m.role || "viewer"}
                            aria-label={`Change role for ${m.email}`}
                            onChange={(ev) => onChangeRole(m.user_id || m.id, ev.target.value)}
                            disabled={busy}
                            style={{ height: 26 }}
                          >
                            {ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                          </select>
                        </td>
                        <td className="mono-sm">{m.joined_at ? new Date(m.joined_at).toLocaleDateString("en-IN") : "—"}</td>
                        <td>
                          <Btn sm kind="ghost" disabled={busy} onClick={() => onRemoveMember(m.user_id || m.id)}>remove</Btn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="Invite member" eyebrow="email + role">
              <form onSubmit={onAddMember} style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 8, alignItems: "end" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Email</span>
                  <input className="input" type="email" required aria-label="Member email"
                    value={memberForm.email}
                    onChange={(ev) => setMemberForm((f) => ({ ...f, email: ev.target.value }))}
                    style={{ height: 30 }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Role</span>
                  <select className="input" aria-label="Member role"
                    value={memberForm.role}
                    onChange={(ev) => setMemberForm((f) => ({ ...f, role: ev.target.value }))}
                    style={{ height: 30 }}>
                    {ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                  </select>
                </label>
                <Btn type="submit" kind="primary" sm disabled={busy}>{busy ? "inviting…" : <>{Icon.plus} invite</>}</Btn>
              </form>
            </Card>
          </>
        )}

        {active === "settings" && (
          <Card title="Tenant settings" eyebrow="read-only · edit via API">
            <KV rows={[
              ["Display name", tenantSlug],
              ["Slug", tenantSlug.toLowerCase()],
              ["Backend", window.ObaraBackend?.isReady?.() ? "connected" : "not configured"],
              ["Theme", window.Prefs?.theme?.() || "default"],
            ]} />
            <div className="divider" />
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
              Future: write-side via <span className="mono">/api/admin/tenant</span> with role + display name editing.
            </div>
          </Card>
        )}

        {active === "holidays" && (
          <>
            {holidays.error && (
              <Banner kind="bad" icon={Icon.alert} title="Failed to load holidays" action={<Btn sm onClick={holidays.reload}>Retry</Btn>}>
                <span className="mono-sm">{String(holidays.error.message || holidays.error)}</span>
              </Banner>
            )}
            <Card flush>
              {holidays.loading ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading holidays…</div>
              ) : holidayRows.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No holidays defined.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th scope="col">Country</th>
                    <th scope="col">Date</th>
                    <th scope="col">Name</th>
                  </tr></thead>
                  <tbody>
                    {holidayRows.map((h, i) => (
                      <tr key={h.id || i}>
                        <td className="mono-sm">{h.country || "—"}</td>
                        <td className="mono-sm">{h.date || h.holiday_date || "—"}</td>
                        <td>{h.name || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="Add holiday" eyebrow="country + date + name">
              <form onSubmit={onAddHoliday} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr auto", gap: 8, alignItems: "end" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Country</span>
                  <input className="input" aria-label="Country code"
                    value={holidayForm.country}
                    onChange={(ev) => setHolidayForm((f) => ({ ...f, country: ev.target.value }))}
                    style={{ height: 30 }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Date</span>
                  <input type="date" className="input" required aria-label="Holiday date"
                    value={holidayForm.date}
                    onChange={(ev) => setHolidayForm((f) => ({ ...f, date: ev.target.value }))}
                    style={{ height: 30 }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Name</span>
                  <input className="input" required aria-label="Holiday name"
                    value={holidayForm.name}
                    onChange={(ev) => setHolidayForm((f) => ({ ...f, name: ev.target.value }))}
                    style={{ height: 30 }} />
                </label>
                <Btn type="submit" kind="primary" sm disabled={busy}>{busy ? "adding…" : <>{Icon.plus} add</>}</Btn>
              </form>
            </Card>
          </>
        )}

        {active === "leadtimes" && (
          <>
            {leadTimes.error && (
              <Banner kind="bad" icon={Icon.alert} title="Failed to load lead times" action={<Btn sm onClick={leadTimes.reload}>Retry</Btn>}>
                <span className="mono-sm">{String(leadTimes.error.message || leadTimes.error)}</span>
              </Banner>
            )}
            <Card flush>
              {leadTimes.loading ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading lead times…</div>
              ) : leadTimeRows.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No lead times configured.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th scope="col">Customer / Supplier</th>
                    <th scope="col" className="r">Days</th>
                    <th scope="col">Notes</th>
                  </tr></thead>
                  <tbody>
                    {leadTimeRows.map((r, i) => (
                      <tr key={r.id || i}>
                        <td>{r.customer_name || r.supplier_name || r.name || r.entity_name || "—"}</td>
                        <td className="r mono">{r.days != null ? r.days : (r.lead_time_days != null ? r.lead_time_days : "—")}</td>
                        <td className="mono-sm">{r.notes || r.description || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}

        {active === "fx" && (
          <>
            {fxRates.error && (
              <Banner kind="bad" icon={Icon.alert} title="Failed to load FX rates" action={<Btn sm onClick={fxRates.reload}>Retry</Btn>}>
                <span className="mono-sm">{String(fxRates.error.message || fxRates.error)}</span>
              </Banner>
            )}
            <Card title="FX rates" eyebrow="USD · JPY · CNY against INR"
              right={<Btn sm kind="primary" disabled={busy} onClick={refreshFx}>{busy ? "refreshing…" : <>{Icon.cycle} manual refresh</>}</Btn>}>
              {fxRates.loading ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>Loading rates…</div>
              ) : fxRows.length === 0 ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>No FX rates available. Try a manual refresh.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th scope="col">Pair</th>
                    <th scope="col" className="r">Rate</th>
                    <th scope="col">As of</th>
                  </tr></thead>
                  <tbody>
                    {fxRows.map((r, i) => (
                      <tr key={r.pair || i}>
                        <td className="mono"><span className="pri">{r.pair || `${r.base}/${r.quote}`}</span></td>
                        <td className="r mono">{r.rate != null ? Number(r.rate).toFixed(4) : "—"}</td>
                        <td className="mono-sm">{r.as_of ? new Date(r.as_of).toLocaleString("en-IN") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}

        {active === "thresh" && (
          <>
            {thresholds.error && (
              <Banner kind="bad" icon={Icon.alert} title="Failed to load thresholds" action={<Btn sm onClick={thresholds.reload}>Retry</Btn>}>
                <span className="mono-sm">{String(thresholds.error.message || thresholds.error)}</span>
              </Banner>
            )}
            <Card flush>
              {thresholds.loading ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading thresholds…</div>
              ) : thresholdRows.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No approval thresholds configured.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th scope="col">Role</th>
                    <th scope="col" className="r">Min amount</th>
                    <th scope="col" className="r">Max amount</th>
                    <th scope="col" className="r">Margin below %</th>
                  </tr></thead>
                  <tbody>
                    {thresholdRows.map((t, i) => (
                      <tr key={t.id || i}>
                        <td><Chip k="info">{(t.role || "—").replace(/_/g, " ")}</Chip></td>
                        <td className="r mono">{t.min_amount != null ? fmtINRShort(t.min_amount) : "—"}</td>
                        <td className="r mono">{t.max_amount != null ? fmtINRShort(t.max_amount) : "—"}</td>
                        <td className="r mono">{t.margin_below_pct != null ? Number(t.margin_below_pct).toFixed(1) + "%" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}

        {active === "diag" && (
          <>
            <Card title="Integration health" eyebrow="connectivity checks">
              <KV rows={[
                ["Backend", window.ObaraBackend?.isReady?.() ? "live" : "anonymous"],
                ["Tally bridge", "—"],
                ["e-Invoice (GSTN)", "—"],
                ["FX provider", fxRows.length ? "OK" : "—"],
                ["Anthropic API", "—"],
              ]} />
            </Card>
            <Card title="Storage status" eyebrow="document store + database">
              <KV rows={[
                ["Documents bucket", "—"],
                ["Database", "—"],
                ["Tenant slug", tenantSlug],
              ]} />
              <div className="divider" />
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                Live diagnostics endpoint pending (<span className="mono">/api/admin/diagnostics</span>). Until then, this tab is a placeholder.
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
};

window.AdminCenter = WiredAdmin;

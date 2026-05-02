// ============================================================
// ANVIL v3 — wired Aliases (standalone)
// Wave E · Legacy showAliasManager surface
// Reads via ObaraBackend.aliases.list · upserts via ObaraBackend.aliases.upsert
// ============================================================

const aliasRowsOf = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.aliases)) return resp.aliases;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const WiredAliases = () => {
  const list = useFetch(
    () => window.ObaraBackend?.aliases?.list?.() || Promise.resolve({ aliases: [] }),
    []
  );
  const customers = useFetch(
    () => window.ObaraBackend?.customers?.list?.() || Promise.resolve({ customers: [] }),
    []
  );
  const [draft, setDraft] = useStateW({ customer_id: "", raw_part: "", canonical_part_no: "" });
  const [submitting, setSubmitting] = useStateW(false);
  const [submitError, setSubmitError] = useStateW(null);

  const submit = async () => {
    if (!draft.customer_id || !draft.raw_part.trim() || !draft.canonical_part_no.trim()) {
      setSubmitError(new Error("All fields required"));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await window.ObaraBackend?.aliases?.upsert?.({
        customer_id: draft.customer_id,
        raw_part: draft.raw_part.trim(),
        canonical_part_no: draft.canonical_part_no.trim(),
      });
      setDraft({ customer_id: "", raw_part: "", canonical_part_no: "" });
      list.reload();
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Master · Aliases" title="Part aliases" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading aliases…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Master · Aliases" title="Part aliases" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load aliases"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const rows = aliasRowsOf(list.data);
  const customerList = (() => {
    const d = customers.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    if (Array.isArray(d.customers)) return d.customers;
    if (Array.isArray(d.rows)) return d.rows;
    return [];
  })();

  return (
    <>
      <WSTitle
        eyebrow="Master · Aliases"
        title="Part aliases"
        meta={`${rows.length} mapped`}
        right={<Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>}
      />

      <div className="ws-content">
        <Card title="Map a new alias" eyebrow="customer · raw → canonical">
          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1.5fr 1.5fr auto", gap: 10, alignItems: "end" }}>
            <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>Customer *</span>
              <select
                className="input"
                value={draft.customer_id}
                onChange={(ev) => setDraft({ ...draft, customer_id: ev.target.value })}
              >
                <option value="">— select customer —</option>
                {customerList.map((c) => (
                  <option key={c.id || c.customer_key} value={c.id || c.customer_key}>
                    {c.customer_name || c.customer_key || (c.id ? c.id.slice(0, 8) : "—")}
                  </option>
                ))}
              </select>
            </label>
            <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>Raw part / description *</span>
              <input
                className="input"
                value={draft.raw_part}
                onChange={(ev) => setDraft({ ...draft, raw_part: ev.target.value })}
                placeholder="Bearing 6204-2RS"
              />
            </label>
            <label className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>Canonical part # *</span>
              <input
                className="input"
                value={draft.canonical_part_no}
                onChange={(ev) => setDraft({ ...draft, canonical_part_no: ev.target.value })}
                placeholder="BR-6204-ZZ"
              />
            </label>
            <Btn sm kind="primary" disabled={submitting} onClick={submit}>
              {submitting ? "saving…" : "+ map"}
            </Btn>
          </div>
          {submitError && (
            <div style={{ marginTop: 12 }}>
              <Banner kind="bad" icon={Icon.alert} title="Could not save alias">
                <span className="mono-sm">{String(submitError.message || submitError)}</span>
              </Banner>
            </div>
          )}
        </Card>

        <Card flush>
          {rows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No aliases mapped yet. Use the form above to map your first alias.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Customer</th>
                <th>Raw part / description</th>
                <th>Canonical part</th>
                <th className="r">Confidence</th>
              </tr></thead>
              <tbody>
                {rows.slice(0, 200).map((r) => (
                  <tr key={r.id}>
                    <td>{r.customer_name || r.customer_key || (r.customer_id ? r.customer_id.slice(0, 8) : "—")}</td>
                    <td><span className="pri">{r.raw_part || r.raw || "—"}</span></td>
                    <td className="mono">{r.canonical_part_no || r.canonical || "—"}</td>
                    <td className="r mono">{r.confidence != null ? `${(Number(r.confidence) * 100).toFixed(0)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
};

window.Aliases = WiredAliases;

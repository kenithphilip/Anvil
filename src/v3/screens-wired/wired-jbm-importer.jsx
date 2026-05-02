// ============================================================
// ANVIL v3 — JBM customer matrix importer
// One-click XLSX -> equipment_hierarchy + equipment_installed_parts
// for the JBM Plant 1 spare matrix layout.
//
// Reached at #/items?view=jbm-import.
// ============================================================

const XLSX_CDN_JBM = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

const ensureXlsxJbm = async () => {
  if (window.XLSX) return window.XLSX;
  if (document.querySelector(`script[src="${XLSX_CDN_JBM}"]`)) {
    // Wait for it to attach
    await new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (window.XLSX || Date.now() - t0 > 5000) return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });
    if (window.XLSX) return window.XLSX;
  }
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = XLSX_CDN_JBM;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load XLSX from CDN"));
    document.head.appendChild(s);
  });
  if (!window.XLSX) throw new Error("XLSX did not attach to window");
  return window.XLSX;
};

// Detect JBM matrix structure: header row contains a Plant or Line
// indicator, and "Gun No" appears somewhere in the first 20 columns.
// Spare-part columns are everything to the right of the fixed
// equipment columns.
const FIXED_HEADERS_JBM = [
  "plant", "line", "zone", "station",
  "robot make", "robot no", "gun no", "gun type",
  "qty", "timer model", "atd model",
];
const NORM_JBM = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

const parseJbmXlsx = async (file) => {
  const xlsx = await ensureXlsxJbm();
  const buf = await file.arrayBuffer();
  const wb = xlsx.read(buf, { type: "array" });
  const candidate = wb.SheetNames.find((n) => /plant\s*1|spare\s*matrix/i.test(n)) || wb.SheetNames[0];
  const sheet = wb.Sheets[candidate];
  const grid = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!grid.length) throw new Error("Sheet is empty: " + candidate);

  // Find the header row: the first row where Gun No (or 'gun no') appears.
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const row = grid[i].map(NORM_JBM);
    if (row.some((c) => c.includes("gun no") || c.includes("gun number"))) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) throw new Error("Could not find header row with 'Gun No' column");

  const header = grid[headerRowIdx].map(NORM_JBM);
  // Map fixed columns
  const colIdx = {};
  FIXED_HEADERS_JBM.forEach((label) => {
    const i = header.findIndex((c) => c === label || c.replace(/\.$/, "") === label);
    if (i >= 0) colIdx[label] = i;
  });
  // Spare-part columns: anything not in FIXED_HEADERS_JBM and non-empty
  const partColumns = [];
  header.forEach((c, i) => {
    if (!c) return;
    if (FIXED_HEADERS_JBM.includes(c)) return;
    partColumns.push({ name: c, index: i });
  });

  const guns = [];
  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row || row.every((c) => !String(c).trim())) continue;
    const get = (label) => row[colIdx[label]] != null ? String(row[colIdx[label]]).trim() : "";
    const gun = {
      plant_name: get("plant"),
      line_name: get("line"),
      zone_name: get("zone"),
      station_name: get("station"),
      robot_make: get("robot make"),
      robot_no: get("robot no"),
      gun_no: get("gun no"),
      gun_type: get("gun type"),
      qty: Number(get("qty") || 1),
      timer_model: get("timer model"),
      atd_model: get("atd model"),
      installed_parts: [],
    };
    if (!gun.gun_no) continue;
    partColumns.forEach((pc) => {
      const cell = row[pc.index];
      const n = Number(cell);
      if (n > 0) {
        gun.installed_parts.push({ part_no: pc.name.toUpperCase(), installed_qty: n });
      } else if (cell != null && String(cell).trim() && isNaN(n)) {
        // Some matrices put a part number string in the cell; treat as qty 1
        gun.installed_parts.push({ part_no: String(cell).trim(), installed_qty: 1 });
      }
    });
    guns.push(gun);
  }

  return { sheetName: candidate, headerRow: headerRowIdx, partColumns, guns };
};

const WiredJbmImporter = () => {
  const { useState: uS, useEffect: uE, useRef: uR } = React;
  const [customers, setCustomers] = uS({ data: [], loading: true });
  const [customerId, setCustomerId] = uS("");
  const [locations, setLocations] = uS({ data: [], loading: false });
  const [locationId, setLocationId] = uS("");
  const [parsed, setParsed] = uS(null);
  const [parseError, setParseError] = uS(null);
  const [busy, setBusy] = uS(false);
  const [progress, setProgress] = uS({ done: 0, total: 0, log: [] });
  const fileRef = uR(null);

  uE(() => {
    let cancel = false;
    Promise.resolve(window.ObaraBackend?.customers?.list?.() || Promise.resolve([]))
      .then((r) => {
        if (cancel) return;
        const list = Array.isArray(r) ? r : (r?.rows || []);
        setCustomers({ data: list, loading: false });
        const jbm = list.find((c) => c.customer_key === "JBM_AUTO_PLANT_1") || list[0];
        if (jbm) setCustomerId(jbm.id);
      })
      .catch(() => { if (!cancel) setCustomers({ data: [], loading: false }); });
    return () => { cancel = true; };
  }, []);

  uE(() => {
    if (!customerId) return;
    let cancel = false;
    setLocations({ data: [], loading: true });
    Promise.resolve(window.ObaraBackend?.admin?.listCustomerLocations?.(customerId) || Promise.resolve({ locations: [] }))
      .then((r) => {
        if (cancel) return;
        const list = Array.isArray(r) ? r : (r?.locations || r?.rows || []);
        setLocations({ data: list, loading: false });
        if (list.length === 1) setLocationId(list[0].id);
      })
      .catch(() => { if (!cancel) setLocations({ data: [], loading: false }); });
    return () => { cancel = true; };
  }, [customerId]);

  const onFile = async (file) => {
    if (!file) return;
    setParseError(null);
    setParsed(null);
    setBusy(true);
    try {
      const result = await parseJbmXlsx(file);
      setParsed(result);
      window.notifySuccess?.("Parsed " + file.name, `${result.guns.length} guns · ${result.partColumns.length} part columns`);
    } catch (err) {
      setParseError(err);
      window.notifyError?.("Parse failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!parsed || !customerId || !parsed.guns.length) return;
    if (!window.confirm(`Import ${parsed.guns.length} guns into ${customers.data.find(c => c.id === customerId)?.customer_name || "this customer"}? This is additive (existing rows are upserted by gun_no).`)) return;
    setBusy(true);
    setProgress({ done: 0, total: parsed.guns.length, log: [] });
    let success = 0;
    let failure = 0;
    for (let i = 0; i < parsed.guns.length; i++) {
      const gun = parsed.guns[i];
      const equipment = {
        customer_id: customerId,
        customer_location_id: locationId || null,
        plant_name: gun.plant_name || null,
        line_name: gun.line_name || null,
        zone_name: gun.zone_name || null,
        station_name: gun.station_name || null,
        robot_make: gun.robot_make || null,
        robot_no: gun.robot_no || null,
        gun_no: gun.gun_no,
        gun_type: gun.gun_type || null,
        qty: gun.qty || 1,
        timer_model: gun.timer_model || null,
        atd_model: gun.atd_model || null,
      };
      try {
        await window.ObaraBackend.admin.upsertEquipment({
          equipment,
          installed_parts: gun.installed_parts,
        });
        success++;
        setProgress((p) => ({ done: i + 1, total: p.total, log: [...p.log, { gun: gun.gun_no, ok: true, parts: gun.installed_parts.length }] }));
      } catch (err) {
        failure++;
        setProgress((p) => ({ done: i + 1, total: p.total, log: [...p.log, { gun: gun.gun_no, ok: false, error: err?.message || String(err) }] }));
      }
    }
    setBusy(false);
    if (failure === 0) {
      window.notifySuccess?.("JBM import complete", `${success} guns + ${parsed.guns.reduce((s, g) => s + g.installed_parts.length, 0)} installed parts`);
    } else {
      window.notifyWarn?.("JBM import partial", `${success} ok, ${failure} failed. See log.`);
    }
  };

  const totalParts = parsed ? parsed.guns.reduce((s, g) => s + g.installed_parts.length, 0) : 0;
  const distinctParts = parsed ? new Set(parsed.guns.flatMap((g) => g.installed_parts.map((p) => p.part_no))).size : 0;

  return (
    <>
      <WSTitle
        eyebrow="Data · Items · JBM importer"
        title="Import JBM Plant 1 Spare Matrix"
        meta={parsed ? `${parsed.guns.length} guns ready` : "drag XLSX to begin"}
      />

      <div className="ws-content">
        <Card title="Customer + location" eyebrow="step 1">
          <div className="form-grid">
            <div>
              <label htmlFor="jbm-customer" className="label">Customer</label>
              <select id="jbm-customer" className="select"
                      value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={customers.loading}>
                <option value="">Select customer…</option>
                {customers.data.map((c) => (
                  <option key={c.id} value={c.id}>{c.customer_name || c.customer_key}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="jbm-location" className="label">Location (optional)</label>
              <select id="jbm-location" className="select"
                      value={locationId} onChange={(e) => setLocationId(e.target.value)}
                      disabled={!customerId || locations.loading}>
                <option value="">— any —</option>
                {locations.data.map((l) => (
                  <option key={l.id} value={l.id}>{l.plant_name || l.location_code}</option>
                ))}
              </select>
            </div>
          </div>
        </Card>

        <Card title="Upload spare matrix XLSX" eyebrow="step 2">
          <div className="dotgrid" style={{
            border: "1px dashed var(--hairline)", borderRadius: 6,
            padding: 24, textAlign: "center", marginBottom: 12,
          }}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls"
                   style={{ display: "none" }}
                   onChange={(e) => onFile(e.target.files?.[0])} />
            <Btn kind="primary" onClick={() => fileRef.current?.click()} disabled={busy || !customerId}>
              {Icon.upload} Choose XLSX
            </Btn>
            <div className="mono-sm" style={{ marginTop: 8, color: "var(--ink-3)" }}>
              Sheet "Plant 1" or "Spare Matrix" is preferred. The first sheet is used as a fallback.
            </div>
          </div>
          {parseError && (
            <Banner kind="bad" icon={Icon.alert} title="Parse failed">
              <span className="mono-sm">{String(parseError.message || parseError)}</span>
            </Banner>
          )}
        </Card>

        {parsed && (
          <Card title="Preview" eyebrow="step 3">
            <KPIRow cols={4}>
              <KPI lbl="Guns detected" v={String(parsed.guns.length)} d={parsed.sheetName} />
              <KPI lbl="Spare columns" v={String(parsed.partColumns.length)} />
              <KPI lbl="Total fitments" v={String(totalParts)} />
              <KPI lbl="Distinct parts" v={String(distinctParts)} />
            </KPIRow>

            <div style={{ marginTop: 14, maxHeight: 320, overflow: "auto" }}>
              <table className="tbl">
                <thead><tr>
                  <th>Gun no</th>
                  <th>Plant / line</th>
                  <th>Robot</th>
                  <th className="r">Qty</th>
                  <th className="r">Parts</th>
                </tr></thead>
                <tbody>
                  {parsed.guns.slice(0, 30).map((g, i) => (
                    <tr key={i}>
                      <td className="mono"><span className="pri">{g.gun_no}</span><div className="mono-sm">{g.gun_type || "—"}</div></td>
                      <td>{g.plant_name || "—"}<div className="mono-sm">{g.line_name || ""} {g.zone_name ? `· ${g.zone_name}` : ""}</div></td>
                      <td>{g.robot_make || "—"}<div className="mono-sm">{g.robot_no || ""}</div></td>
                      <td className="r mono">{g.qty}</td>
                      <td className="r mono">{g.installed_parts.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.guns.length > 30 && (
                <div className="mono-sm" style={{ padding: 8, textAlign: "center", color: "var(--ink-3)" }}>
                  Showing 30 of {parsed.guns.length} guns.
                </div>
              )}
            </div>
          </Card>
        )}

        {parsed && (
          <Card title="Import" eyebrow="step 4">
            <Btn kind="primary" onClick={apply} disabled={busy || !customerId || parsed.guns.length === 0}>
              {Icon.download} Import {parsed.guns.length} guns to Supabase
            </Btn>
            {progress.total > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="hbar live" style={{ height: 8 }}>
                  <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </div>
                <div className="mono-sm" style={{ marginTop: 6 }}>
                  {progress.done} / {progress.total} guns processed
                </div>
                {progress.log.length > 0 && (
                  <div style={{ marginTop: 10, maxHeight: 240, overflow: "auto", border: "1px solid var(--hairline-2)", borderRadius: 4 }}>
                    {progress.log.slice(-30).map((entry, i) => (
                      <div key={i} className="mono-sm" style={{
                        padding: "4px 8px",
                        color: entry.ok ? "var(--sage)" : "var(--rust)",
                        borderBottom: "1px dashed var(--hairline-2)",
                      }}>
                        {entry.ok ? "ok" : "fail"} · {entry.gun} {entry.ok ? `· ${entry.parts} parts` : `· ${entry.error}`}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
};

window.JbmImporter = WiredJbmImporter;

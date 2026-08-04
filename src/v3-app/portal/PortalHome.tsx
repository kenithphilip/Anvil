import React, { useEffect, useState } from "react";
import { PortalAPI } from "./api";

// Read-only portal home: who am I / which customer, the shared spare matrices,
// and a selected matrix in full (spare-category columns + per-gun rows + the
// committed EG/2D/3D drawings). Everything comes from the session-authed
// /api/portal/view (Bearer, not a URL token).

interface MatrixHeader { id: string; name?: string; project_name?: string; updated_at?: string; }
interface DrawingRow { gun_no: string; kind: string; format?: string; original_filename?: string; link_url?: string | null; }

const KIND_LABEL: Record<string, string> = { eg_sheet: "EG sheet", drawing_2d: "2D", drawing_3d: "3D" };

export const PortalHome: React.FC<{ onLogout: () => void }> = ({ onLogout }) => {
  const [me, setMe] = useState<any>(null);
  const [matrices, setMatrices] = useState<MatrixHeader[] | null>(null);
  const [selected, setSelected] = useState<any>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [m, list] = await Promise.all([PortalAPI.me(), PortalAPI.view("spares")]);
        if (cancel) return;
        setMe(m); setMatrices(list?.spare_matrices || []);
      } catch (x: any) {
        if (cancel) return;
        setErr(x?.message || "Failed to load");
        if (/session|401|not a portal/i.test(x?.message || "")) onLogout();
      }
    })();
    return () => { cancel = true; };
  }, [onLogout]);

  const open = async (id: string) => {
    setLoadingDetail(true); setSelected(null); setErr(null);
    try { setSelected(await PortalAPI.view("spare_matrix", "&matrix_id=" + encodeURIComponent(id))); }
    catch (x: any) { setErr(x?.message || "Failed to load matrix"); }
    finally { setLoadingDetail(false); }
  };

  const customerName = me?.customer?.customer_name || "—";

  return (
    <div className="pt-app">
      <header className="pt-topbar">
        <div className="pt-brand-sm">Customer Portal</div>
        <div className="pt-spacer" />
        <span className="pt-who">{customerName}{me?.user?.email ? " · " + me.user.email : ""}</span>
        <button className="pt-btn pt-btn-ghost" onClick={onLogout}>Sign out</button>
      </header>

      <main className="pt-main">
        {err && <div className="pt-error">{err}</div>}

        <section className="pt-card">
          <h2 className="pt-h2">Shared spare matrices</h2>
          {matrices === null ? <div className="pt-muted">Loading…</div>
            : matrices.length === 0 ? <div className="pt-muted">Nothing has been shared with you yet.</div>
            : (
              <ul className="pt-list">
                {matrices.map((m) => (
                  <li key={m.id}>
                    <button className={"pt-row-btn" + (selected?.matrix?.id === m.id ? " pt-active" : "")} onClick={() => open(m.id)}>
                      <strong>{m.name || "Spare matrix"}</strong>
                      {m.project_name ? <span className="pt-muted"> · {m.project_name}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </section>

        {loadingDetail && <div className="pt-muted">Opening…</div>}

        {selected?.matrix && (
          <section className="pt-card">
            <h2 className="pt-h2">{selected.matrix.name || "Spare matrix"}{selected.matrix.project_name ? " — " + selected.matrix.project_name : ""}</h2>

            <div className="pt-tablewrap">
              <table className="pt-table">
                <thead>
                  <tr>
                    <th>Station</th><th>Robot</th><th>Gun</th>
                    {(selected.columns || []).map((c: any, i: number) => <th key={i}>{c.col_name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {(selected.rows || []).map((r: any, i: number) => (
                    <tr key={i}>
                      <td>{r.station_no || ""}</td><td>{r.robot_no || ""}</td><td><strong>{r.gun_no || ""}</strong></td>
                      {(selected.columns || []).map((c: any, j: number) => (
                        <td key={j} className="pt-cell">{(r.spare_values || {})[c.col_name] || ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="pt-h3">Drawings</h3>
            {(selected.drawings || []).length === 0
              ? <div className="pt-muted">No drawings shared for this matrix.</div>
              : (
                <ul className="pt-list">
                  {(selected.drawings as DrawingRow[]).map((d, i) => (
                    <li key={i} className="pt-draw">
                      <span className="pt-chip">{KIND_LABEL[d.kind] || d.kind}</span>
                      <strong>{d.gun_no}</strong>
                      <span className="pt-muted"> {d.original_filename || ""}</span>
                      {d.link_url ? <a className="pt-link" href={d.link_url} target="_blank" rel="noreferrer">open</a> : null}
                    </li>
                  ))}
                </ul>
              )}
          </section>
        )}
      </main>
    </div>
  );
};

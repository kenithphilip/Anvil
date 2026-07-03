import React, { useEffect, useState } from "react";
import { Banner, Btn, Chip } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";

// Customer contacts manager.
//
// The customer_contacts table + /api/customers/contacts CRUD shipped in
// migration 065, but no screen ever wired it: the customers detail card
// showed a single contact_email and nothing else. This panel surfaces
// the full multi-contact list with add / edit / delete / make-primary,
// backed by the existing facade methods.

type Contact = any;

const BLANK = { id: null, name: "", email: "", phone: "", role: "", is_primary: false };
const ROLES = ["procurement", "accounts", "dispatch", "qa", "owner", "other"];

export const CustomerContactsPanel: React.FC<{ customerId: string }> = ({ customerId }) => {
  // Guard rail (2026-06): customer-master edits are admin-only. Non-admins
  // see the contact list read-only.
  const canEdit = RBAC.isAdmin();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [form, setForm] = useState<Contact>({ ...BLANK });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setContacts(null);
    setErr(null);
    Promise.resolve(AnvilBackend?.customers?.listContacts?.({ customer_id: customerId }))
      .then((resp: any) => setContacts(Array.isArray(resp) ? resp : resp?.contacts || []))
      .catch((e: any) => setErr(e?.message || String(e)));
  };
  useEffect(load, [customerId]);

  const startAdd = () => { setForm({ ...BLANK }); setOpen(true); setErr(null); };
  const startEdit = (c: Contact) => { setForm({ ...c }); setOpen(true); setErr(null); };
  const setField = (k: string, v: any) => setForm((f: Contact) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name && !form.email) { setErr("A contact needs at least a name or an email."); return; }
    setBusy(true);
    setErr(null);
    try {
      if (form.id) {
        await AnvilBackend?.customers?.updateContact?.({
          id: form.id, name: form.name, email: form.email, phone: form.phone, role: form.role, is_primary: form.is_primary,
        });
      } else {
        await AnvilBackend?.customers?.upsertContact?.({
          customer_id: customerId, name: form.name, email: form.email, phone: form.phone, role: form.role, is_primary: form.is_primary,
        });
      }
      window.notifySuccess?.("Contact saved", form.name || form.email);
      setOpen(false);
      setForm({ ...BLANK });
      load();
    } catch (e: any) {
      const msg = e?.message || String(e);
      setErr(msg);
      window.notifyError?.("Could not save contact", msg);
    } finally { setBusy(false); }
  };

  const makePrimary = async (c: Contact) => {
    try { await AnvilBackend?.customers?.updateContact?.({ id: c.id, is_primary: true }); load(); }
    catch (e: any) { setErr(e?.message || String(e)); }
  };

  const del = async (c: Contact) => {
    if (typeof confirm === "function" && !confirm(`Delete contact "${c.name || c.email}"?`)) return;
    try { await AnvilBackend?.customers?.deleteContact?.(c.id); load(); }
    catch (e: any) {
      const msg = e?.status === 403 ? "Needs sales_manager / finance / admin" : (e?.message || String(e));
      setErr(msg);
      window.notifyError?.("Could not delete contact", msg);
    }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
          Contacts {contacts ? `(${contacts.length})` : ""}
        </div>
        {canEdit
          ? <Btn sm kind="ghost" onClick={startAdd}>+ Add contact</Btn>
          : <span className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10 }}>Read-only (admin to edit)</span>}
      </div>

      {err && <Banner kind="bad" title="Contacts">{err}</Banner>}

      {contacts == null ? (
        <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 8 }}>Loading...</div>
      ) : contacts.length === 0 && !open ? (
        <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 8 }}>No contacts yet.</div>
      ) : (
        <table className="tbl" style={{ fontSize: 12 }}>
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th></th><th></th></tr></thead>
          <tbody>
            {(contacts || []).map((c) => (
              <tr key={c.id}>
                <td>{c.name || "-"}</td>
                <td className="mono-sm">{c.email || "-"}</td>
                <td className="mono-sm">{c.phone || "-"}</td>
                <td>{c.role ? <Chip k="ghost">{c.role}</Chip> : "-"}</td>
                <td>{c.is_primary ? <Chip k="good">primary</Chip> : (canEdit ? <Btn sm kind="ghost" onClick={() => makePrimary(c)}>Make primary</Btn> : "-")}</td>
                <td className="r">
                  {canEdit && <>
                    <Btn sm kind="ghost" onClick={() => startEdit(c)}>Edit</Btn>
                    <Btn sm kind="ghost" onClick={() => del(c)}>Delete</Btn>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--line)", borderRadius: 6 }}>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <input className="input" aria-label="Contact name" placeholder="Name" value={form.name || ""} onChange={(e) => setField("name", e.target.value)} style={{ width: 180 }} />
            <input className="input mono" aria-label="Contact email" placeholder="email@company.com" value={form.email || ""} onChange={(e) => setField("email", e.target.value)} style={{ width: 200 }} />
            <input className="input mono" aria-label="Contact phone" placeholder="Phone" value={form.phone || ""} onChange={(e) => setField("phone", e.target.value)} style={{ width: 140 }} />
            <select className="select" aria-label="Contact role" value={form.role || ""} onChange={(e) => setField("role", e.target.value)}>
              <option value="">role...</option>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <label className="mono-sm" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" aria-label="Primary contact" checked={!!form.is_primary} onChange={(e) => setField("is_primary", e.target.checked)} /> primary
            </label>
          </div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
            <Btn sm kind="ghost" onClick={() => { setOpen(false); setForm({ ...BLANK }); }}>Cancel</Btn>
            <Btn sm kind="primary" disabled={busy} onClick={save}>{busy ? "Saving..." : (form.id ? "Update contact" : "Add contact")}</Btn>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomerContactsPanel;

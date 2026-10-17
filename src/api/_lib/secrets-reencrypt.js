// Rewrites a tenant's stored credentials from the v1 format (IV in a
// separate <bundle>_iv column) to v2 (each value carries its own IV). See
// _lib/secrets.js for both formats. Used by /api/admin/secrets_reencrypt.
//
// Idempotent: a value already in v2 is left alone, so a second run changes
// nothing. A value that does not decrypt is reported and left alone. The
// *_iv columns are never changed: a value this run cannot read may still
// need its IV.

import { encryptField, openField } from "./secrets.js";

// Every encrypted credential column, grouped by the IV column its v1 values
// were written with. Rows come from select("*"), so a column the live schema
// does not have yet reads as undefined and is skipped.
//
// `guard` names the columns that must still hold the values we read for the
// update to apply (default: the columns being rewritten). The Graph token
// values are too long to send as a filter, and every token write also sets
// graph_token_expires_at, so that column stands in for them.
export const SECRET_TABLES = [
  {
    table: "tenant_settings",
    key: "tenant_id",
    bundles: [
      { iv: "netsuite_creds_iv", fields: ["netsuite_consumer_key_enc", "netsuite_consumer_secret_enc", "netsuite_token_id_enc", "netsuite_token_secret_enc"] },
      { iv: "sap_creds_iv", fields: ["sap_client_id_enc", "sap_client_secret_enc"] },
      { iv: "d365_creds_iv", fields: ["d365_client_id_enc", "d365_client_secret_enc"] },
      { iv: "acumatica_creds_iv", fields: ["acumatica_username_enc", "acumatica_password_enc"] },
      { iv: "razorpay_creds_iv", fields: ["razorpay_key_id_enc", "razorpay_key_secret_enc"] },
      { iv: "docusign_creds_iv", fields: ["docusign_rsa_private_key_enc"] },
      { iv: "graph_creds_iv", fields: ["graph_client_id_enc", "graph_client_secret_enc"] },
      { iv: "graph_token_iv", fields: ["graph_access_token_enc", "graph_refresh_token_enc"], guard: ["graph_token_expires_at"] },
      {
        iv: "docai_creds_iv",
        fields: [
          "docai_reducto_api_key_enc", "docai_azure_di_key_enc", "docai_unstructured_api_key_enc",
          "docai_gemini_api_key_enc", "docai_mistral_api_key_enc", "docai_mistral_ocr_api_key_enc",
          "docai_docling_api_key_enc", "docai_marker_api_key_enc", "docai_llamacloud_api_key_enc",
          "gst_provider_api_key_enc",
        ],
      },
      { iv: "p21_creds_iv", fields: ["p21_username_enc", "p21_password_enc"] },
      { iv: "eclipse_creds_iv", fields: ["eclipse_username_enc", "eclipse_password_enc"] },
      { iv: "sxe_creds_iv", fields: ["sxe_client_id_enc", "sxe_client_secret_enc"] },
      { iv: "sagex3_creds_iv", fields: ["sagex3_client_id_enc", "sagex3_client_secret_enc"] },
      { iv: "ifs_creds_iv", fields: ["ifs_client_id_enc", "ifs_client_secret_enc"] },
      { iv: "oracle_fusion_creds_iv", fields: ["oracle_fusion_client_id_enc", "oracle_fusion_client_secret_enc"] },
      { iv: "ramco_creds_iv", fields: ["ramco_client_id_enc", "ramco_client_secret_enc"] },
      { iv: "jde_creds_iv", fields: ["jde_username_enc", "jde_password_enc"] },
      { iv: "plex_creds_iv", fields: ["plex_api_key_enc"] },
      { iv: "jobboss_creds_iv", fields: ["jobboss_token_enc", "jobboss_sftp_password_enc"] },
      { iv: "oracle_ebs_creds_iv", fields: ["oracle_ebs_username_enc", "oracle_ebs_password_enc"] },
      { iv: "proalpha_creds_iv", fields: ["proalpha_username_enc", "proalpha_password_enc"] },
      { iv: "aa_creds_iv", fields: ["aa_client_id_enc", "aa_client_secret_enc"] },
      { iv: "treds_creds_iv", fields: ["treds_api_key_enc", "treds_api_secret_enc"] },
    ],
  },
  { table: "tally_companies", key: "id", bundles: [{ iv: "bridge_iv", fields: ["bridge_token_enc"] }] },
  { table: "plm_systems", key: "id", bundles: [{ iv: "creds_iv", fields: ["username_enc", "password_enc", "api_key_enc"] }] },
  { table: "inbound_chat_configs", key: "id", bundles: [{ iv: "creds_iv", fields: ["creds_enc"] }] },
  { table: "voice_configs", key: "id", bundles: [{ iv: "creds_iv", fields: ["api_key_enc"] }] },
];

// Pure: plan the rewrite of one bundle in one row. Returns
//   { patch, v2, unreadable }
// patch maps each v1 column to its new v2 value, v2 counts the columns
// already in v2, unreadable lists the columns that do not decrypt.
export const planBundle = (row, bundle) => {
  const patch = {};
  let v2 = 0;
  const unreadable = [];
  for (const col of bundle.fields) {
    const value = row[col];
    if (value == null || value === "") continue;
    let opened = null;
    try { opened = openField(value, row[bundle.iv]); } catch (_e) { opened = null; }
    if (!opened) unreadable.push(col);
    else if (opened.version === 2) v2 += 1;
    else patch[col] = encryptField(opened.plaintext);
  }
  return { patch, v2, unreadable };
};

// Re-encrypt every v1 credential the tenant has. With apply=false nothing is
// written and `v1` says how many values would be rewritten. Returns a report
// of counts and column names only; it never holds a credential.
export const reencryptTenantSecrets = async (svc, tenantId, { apply = false } = {}) => {
  const totals = { v1: 0, rewritten: 0, already_v2: 0, unreadable: 0, conflicts: 0, errors: 0 };
  const tables = [];
  for (const spec of SECRET_TABLES) {
    const t = { table: spec.table, rows: 0, v1: 0, rewritten: 0, already_v2: 0, unreadable: [], conflicts: 0, error: null };
    tables.push(t);
    const read = await svc.from(spec.table).select("*").eq("tenant_id", tenantId);
    if (read.error) { t.error = read.error.message; totals.errors += 1; continue; }
    for (const row of read.data || []) {
      t.rows += 1;
      for (const bundle of spec.bundles) {
        const plan = planBundle(row, bundle);
        const cols = Object.keys(plan.patch);
        t.already_v2 += plan.v2;
        t.v1 += cols.length;
        for (const col of plan.unreadable) t.unreadable.push(spec.key === "tenant_id" ? col : row[spec.key] + ":" + col);
        if (!apply || !cols.length) continue;
        let q = svc.from(spec.table).update(plan.patch).eq("tenant_id", tenantId);
        if (spec.key !== "tenant_id") q = q.eq(spec.key, row[spec.key]);
        // Apply only if nobody saved these credentials since we read them;
        // otherwise this would put the old value back.
        for (const col of bundle.guard || cols) q = row[col] == null ? q.is(col, null) : q.eq(col, row[col]);
        const upd = await q.select(spec.key);
        if (upd.error) { t.error = upd.error.message; totals.errors += 1; }
        else if ((upd.data || []).length) t.rewritten += cols.length;
        else t.conflicts += 1;
      }
    }
    totals.v1 += t.v1;
    totals.rewritten += t.rewritten;
    totals.already_v2 += t.already_v2;
    totals.unreadable += t.unreadable.length;
    totals.conflicts += t.conflicts;
  }
  return { apply, totals, tables };
};

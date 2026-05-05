// Unified PLM client for Phase 5.5.
//
// Covers PTC Windchill (OData/REST) and Arena PLM (REST). Both
// expose Items/Parts, BOMs, and ECOs/ECNs. Auth differs: Windchill
// uses HTTP Basic; Arena uses an X-Arena-Key header.
//
// Each operation here reads creds from a `plm_systems` row, hits
// the upstream API, and normalises into our canonical shape:
//
//   { part_number, description, revision, state, structure, raw }
//   { eco_number, title, status, affected_parts, effective_date, raw }
//
// Network errors and 4xx responses raise; the caller is responsible
// for retry queueing (cron) and per-tenant audit.

import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";

// ── creds helpers ─────────────────────────────────────────────────
export const plmDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.creds_iv) {
      try { return decryptField(s[encCol], s.creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.username = tryDec("username_enc", "username");
  out.password = tryDec("password_enc", null);
  out.api_key = tryDec("api_key_enc", "api_key");
  return out;
};

export const plmEncryptCreds = ({ username, password, apiKey }) => {
  if (!isSecretsConfigured()) {
    return {
      username: username || null,
      username_enc: null,
      password_enc: null,
      api_key: apiKey || null,
      api_key_enc: null,
      creds_iv: null,
    };
  }
  const iv = newIv();
  return {
    username: null,
    username_enc: username ? encryptField(username, iv) : null,
    password_enc: password ? encryptField(password, iv) : null,
    api_key: null,
    api_key_enc: apiKey ? encryptField(apiKey, iv) : null,
    creds_iv: iv,
  };
};

export const plmIsConfigured = (s) => {
  if (!s?.base_url) return false;
  if (s.system === "windchill") return !!(s.username && s.password);
  if (s.system === "arena") return !!s.api_key;
  return false;
};

// ── shared HTTP wrapper ───────────────────────────────────────────
const authHeaders = (s) => {
  const h = { Accept: "application/json" };
  if (s.system === "windchill") {
    const tok = Buffer.from(`${s.username}:${s.password}`).toString("base64");
    h.Authorization = "Basic " + tok;
  } else if (s.system === "arena") {
    h["X-Arena-Key"] = s.api_key;
  }
  return h;
};

const callJson = async (s, path, { method = "GET", body, query } = {}) => {
  const url = new URL(s.base_url.replace(/\/+$/, "") + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }
  const resp = await fetch(url, {
    method,
    headers: { ...authHeaders(s), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`PLM ${s.system} ${method} ${path} ${resp.status}: ${text.slice(0, 240)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
};

// ── probe (used by /api/plm/connect to validate creds) ────────────
export const plmProbe = async (s) => {
  if (s.system === "windchill") {
    // Trivial OData ping.
    return callJson(s, "/Windchill/servlet/odata/v1/$metadata?format=json");
  }
  if (s.system === "arena") {
    // Arena exposes /v1/me as a key-validation probe.
    return callJson(s, "/v1/me");
  }
  throw new Error("Unknown PLM system: " + s.system);
};

// ── BOM pull ──────────────────────────────────────────────────────
// Both systems return a flat list of usage links keyed off a parent
// part. We recurse client-side to build the canonical structure tree.

const buildTree = (parentPart, allUsageLinks, allParts, depth = 0) => {
  if (depth > 20) return { part_no: parentPart.number, qty: 1, uom: parentPart.uom || "ea", children: [], _truncated: true };
  const childLinks = allUsageLinks.filter((u) => u.parent === parentPart.id);
  const children = childLinks.map((link) => {
    const child = allParts.find((p) => p.id === link.child);
    if (!child) return null;
    return {
      part_no: child.number,
      description: child.description,
      qty: link.qty || 1,
      uom: link.uom || child.uom || "ea",
      revision: child.revision,
      children: buildTree(child, allUsageLinks, allParts, depth + 1).children,
    };
  }).filter(Boolean);
  return {
    part_no: parentPart.number,
    description: parentPart.description,
    qty: 1,
    uom: parentPart.uom || "ea",
    revision: parentPart.revision,
    children,
  };
};

const flatLeafCount = (node) => {
  if (!node?.children?.length) return 1;
  return node.children.reduce((s, c) => s + flatLeafCount(c), 0);
};

export const plmFetchBoms = async (s, opts = {}) => {
  const { since } = opts;
  let parts = [];
  let usageLinks = [];

  if (s.system === "windchill") {
    // Windchill OData v1: /ProdMgmt/Parts and /ProdMgmt/PartUses
    const partsResp = await callJson(s, "/Windchill/servlet/odata/v1/ProdMgmt/Parts", {
      query: {
        $top: 500,
        ...(since ? { $filter: `LastModified ge ${since}` } : {}),
      },
    });
    parts = (partsResp.value || []).map((p) => ({
      id: p.ID,
      number: p.Number,
      description: p.Name,
      revision: p.Revision,
      state: p.State?.Value,
      uom: p.DefaultUnit,
      raw: p,
    }));
    const linksResp = await callJson(s, "/Windchill/servlet/odata/v1/ProdMgmt/PartUses", {
      query: { $top: 5000 },
    });
    usageLinks = (linksResp.value || []).map((l) => ({
      parent: l.Uses?.ID,
      child: l.UsedBy?.ID,
      qty: l.Quantity,
      uom: l.Unit,
    }));
  } else if (s.system === "arena") {
    // Arena: /v1/items + /v1/items/{id}/bom on demand. Pull
    // released items first.
    const itemsResp = await callJson(s, "/v1/items", {
      query: {
        limit: 500,
        ...(since ? { lastModifiedAfter: since } : {}),
      },
    });
    parts = (itemsResp.results || []).map((it) => ({
      id: it.guid,
      number: it.number,
      description: it.description,
      revision: it.revision,
      state: it.itemStatus?.name,
      uom: it.unitOfMeasure,
      raw: it,
    }));
    // Arena doesn't expose a flat usage list; we fetch BOM per
    // item. Cap at 50 items per pass to stay inside the cron budget.
    for (const p of parts.slice(0, 50)) {
      try {
        const bomResp = await callJson(s, `/v1/items/${encodeURIComponent(p.id)}/bom`);
        for (const row of (bomResp.results || [])) {
          usageLinks.push({
            parent: p.id,
            child: row.childItem?.guid,
            qty: row.quantity,
            uom: row.unitOfMeasure,
          });
        }
      } catch (err) {
        // Tolerate per-item failures so a single 404 doesn't kill
        // the batch; surface in raw for debugging.
        p.raw = { ...p.raw, _bom_error: err.message };
      }
    }
  }

  // Build canonical BOMs only for parts that have at least one
  // child link OR are explicitly released (so we mirror leaf
  // assemblies). This keeps the table from filling with thousands
  // of trivial single-part rows.
  const parentsWithChildren = new Set(usageLinks.map((u) => u.parent));
  return parts
    .filter((p) => parentsWithChildren.has(p.id))
    .map((p) => {
      const tree = buildTree(p, usageLinks, parts);
      return {
        external_id: p.id,
        part_number: p.number,
        description: p.description,
        revision: p.revision,
        state: p.state,
        structure: tree,
        flat_count: flatLeafCount(tree),
        raw: p.raw,
      };
    });
};

// ── ECO pull ──────────────────────────────────────────────────────
export const plmFetchChanges = async (s, opts = {}) => {
  const { since } = opts;
  if (s.system === "windchill") {
    const resp = await callJson(s, "/Windchill/servlet/odata/v1/ChangeMgmt/ChangeNotices", {
      query: {
        $top: 500,
        ...(since ? { $filter: `LastModified ge ${since}` } : {}),
      },
    });
    return (resp.value || []).map((c) => ({
      external_id: c.ID,
      eco_number: c.Number,
      title: c.Name,
      description: c.Description,
      status: c.State?.Value,
      affected_parts: (c.AffectedParts || []).map((p) => p.Number).filter(Boolean),
      effective_date: c.EffectiveDate ? c.EffectiveDate.slice(0, 10) : null,
      raw: c,
    }));
  }
  if (s.system === "arena") {
    const resp = await callJson(s, "/v1/changes", {
      query: { limit: 500, ...(since ? { lastModifiedAfter: since } : {}) },
    });
    return (resp.results || []).map((c) => ({
      external_id: c.guid,
      eco_number: c.number,
      title: c.title,
      description: c.description,
      status: c.changeStatus?.name,
      affected_parts: (c.affectedItems || []).map((p) => p.number).filter(Boolean),
      effective_date: c.effectiveDate ? c.effectiveDate.slice(0, 10) : null,
      raw: c,
    }));
  }
  throw new Error("Unknown PLM system: " + s.system);
};

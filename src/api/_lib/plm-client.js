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
import { safeFetch } from "./safe-fetch.js";

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
  const resp = await safeFetch(url, {
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
  // Count what we could NOT resolve, rather than only dropping it.
  //
  // `allParts` is the INCREMENTAL page ($filter: LastModified ge since) while
  // usage links are pulled unfiltered, so a parent that was just revised
  // arrives with its UNCHANGED children absent from the page — and silently
  // dropping them makes the stored structure look like an assembly whose parts
  // were deleted. Anything comparing that tree against our own BOM would
  // report a removal that never happened, and that is the normal case on every
  // tick after the first, not an edge case.
  //
  // Recording the count lets a consumer refuse an incomplete tree. It does not
  // make the tree complete; only resolving the children would do that.
  let unresolved = 0;
  const children = childLinks.map((link) => {
    const child = allParts.find((p) => p.id === link.child);
    if (!child) { unresolved++; return null; }
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
    // How many of this level's child links pointed at a part the pull did not
    // return. Non-zero means the structure below is INCOMPLETE.
    unresolved_children: unresolved,
    children,
  };
};

const flatLeafCount = (node) => {
  if (!node?.children?.length) return 1;
  return node.children.reduce((s, c) => s + flatLeafCount(c), 0);
};

// Fetch the child parts an incremental pull left behind.
//
// This is the fix for the defect that made BOM drift unusable: parts come back
// filtered by LastModified while usage links do not, so a parent that was just
// revised arrives with its UNCHANGED children absent. buildTree then records
// them as unresolved and the comparison refuses the tree — correct, but it
// means the feature almost never fires.
//
// Resolving them is what makes it fire. Windchill needs a second Parts call
// keyed on the missing IDs; Arena already returns the child inline on the BOM
// row and never needed one.
//
// OPTIMISTIC AND FAIL-SAFE. Anything still unresolved after this stays
// unresolved, buildTree still counts it, and comparable() still refuses the
// tree. So a failed or partial resolve degrades to exactly today's behaviour —
// quiet — rather than to a false "the supplier deleted these parts". That
// matters because I cannot test this against a real Windchill: if the filter
// syntax is wrong the pass returns nothing and nothing breaks.
const MAX_RESOLVE_IDS = 200;   // bounded: this runs inside a 20s cron budget
const RESOLVE_CHUNK = 20;      // OData $filter goes in the URL

const resolveMissingChildren = async (s, parts, usageLinks) => {
  const have = new Set(parts.map((p) => p.id));
  const missing = [...new Set(usageLinks.map((u) => u.child).filter((id) => id && !have.has(id)))];
  if (!missing.length) return { requested: 0, resolved: 0 };
  const wanted = missing.slice(0, MAX_RESOLVE_IDS);
  let resolved = 0;

  if (s.system === "windchill") {
    for (let i = 0; i < wanted.length; i += RESOLVE_CHUNK) {
      const batch = wanted.slice(i, i + RESOLVE_CHUNK);
      try {
        const resp = await callJson(s, "/Windchill/servlet/odata/v1/ProdMgmt/Parts", {
          query: { $top: RESOLVE_CHUNK, $filter: batch.map((id) => `ID eq '${String(id).replace(/'/g, "''")}'`).join(" or ") },
        });
        for (const p of (resp.value || [])) {
          if (have.has(p.ID)) continue;
          have.add(p.ID);
          parts.push({ id: p.ID, number: p.Number, description: p.Name, revision: p.Revision, state: p.State?.Value, uom: p.DefaultUnit, raw: p });
          resolved++;
        }
      } catch (_e) { /* leave them unresolved; the tree will be refused, not misread */ }
    }
  }
  return { requested: wanted.length, resolved, capped: missing.length > wanted.length };
};

export const plmFetchBoms = async (s, opts = {}) => {
  const { since } = opts;
  let parts = [];
  let usageLinks = [];
  // Function-scoped, not block-scoped inside the arena branch: a const declared
  // in that branch is invisible where the results are merged below, so the
  // merge would silently never happen.
  const arenaChildParts = [];
  const arenaSeen = new Set();

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
    for (const x of parts) arenaSeen.add(x.id);
    for (const p of parts.slice(0, 50)) {
      try {
        const bomResp = await callJson(s, `/v1/items/${encodeURIComponent(p.id)}/bom`);
        for (const row of (bomResp.results || [])) {
          const kid = row.childItem;
          usageLinks.push({
            parent: p.id,
            child: kid?.guid,
            qty: row.quantity,
            uom: row.unitOfMeasure,
          });
          // Arena returns the child INLINE on the BOM row, so a child outside
          // the incremental items page is already in hand — no second call.
          // Without this the Arena tree was truncated exactly like Windchill's,
          // while the data to complete it sat unread on the same response.
          if (kid?.guid && !arenaSeen.has(kid.guid)) {
            arenaSeen.add(kid.guid);
            arenaChildParts.push({
              id: kid.guid,
              number: kid.number ?? kid.itemNumber ?? String(kid.guid),
              description: kid.description ?? null,
              revision: kid.revision ?? null,
              state: kid.itemStatus?.name ?? null,
              uom: kid.unitOfMeasure ?? null,
              raw: kid,
            });
          }
        }
      } catch (err) {
        // Tolerate per-item failures so a single 404 doesn't kill
        // the batch; surface in raw for debugging.
        p.raw = { ...p.raw, _bom_error: err.message };
      }
    }
  }

  if (arenaChildParts.length) parts = parts.concat(arenaChildParts);

  // Resolve whatever the incremental page left behind, so buildTree can
  // produce a COMPLETE structure rather than one the comparison must refuse.
  const resolution = await resolveMissingChildren(s, parts, usageLinks);
  // Carried out to the caller so a quiet sync can be told apart from a broken
  // one. Without it, "0 drifted" reads the same whether every BOM matched or
  // every tree was refused as incomplete — and those need opposite responses.

  // Build canonical BOMs only for parts that have at least one
  // child link OR are explicitly released (so we mirror leaf
  // assemblies). This keeps the table from filling with thousands
  // of trivial single-part rows.
  const parentsWithChildren = new Set(usageLinks.map((u) => u.parent));
  const boms = parts
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
  // An array with the summary attached, so the existing caller keeps working
  // unchanged (it maps over the rows) while the sync can still read how much
  // of the structure the pull was actually able to assemble.
  boms.resolution = resolution;
  return boms;
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

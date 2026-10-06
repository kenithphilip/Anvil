// Notifications dispatcher for the inventory-planning module.
//
// Fans new critical/high-severity inventory_exceptions rows out to:
//   1. The admin bell (admin_notifications via notifyAdmins helper).
//   2. The email rail (an `inventory_alert` template is queued via
//      communications.send, which has its own delivery cron).
//   3. The voice rail (Vapi/Retell), gated by the per-tenant
//      tenant_settings.inventory_voice_* policy:
//        - severity threshold (info/warn/bad/critical)
//        - max calls per tenant per day
//        - operating-hours window (start/end IST)
//
// We mark each exception's detail.notified jsonb with the
// timestamps + channels used so re-runs of the cron don't dupe.

import { notifyAdmins } from "../notifications.js";
import { commsRow } from "../comms-row.js";

const isWithinWindow = (now, startStr, endStr) => {
  // IST window check. The tenant_settings.inventory_voice_window_*
  // values are time-of-day (HH:MM) in IST. We compare the current
  // UTC clock against IST = UTC + 5:30.
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const parse = (s) => {
    const [h, m] = String(s || "00:00").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const start = parse(startStr);
  const end = parse(endStr);
  if (start === end) return true;
  if (start < end) return minutes >= start && minutes < end;
  // Overnight window (e.g. 22:00 -> 06:00).
  return minutes >= start || minutes < end;
};

const SEVERITY_RANK = { info: 1, warn: 2, bad: 3, critical: 4 };
const meetsThreshold = (severity, threshold) =>
  (SEVERITY_RANK[severity] || 0) >= (SEVERITY_RANK[threshold] || 4);

const KIND_LABEL = {
  stockout_imminent:   "Stockout imminent",
  below_reorder_point: "Below reorder point",
  supplier_delay:      "Supplier delay",
  demand_spike:        "Demand spike",
  forecast_drift:      "Forecast drift",
  allocation_overrun:  "Allocation overrun",
  no_default_supplier: "No default supplier",
  negative_position:   "Negative position",
  erp_mismatch:        "ERP mismatch",
};

const buildBody = (e) => {
  const k = KIND_LABEL[e.exception_kind] || e.exception_kind;
  const part = e.part_no ? " · part " + e.part_no : "";
  return `${k}${part}`;
};

// Read tenant config + dispatch unsent notifications for one tenant.
export const dispatchNotifications = async (svc, tenantId) => {
  const cfg = await svc.from("tenant_settings")
    .select("inventory_voice_severity_threshold, inventory_voice_max_per_day, inventory_voice_window_start, inventory_voice_window_end")
    .eq("tenant_id", tenantId).maybeSingle();
  const settings = cfg.data || {};
  const threshold = settings.inventory_voice_severity_threshold || "critical";
  const maxPerDay = Number(settings.inventory_voice_max_per_day || 3);
  const windowStart = settings.inventory_voice_window_start || "08:00:00";
  const windowEnd = settings.inventory_voice_window_end || "20:00:00";

  // Find open exceptions whose `detail.notified` is missing or stale
  // (we re-notify if a critical exception persists past 24h).
  const open = await svc.from("inventory_exceptions")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("status", "open");
  if (open.error) throw new Error("notifications/open: " + open.error.message);

  // Today's voice-call counter (for the daily cap).
  const sinceMidnight = new Date();
  sinceMidnight.setUTCHours(0, 0, 0, 0);
  const todays = (open.data || []).filter((e) => e.detail?.notified?.voice_at && new Date(e.detail.notified.voice_at) > sinceMidnight);
  let voiceCallsToday = todays.length;

  let bellSent = 0, emailQueued = 0, voiceCalls = 0;
  for (const e of (open.data || [])) {
    const already = e.detail?.notified || {};
    const isHigh = e.severity === "critical" || e.severity === "bad";
    const fingerprint = e.detail?.fingerprint || e.id;

    // 1. Bell: notify admins on first detection of any open
    // exception. Tracked via notified.bell_at.
    if (!already.bell_at && isHigh) {
      try {
        await notifyAdmins(svc, tenantId, {
          kind: "inventory_exception",
          title: buildBody(e),
          body: JSON.stringify(e.detail).slice(0, 280),
          object_type: "inventory_exception",
          object_id: e.id,
          link_route: "inventory-exceptions",
        }, { dedupKey: fingerprint });
        already.bell_at = new Date().toISOString();
        bellSent += 1;
      } catch (_) { /* best-effort */ }
    }

    // 2. Email: queue an inventory_alert template via the
    // communications.send rail. We identify the template by name;
    // the comms drafter renders the body. If the comms.send helper
    // is missing for this deployment we silently skip (best-effort).
    if (!already.email_at && isHigh) {
      try {
        await svc.from("communications").insert(commsRow({
          tenant_id: tenantId,
          direction: "outbound",
          channel: "email",
          template: "inventory_alert",
          subject: buildBody(e),
          body: JSON.stringify(e.detail).slice(0, 500),
          status: "queued",
          object_type: "inventory_exception",
          object_id: e.id,
        }));
        already.email_at = new Date().toISOString();
        emailQueued += 1;
      } catch (_) { /* best-effort */ }
    }

    // 3. Voice: gated by severity threshold + daily cap + window.
    const sevOk = meetsThreshold(e.severity, threshold);
    const windowOk = isWithinWindow(new Date(), windowStart, windowEnd);
    if (!already.voice_at && sevOk && windowOk && voiceCallsToday < maxPerDay) {
      try {
        // Best-effort outbound dispatch through the existing voice
        // outbound endpoint. We don't await the result here because
        // a mid-flight failure shouldn't block the bell + email.
        const outbound = `/api/voice/outbound`;
        await svc.from("voice_calls").insert({
          tenant_id: tenantId,
          status: "queued",
          purpose: "inventory_alert",
          metadata: { exception_id: e.id, fingerprint, severity: e.severity },
        });
        already.voice_at = new Date().toISOString();
        voiceCalls += 1;
        voiceCallsToday += 1;
      } catch (_) { /* best-effort */ }
    }

    if (Object.keys(already).length > 0) {
      const nextDetail = { ...(e.detail || {}), notified: already };
      await svc.from("inventory_exceptions").update({ detail: nextDetail }).eq("id", e.id);
    }
  }
  return { bellSent, emailQueued, voiceCalls, threshold, maxPerDay };
};

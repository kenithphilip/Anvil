// Shared margin-floor guard for quotes.
//
// Reads the persisted price composition (price_composition_lines,
// written authoritatively by the recompute endpoint) and returns the
// lines whose realized margin fell below the profile's floor. Used to
// gate the SENT transition so a below-floor quote cannot go out without
// an approver (sales_manager / finance / admin).

export const belowFloorLines = async (svc, tenantId, quoteId) => {
  const r = await svc.from("price_composition_lines")
    .select("line_index, part_no, margin_realized, margin_floor")
    .eq("tenant_id", tenantId)
    .eq("quote_id", quoteId);
  if (r.error) throw new Error(r.error.message);
  return (r.data || []).filter(
    (l) => l.margin_realized != null && l.margin_floor != null && Number(l.margin_realized) < Number(l.margin_floor)
  );
};

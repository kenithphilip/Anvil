// How each side of a terms flag says where its wording came from
// (docs/SO_TERMS_AND_HANDOFF_SCOPE.md 3.3, "Shown as"). One place, so the
// API, the Terms tab and any export say the same thing.
//
// The rule the labels exist for: a customer-master value is never "from PO".
//
// Pure: no I/O.

const page = (rec) => (rec && rec.page ? ", page " + rec.page : "");

export const provenanceLabel = (rec) => {
  if (!rec || !rec.provenance) return null;
  const q = rec.quote_number ? " " + rec.quote_number : "";
  switch (rec.provenance) {
    case "po_text":
      return "from PO" + page(rec) + (rec.method === "extraction" ? " (read by extraction, not the terms reader)" : "");
    case "operator_entry":
      return "entered on the order header";
    case "customer_master":
      if (rec.basis === "grounding_marker") return "from customer master (filled in when the PO stated none)";
      if (rec.basis === "equals_master_default") return "from customer master (the same as the customer's default, so not counted as PO wording)";
      return "from customer master";
    case "customer_terms_pack":
      return "from customer T&C pack" + (rec.pack_name ? " " + rec.pack_name : "") + (rec.pack_version ? " v" + rec.pack_version : "");
    case "quote_snapshot":
      return "from quote" + q + ", as sent" + (rec.snapshot_at ? " on " + String(rec.snapshot_at).slice(0, 10) : "");
    case "quote_template_live":
      if (rec.source_kind === "template") return "from our quote template, as of today (not as sent)";
      return "from quote" + q + ", as held today (not as sent)";
    case "quote_document":
      return "from uploaded quote" + q + page(rec);
    default:
      return null;
  }
};

// "on file, not printed on the quote PDF": our quote PDF prints none of the
// typed clauses yet (decision 12), so a clause Anvil holds may be one the
// customer never saw. Said beside every such clause.
export const printedNote = (rec) => (rec && rec.side === "quote" && rec.printed_on_pdf === false && rec.text
  ? "on file, not printed on the quote PDF"
  : null);

// A record with its labels, for a response.
export const labelled = (rec) => (rec ? { ...rec, label: provenanceLabel(rec), printed_note: printedNote(rec) } : null);

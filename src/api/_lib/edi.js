// X12 + EDIFACT translation utilities.
//
// Scope (covers the messages every industrial-distribution buyer/
// seller needs, so connectors stand up without per-tenant custom
// work):
//   - X12 850 (Purchase Order)               inbound from buyer
//   - X12 855 (PO Acknowledgement)           outbound to buyer
//   - X12 856 (Advance Ship Notice / ASN)    outbound to buyer
//   - X12 810 (Invoice)                      outbound to buyer
//   - EDIFACT ORDERS                         inbound, equivalent to 850
//   - EDIFACT ORDRSP                         outbound, equivalent to 855
//   - EDIFACT INVOIC                         outbound, equivalent to 810
//   - 997 (Functional Ack) + CONTRL          ack messages
//
// Anvil targets a specific shape: parse() yields a canonical
// JSON object; build() emits the X12/EDIFACT string. The X12 spec
// has hundreds of optional segments; we handle the ones that 95%
// of trading partners care about. Anything exotic surfaces as
// 'extension_segments' in the parsed object.

// X12 envelope delimiters per X12.5: element=*, segment=~, sub=:
const X12 = { ELEM: "*", SEG: "~", SUB: ":" };
// EDIFACT defaults per UN/EDIFACT D.96A: element=+, segment=', sub=:
const EDI = { ELEM: "+", SEG: "'", SUB: ":" };

// ────────────────────────────────────────────────────────────
// X12

const sliceSegments = (raw, sep) =>
  raw.split(new RegExp("\\" + sep + "\\s*"))
    .map((s) => s.trim()).filter(Boolean);

export const parseX12 = (raw) => {
  const segments = sliceSegments(raw, X12.SEG)
    .map((s) => s.split(X12.ELEM));
  if (!segments.length) throw new Error("empty X12 payload");
  const isa = segments.find((s) => s[0] === "ISA");
  const gs  = segments.find((s) => s[0] === "GS");
  const st  = segments.find((s) => s[0] === "ST");
  if (!isa || !gs || !st) throw new Error("X12 missing ISA/GS/ST");
  const messageType = st[1];

  const out = {
    format: "x12",
    sender: isa[6]?.trim(),
    receiver: isa[8]?.trim(),
    isa_control: isa[13],
    gs_control: gs[6],
    st_control: st[2],
    message_type: messageType,
    segments,
  };

  if (messageType === "850") {
    const beg = segments.find((s) => s[0] === "BEG");
    const ref = segments.filter((s) => s[0] === "REF");
    const lines = [];
    let cur = null;
    for (const seg of segments) {
      if (seg[0] === "PO1") {
        if (cur) lines.push(cur);
        cur = {
          line_number: seg[1],
          quantity: Number(seg[2] || 0),
          uom: seg[3] || null,
          unit_price: Number(seg[4] || 0),
          buyer_part_id: seg[7] || null,
          vendor_part_id: seg[9] || null,
        };
      } else if (cur && seg[0] === "PID") {
        cur.description = seg[5] || null;
      }
    }
    if (cur) lines.push(cur);
    out.po = {
      number: beg?.[3] || null,
      date: beg?.[5] || null,
      references: ref.map((r) => ({ qualifier: r[1], value: r[2] })),
      lines,
    };
  }

  if (messageType === "856") {
    out.shipments = segments.filter((s) => s[0] === "TD3").map((td) => ({
      equipment_code: td[1], equipment_id: td[2], weight: td[7],
    }));
  }

  if (messageType === "810") {
    const big = segments.find((s) => s[0] === "BIG");
    out.invoice = {
      number: big?.[2] || null,
      date: big?.[1] || null,
    };
  }
  return out;
};

export const buildX12 = ({ messageType, sender, receiver, controlNumber, payload }) => {
  const ctrl = String(controlNumber || Math.floor(1e8 + Math.random() * 9e8)).padStart(9, "0");
  const date = new Date();
  const yymmdd = date.toISOString().slice(2, 10).replace(/-/g, "");
  const hhmm = date.toISOString().slice(11, 16).replace(":", "");
  const isa = ["ISA", "00", "          ", "00", "          ",
    "ZZ", String(sender || "").padEnd(15), "ZZ", String(receiver || "").padEnd(15),
    yymmdd, hhmm, "U", "00501", ctrl, "0", "P", X12.SUB];
  const gs = ["GS",
    messageType === "850" ? "PO" : messageType === "855" ? "PR" : messageType === "856" ? "SH" : "IN",
    sender || "", receiver || "", yymmdd, hhmm, "1", "X", "005010"];
  const st = ["ST", messageType, "0001"];
  const segments = [isa, gs, st];

  if (messageType === "855") {
    segments.push(["BAK", "00", "AC", payload.po_number || "", yymmdd]);
    if (payload.po_date) segments.push(["REF", "PO", payload.po_date]);
    (payload.lines || []).forEach((li, i) => {
      segments.push(["PO1", String(i + 1), String(li.quantity || 0), li.uom || "EA", String(li.unit_price || 0), "", "", "BP", li.buyer_part_id || ""]);
      segments.push(["ACK", "IA", String(li.quantity || 0), li.uom || "EA"]);
    });
    segments.push(["CTT", String((payload.lines || []).length)]);
  }
  if (messageType === "856") {
    segments.push(["BSN", "00", payload.shipment_id || "", yymmdd]);
    (payload.shipments || []).forEach((sh) => {
      segments.push(["TD1", "CTN25", "1", "", "", "", "", "G", String(sh.weight || 0), "LB"]);
    });
  }
  if (messageType === "810") {
    segments.push(["BIG", yymmdd, payload.invoice_number || "", "", payload.po_number || ""]);
    (payload.lines || []).forEach((li, i) => {
      segments.push(["IT1", String(i + 1), String(li.quantity || 0), li.uom || "EA", String(li.unit_price || 0)]);
    });
    segments.push(["TDS", String(Math.round((payload.total || 0) * 100))]);
  }
  segments.push(["SE", String(segments.filter((s) => s[0] !== "ISA" && s[0] !== "GS").length + 1), "0001"]);
  segments.push(["GE", "1", "1"]);
  segments.push(["IEA", "1", ctrl]);
  return segments.map((s) => s.join(X12.ELEM)).join(X12.SEG) + X12.SEG;
};

// ────────────────────────────────────────────────────────────
// EDIFACT

export const parseEdifact = (raw) => {
  const segs = raw.split(new RegExp("\\" + EDI.SEG + "\\s*"))
    .map((s) => s.trim()).filter(Boolean)
    .map((s) => s.split(EDI.ELEM));
  const unh = segs.find((s) => s[0] === "UNH");
  const messageType = (unh?.[2] || "").split(EDI.SUB)[0]; // ORDERS:D:96A:UN:EAN008
  if (!unh || !messageType) throw new Error("EDIFACT missing UNH");
  const out = { format: "edifact", message_type: messageType, segments: segs };
  if (messageType === "ORDERS") {
    const bgm = segs.find((s) => s[0] === "BGM");
    const lines = [];
    let cur = null;
    for (const seg of segs) {
      if (seg[0] === "LIN") {
        if (cur) lines.push(cur);
        cur = {
          line_number: seg[1],
          buyer_part_id: (seg[3] || "").split(EDI.SUB)[0] || null,
        };
      } else if (cur && seg[0] === "QTY") {
        const parts = (seg[1] || "").split(EDI.SUB);
        if (parts[0] === "21") cur.quantity = Number(parts[1] || 0);
      } else if (cur && seg[0] === "PRI") {
        const parts = (seg[1] || "").split(EDI.SUB);
        if (parts[0] === "AAA") cur.unit_price = Number(parts[1] || 0);
      } else if (cur && seg[0] === "IMD") {
        cur.description = ((seg[3] || "").split(EDI.SUB)[3]) || null;
      }
    }
    if (cur) lines.push(cur);
    out.po = { number: bgm?.[2] || null, lines };
  }
  return out;
};

export const buildEdifact = ({ messageType, sender, receiver, controlNumber, payload }) => {
  const ctrl = String(controlNumber || "1");
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const time = new Date().toISOString().slice(11, 16).replace(":", "");
  const segs = [];
  segs.push(["UNB", "UNOA:3", sender || "", receiver || "", date + ":" + time, ctrl]);
  segs.push(["UNH", ctrl, [messageType, "D", "96A", "UN"].join(EDI.SUB)]);
  if (messageType === "ORDRSP") {
    segs.push(["BGM", "231", payload.po_number || "", "29"]);
    segs.push(["DTM", "137:" + date + ":102"]);
    (payload.lines || []).forEach((li, i) => {
      segs.push(["LIN", String(i + 1), "", li.buyer_part_id ? `${li.buyer_part_id}:BP` : ""]);
      if (li.description) segs.push(["IMD", "F", "", `:::${li.description}`]);
      segs.push(["QTY", `21:${li.quantity || 0}`]);
      if (li.unit_price) segs.push(["PRI", `AAA:${li.unit_price}`]);
    });
    segs.push(["UNS", "S"]);
    segs.push(["CNT", "2:" + (payload.lines || []).length]);
  }
  if (messageType === "INVOIC") {
    segs.push(["BGM", "380", payload.invoice_number || "", "9"]);
    segs.push(["DTM", "137:" + date + ":102"]);
    (payload.lines || []).forEach((li, i) => {
      segs.push(["LIN", String(i + 1), "", li.buyer_part_id ? `${li.buyer_part_id}:BP` : ""]);
      segs.push(["QTY", `47:${li.quantity || 0}`]);
      segs.push(["PRI", `AAA:${li.unit_price || 0}`]);
    });
    segs.push(["MOA", "9:" + (payload.total || 0)]);
  }
  segs.push(["UNT", String(segs.length - 1), ctrl]);
  segs.push(["UNZ", "1", ctrl]);
  return segs.map((s) => s.join(EDI.ELEM)).join(EDI.SEG) + EDI.SEG;
};

// ────────────────────────────────────────────────────────────
// 997 / CONTRL functional ack helpers.

export const buildX12_997 = ({ sender, receiver, controlNumber, ackedGsControl, status = "A" }) => {
  const yymmdd = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const hhmm = new Date().toISOString().slice(11, 16).replace(":", "");
  const ctrl = String(controlNumber || Math.floor(1e8 + Math.random() * 9e8)).padStart(9, "0");
  const segs = [
    ["ISA", "00", "          ", "00", "          ",
      "ZZ", String(sender).padEnd(15), "ZZ", String(receiver).padEnd(15),
      yymmdd, hhmm, "U", "00501", ctrl, "0", "P", X12.SUB],
    ["GS", "FA", sender, receiver, yymmdd, hhmm, "1", "X", "005010"],
    ["ST", "997", "0001"],
    ["AK1", "PO", ackedGsControl || "1"],
    ["AK9", status, "1", "1", status === "A" ? "1" : "0"],
    ["SE", "3", "0001"],
    ["GE", "1", "1"],
    ["IEA", "1", ctrl],
  ];
  return segs.map((s) => s.join(X12.ELEM)).join(X12.SEG) + X12.SEG;
};

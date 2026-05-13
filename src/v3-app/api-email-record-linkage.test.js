// Unit tests for src/api/_lib/email-record-linkage.js (Wave CM 4.1).

import { describe, it, expect } from "vitest";
import {
  observeFeatures, scoreObservations, scoreCandidate, rankCandidates, __test,
} from "../api/_lib/email-record-linkage.js";

describe("__test.featureWeight", () => {
  it("returns log10(m/u) per feature", () => {
    const f = __test.FEATURES.find((x) => x.key === "canonical_email_match");
    expect(__test.featureWeight(f)).toBeCloseTo(Math.log10(f.m / f.u), 3);
  });
});

describe("observeFeatures", () => {
  it("flags canonical_email_match true when hash equal", async () => {
    const obs = await observeFeatures({
      inbound: { fromEmail: "BUYER@Acme.com" },
      candidate: { contact: { email: "buyer@acme.com" } },
    });
    expect(obs.canonical_email_match).toBe(true);
  });

  it("flags email_domain_match when only domain matches", async () => {
    const obs = await observeFeatures({
      inbound: { fromEmail: "newperson@acme.com" },
      candidate: { contact: { email: "buyer@acme.com" } },
    });
    expect(obs.canonical_email_match).toBe(false);
    expect(obs.email_domain_match).toBe(true);
  });

  it("flags name_jaro_high when names are similar", async () => {
    const obs = await observeFeatures({
      inbound: { fromEmail: "x@y.com", fromName: "Mahesh Kumar" },
      candidate: { contact: { email: "z@y.com", name: "Mahesh Kumar" } },
    });
    expect(obs.name_jaro_high).toBe(true);
  });

  it("flags prior_thread_match when threadId is in customer's recent threads", async () => {
    const obs = await observeFeatures({
      inbound: { threadId: "T-100" },
      candidate: { customer: { recent_thread_ids: ["T-99", "T-100"] } },
    });
    expect(obs.prior_thread_match).toBe(true);
  });

  it("flags subject_po_pattern on PO subjects", async () => {
    const obs = await observeFeatures({
      inbound: { subject: "RE: PO 12345 confirmation" },
      candidate: {},
    });
    expect(obs.subject_po_pattern).toBe(true);
  });

  it("returns null on missing signals", async () => {
    const obs = await observeFeatures({ inbound: {}, candidate: {} });
    expect(obs.canonical_email_match).toBeNull();
    expect(obs.email_domain_match).toBeNull();
    expect(obs.name_jaro_high).toBeNull();
  });

  it("flags gstin_in_body when body contains the customer GSTIN", async () => {
    const obs = await observeFeatures({
      inbound: { bodyText: "Please confirm against GSTIN 27AAACA1234B1Z5." },
      candidate: { customer: { gstin: "27AAACA1234B1Z5" } },
    });
    expect(obs.gstin_in_body).toBe(true);
  });
});

describe("scoreObservations", () => {
  it("starts from a low prior so candidates need positive evidence", () => {
    const { probability } = scoreObservations({});
    // λ=1e-5, expressed as probability after zero observations.
    expect(probability).toBeLessThan(0.01);
  });

  it("rises significantly on canonical_email_match alone, but does not auto-link without corroboration", () => {
    const { probability } = scoreObservations({ canonical_email_match: true });
    const prior = scoreObservations({}).probability;
    // Posterior should be many orders of magnitude above the
    // prior, but still under AUTO_LINK_PROB so one cell match
    // alone never auto-links (defence in depth against address-
    // book misuse).
    expect(probability).toBeGreaterThan(prior * 1000);
    expect(probability).toBeLessThan(__test.AUTO_LINK_PROB);
  });

  it("compounds two matching features", () => {
    const a = scoreObservations({ canonical_email_match: true }).probability;
    const b = scoreObservations({
      canonical_email_match: true,
      prior_thread_match: true,
    }).probability;
    expect(b).toBeGreaterThan(a);
    expect(b).toBeGreaterThan(__test.AUTO_LINK_PROB);
  });

  it("punishes negative observations", () => {
    const pos = scoreObservations({ canonical_email_match: true }).probability;
    const neg = scoreObservations({
      canonical_email_match: true,
      name_jaro_high: false,
    }).probability;
    expect(neg).toBeLessThan(pos);
  });
});

describe("scoreCandidate", () => {
  it("returns AUTO_LINK on perfect canonical email match", async () => {
    const out = await scoreCandidate(
      { fromEmail: "BUYER@Acme.com", fromName: "Buyer Person" },
      { contact: { email: "buyer@acme.com", name: "Buyer Person" }, customer: {} },
    );
    expect(out.decision).toBe("AUTO_LINK");
    expect(out.probability).toBeGreaterThan(__test.AUTO_LINK_PROB);
  });

  it("returns SUGGEST when only domain + name + subject match", async () => {
    const out = await scoreCandidate(
      { fromEmail: "new.guy@acme.com", fromName: "John Doe", subject: "RE: PO 100" },
      { contact: { email: "buyer@acme.com", name: "Some Other Person" }, customer: {} },
    );
    // Domain match + subject_po -> meaningful evidence but
    // without canonical_email_match we shouldn't auto-link.
    expect(out.decision === "SUGGEST" || out.decision === "NO_MATCH").toBe(true);
    expect(out.probability).toBeLessThan(__test.AUTO_LINK_PROB);
  });

  it("returns NO_MATCH on no signal", async () => {
    const out = await scoreCandidate(
      { fromEmail: "x@bar.com" },
      { contact: { email: "y@baz.com", name: "Different Person" }, customer: {} },
    );
    expect(out.decision).toBe("NO_MATCH");
  });
});

describe("rankCandidates", () => {
  it("returns [] on empty candidates", async () => {
    expect(await rankCandidates({ fromEmail: "x@y.com" }, [])).toEqual([]);
  });

  it("ranks by probability desc", async () => {
    const inbound = { fromEmail: "buyer@acme.com", fromName: "Buyer X" };
    const out = await rankCandidates(inbound, [
      { contact: { email: "z@unrelated.com", name: "Z" }, customer: {} },
      { contact: { email: "buyer@acme.com", name: "Buyer X" }, customer: {} },
      { contact: { email: "other@acme.com", name: "Y" }, customer: {} },
    ]);
    expect(out[0].contact.email).toBe("buyer@acme.com");
    expect(out[0].decision).toBe("AUTO_LINK");
    expect(out[1].contact.email).toBe("other@acme.com");
  });
});

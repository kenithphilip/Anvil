// Every credential writer stores each secret as a self-contained v2 value
// (its own IV), writes no shared *_iv value, and refuses with 400 when
// ANVIL_SECRETS_KEY is unset instead of storing plaintext. Every reader
// reads such a value back with no bundle IV on the row.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { decryptField, encryptNetsuiteCreds, decryptNetsuiteCreds } from "../api/_lib/secrets.js";
import { acuEncryptCreds, acuDecryptCreds } from "../api/_lib/acumatica-client.js";
import { d365EncryptCreds, d365DecryptCreds } from "../api/_lib/d365-client.js";
import { docusignEncryptCreds, docusignDecryptCreds } from "../api/_lib/docusign-client.js";
import { eclipseEncryptCreds, eclipseDecryptCreds } from "../api/_lib/eclipse-client.js";
import { encryptChatCreds, decryptChatCreds } from "../api/_lib/inbound-chat.js";
import { graphEncryptSecret, graphEncryptTokens, graphDecryptSecret, graphDecryptTokens } from "../api/_lib/graph-client.js";
import { ifsEncryptCreds, ifsDecryptCreds } from "../api/_lib/ifs-client.js";
import { jdeEncryptCreds, jdeDecryptCreds } from "../api/_lib/jde-client.js";
import { jobbossEncryptCreds, jobbossDecryptCreds } from "../api/_lib/jobboss-client.js";
import { oracleEbsEncryptCreds, oracleEbsDecryptCreds } from "../api/_lib/oracle-ebs-client.js";
import { oracleFusionEncryptCreds, oracleFusionDecryptCreds } from "../api/_lib/oracle-fusion-client.js";
import { p21EncryptCreds, p21DecryptCreds } from "../api/_lib/p21-client.js";
import { plexEncryptCreds, plexDecryptCreds } from "../api/_lib/plex-client.js";
import { plmEncryptCreds, plmDecryptCreds } from "../api/_lib/plm-client.js";
import { proalphaEncryptCreds, proalphaDecryptCreds } from "../api/_lib/proalpha-client.js";
import { ramcoEncryptCreds, ramcoDecryptCreds } from "../api/_lib/ramco-client.js";
import { razorpayEncryptCreds, razorpayDecryptCreds } from "../api/_lib/razorpay-client.js";
import { sagex3EncryptCreds, sagex3DecryptCreds } from "../api/_lib/sage-x3-client.js";
import { sapEncryptCreds, sapDecryptCreds } from "../api/_lib/sap-client.js";
import { sxeEncryptCreds, sxeDecryptCreds } from "../api/_lib/sxe-client.js";
import { tallyEncryptedTokenColumns, tallyDecryptToken } from "../api/_lib/tally-client.js";
import { voiceEncryptCreds, voiceDecryptCreds } from "../api/_lib/voice-client.js";

const HEX_KEY = "c".repeat(64);
const saved = process.env.ANVIL_SECRETS_KEY;
beforeEach(() => { process.env.ANVIL_SECRETS_KEY = HEX_KEY; });
afterAll(() => {
  if (saved === undefined) delete process.env.ANVIL_SECRETS_KEY;
  else process.env.ANVIL_SECRETS_KEY = saved;
});

// v2 layout: "v2:" (3 bytes) || iv (12 bytes) || ciphertext || tag.
const ivOf = (enc) => Buffer.from(enc.slice(2), "hex").subarray(3, 15).toString("hex");

// [name, call, { encColumn: expected plaintext }]
const WRITERS = [
  ["netsuite", () => encryptNetsuiteCreds({ consumer_key: "ck", consumer_secret: "cs", token_id: "ti", token_secret: "ts" }),
    { netsuite_consumer_key_enc: "ck", netsuite_consumer_secret_enc: "cs", netsuite_token_id_enc: "ti", netsuite_token_secret_enc: "ts" }],
  ["acumatica", () => acuEncryptCreds({ username: "u", password: "p" }), { acumatica_username_enc: "u", acumatica_password_enc: "p" }],
  ["d365", () => d365EncryptCreds({ client_id: "id", client_secret: "sec" }), { d365_client_id_enc: "id", d365_client_secret_enc: "sec" }],
  ["docusign", () => docusignEncryptCreds({ rsa_private_key: "rsa" }), { docusign_rsa_private_key_enc: "rsa" }],
  ["eclipse", () => eclipseEncryptCreds({ username: "u", password: "p" }), { eclipse_username_enc: "u", eclipse_password_enc: "p" }],
  ["inbound chat", () => encryptChatCreds("slack", { bot_token: "xoxb", signing_secret: "sig" }), { creds_enc: JSON.stringify({ bot_token: "xoxb", signing_secret: "sig" }) }],
  ["graph secret", () => graphEncryptSecret({ client_secret: "gs" }), { graph_client_secret_enc: "gs" }],
  ["graph tokens", () => graphEncryptTokens({ access_token: "at", refresh_token: "rt" }), { graph_access_token_enc: "at", graph_refresh_token_enc: "rt" }],
  ["ifs", () => ifsEncryptCreds({ client_id: "id", client_secret: "sec" }), { ifs_client_id_enc: "id", ifs_client_secret_enc: "sec" }],
  ["jde", () => jdeEncryptCreds({ username: "u", password: "p" }), { jde_username_enc: "u", jde_password_enc: "p" }],
  ["jobboss", () => jobbossEncryptCreds({ token: "tok" }), { jobboss_token_enc: "tok" }],
  ["oracle ebs", () => oracleEbsEncryptCreds({ username: "u", password: "p" }), { oracle_ebs_username_enc: "u", oracle_ebs_password_enc: "p" }],
  ["oracle fusion", () => oracleFusionEncryptCreds({ client_id: "id", client_secret: "sec" }), { oracle_fusion_client_id_enc: "id", oracle_fusion_client_secret_enc: "sec" }],
  ["p21", () => p21EncryptCreds({ username: "u", password: "p" }), { p21_username_enc: "u", p21_password_enc: "p" }],
  ["plex", () => plexEncryptCreds({ api_key: "k" }), { plex_api_key_enc: "k" }],
  ["plm", () => plmEncryptCreds({ username: "u", password: "p", apiKey: "k" }), { username_enc: "u", password_enc: "p", api_key_enc: "k" }],
  ["proalpha", () => proalphaEncryptCreds({ username: "u", password: "p" }), { proalpha_username_enc: "u", proalpha_password_enc: "p" }],
  ["ramco", () => ramcoEncryptCreds({ client_id: "id", client_secret: "sec" }), { ramco_client_id_enc: "id", ramco_client_secret_enc: "sec" }],
  ["razorpay", () => razorpayEncryptCreds({ key_id: "kid", key_secret: "ksec" }), { razorpay_key_id_enc: "kid", razorpay_key_secret_enc: "ksec" }],
  ["sage x3", () => sagex3EncryptCreds({ client_id: "id", client_secret: "sec" }), { sagex3_client_id_enc: "id", sagex3_client_secret_enc: "sec" }],
  ["sap", () => sapEncryptCreds({ client_id: "id", client_secret: "sec" }), { sap_client_id_enc: "id", sap_client_secret_enc: "sec" }],
  ["sxe", () => sxeEncryptCreds({ client_id: "id", client_secret: "sec" }), { sxe_client_id_enc: "id", sxe_client_secret_enc: "sec" }],
  ["tally", () => tallyEncryptedTokenColumns("bridge-token"), { bridge_token_enc: "bridge-token" }],
  ["voice", () => voiceEncryptCreds({ apiKey: "k" }), { api_key_enc: "k" }],
];

// Writers whose callers never pass an empty credential always need the key.
// The ones below also accept "nothing to store", which must not need it.
const EMPTY_OK = [
  ["inbound chat", () => encryptChatCreds("slack", {})],
  ["plm", () => plmEncryptCreds({})],
  ["voice", () => voiceEncryptCreds({})],
  ["tally", () => tallyEncryptedTokenColumns(null)],
];

describe("credential writers / with ANVIL_SECRETS_KEY", () => {
  it.each(WRITERS)("%s: each secret is its own v2 value; no shared IV is written", (_name, call, expected) => {
    const out = call();
    for (const [col, plaintext] of Object.entries(expected)) {
      expect(typeof out[col]).toBe("string");
      expect(decryptField(out[col])).toBe(plaintext);
    }
    const ivs = Object.keys(expected).map((col) => ivOf(out[col]));
    expect(new Set(ivs).size).toBe(ivs.length);
    for (const [col, v] of Object.entries(out)) {
      if (/_iv$/.test(col)) expect(v).toBeNull();
    }
  });

  it.each(WRITERS)("%s: two saves of the same secret use different IVs", (_name, call, expected) => {
    const col = Object.keys(expected)[0];
    expect(ivOf(call()[col])).not.toBe(ivOf(call()[col]));
  });

  it.each(WRITERS)("%s: no plaintext copy is written", (_name, call, expected) => {
    const out = call();
    const secrets = new Set(Object.values(expected));
    for (const [col, v] of Object.entries(out)) {
      if (col in expected) continue;
      expect(secrets.has(v)).toBe(false);
      if (v && typeof v === "object") expect(Object.keys(v)).toHaveLength(0);
    }
  });
});

// Each writer's own reader, keyed by the encrypted column it reads back.
const viaStrip = (decrypt) => (row, cols) => {
  const out = decrypt(row);
  return Object.fromEntries(cols.map((c) => [c, out[c.replace(/_enc$/, "")]]));
};
const READERS = {
  "netsuite": viaStrip(decryptNetsuiteCreds),
  "acumatica": viaStrip(acuDecryptCreds),
  "d365": viaStrip(d365DecryptCreds),
  "docusign": viaStrip(docusignDecryptCreds),
  "eclipse": viaStrip(eclipseDecryptCreds),
  "inbound chat": (row) => ({ creds_enc: JSON.stringify(decryptChatCreds(row)) }),
  "graph secret": (row) => ({ graph_client_secret_enc: graphDecryptSecret(row) }),
  "graph tokens": (row) => {
    const t = graphDecryptTokens(row);
    return { graph_access_token_enc: t.access_token, graph_refresh_token_enc: t.refresh_token };
  },
  "ifs": viaStrip(ifsDecryptCreds),
  "jde": viaStrip(jdeDecryptCreds),
  "jobboss": viaStrip(jobbossDecryptCreds),
  "oracle ebs": viaStrip(oracleEbsDecryptCreds),
  "oracle fusion": viaStrip(oracleFusionDecryptCreds),
  "p21": viaStrip(p21DecryptCreds),
  "plex": viaStrip(plexDecryptCreds),
  "plm": viaStrip(plmDecryptCreds),
  "proalpha": viaStrip(proalphaDecryptCreds),
  "ramco": viaStrip(ramcoDecryptCreds),
  "razorpay": viaStrip(razorpayDecryptCreds),
  "sage x3": viaStrip(sagex3DecryptCreds),
  "sap": viaStrip(sapDecryptCreds),
  "sxe": viaStrip(sxeDecryptCreds),
  "tally": (row) => ({ bridge_token_enc: tallyDecryptToken(row) }),
  "voice": viaStrip(voiceDecryptCreds),
};

describe("credential readers / a row saved now", () => {
  // A tenant that connects after this change has no *_iv value at all.
  it.each(WRITERS)("%s: reads back with no bundle IV on the row", (name, call, expected) => {
    const row = { tenant_id: "t-1", ...call() };
    for (const col of Object.keys(row)) if (/_iv$/.test(col)) delete row[col];
    expect(READERS[name](row, Object.keys(expected))).toEqual(expected);
  });
});

describe("credential writers / without ANVIL_SECRETS_KEY", () => {
  it.each(WRITERS.filter(([n]) => !n.startsWith("graph")))("%s: refuses with 400 instead of storing plaintext", (_name, call) => {
    delete process.env.ANVIL_SECRETS_KEY;
    let out = null;
    let err = null;
    try { out = call(); } catch (e) { err = e; }
    expect(out).toBeNull();
    expect(err && err.status).toBe(400);
    expect(err.code).toBe("ANVIL_SECRETS_KEY_MISSING");
  });

  it.each(WRITERS.filter(([n]) => n.startsWith("graph")))("%s: throws (the Graph endpoints check the key first)", (_name, call) => {
    delete process.env.ANVIL_SECRETS_KEY;
    expect(() => call()).toThrow();
  });

  it.each(EMPTY_OK)("%s: storing nothing needs no key", (_name, call) => {
    delete process.env.ANVIL_SECRETS_KEY;
    const out = call();
    for (const v of Object.values(out)) {
      if (v && typeof v === "object") expect(Object.keys(v)).toHaveLength(0);
      else expect(v).toBeNull();
    }
  });
});

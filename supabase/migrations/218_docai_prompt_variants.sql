-- 218_docai_prompt_variants.sql
--
-- The handle for the prompt A/B lever.
--
-- prompt-versions.js has carried a registry, a deterministic split and a
-- rollback story since Wave 4.5. What it never had was a row carrying prompt
-- text, so both arms ran the identical prompt and the "70/30 split" was a
-- caption. PR 6 supplies the text (po_extractor@v2, the multi-row counting
-- discipline) and the wire from the registry to both adapters.
--
-- A prompt variant changes what the model is asked about a real customer's
-- real purchase order, so it must be switched on by a person, per tenant.
-- These are the two columns that let them.
--
--   docai_prompt_variants  the master switch. DEFAULT FALSE, deliberately the
--                          opposite polarity to the other docai gates
--                          (docai_x !== false, i.e. on unless disabled) —
--                          those guard proven behaviour; this one admits an
--                          experiment. run.js reads `=== true`, so a tenant
--                          without the column, or with it null, runs the base
--                          prompt. Turning the experiment off is an UPDATE,
--                          not a deploy, which is the question the registry
--                          exists to answer.
--
--   docai_prompt_pins      per-prompt version pin, e.g.
--                          {"po_extractor": "v1"}. run.js has read
--                          settings.docai_prompt_pins?.[name] since the
--                          version-recording work landed, but the column was
--                          never created, so the documented escape hatch —
--                          "a tenant can pin a version to opt out of the
--                          split" — has always resolved to null. It is the
--                          per-tenant rollback for exactly this canary: pin a
--                          tenant to v1 and they leave the experiment without
--                          anyone else's traffic changing.
--
-- Nothing breaks before this is applied. Reads are `select("*")`, so an absent
-- column is undefined rather than a 42703, and undefined means: variants off,
-- no pins. Applying it does not by itself enable anything — the default is
-- false and the pins are null.

alter table tenant_settings
  add column if not exists docai_prompt_variants boolean default false;

comment on column tenant_settings.docai_prompt_variants is
  'Master switch for docai prompt A/B variants (prompt-versions.js). Default false: a variant changes what the model is asked about a live customer document, so it is opted into per tenant. Read as `=== true`.';

alter table tenant_settings
  add column if not exists docai_prompt_pins jsonb;

comment on column tenant_settings.docai_prompt_pins is
  'Per-prompt version pin, e.g. {"po_extractor":"v1"}. Takes precedence over the A/B split, so it is the per-tenant rollback out of a canary. Null = follow the split.';

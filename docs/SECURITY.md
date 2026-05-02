# Security Notes

## Threat model

This is a B2B sales-ops tool for one company (Obara India). The threats it
defends against:

1. **Cross-tenant leakage** if multiple Obara entities ever share the deploy.
   Mitigated by RLS on every table and `tenant_id` checks on every
   service-role query.
2. **Prompt injection** through customer documents. Mitigated by the prompt
   firewall in `api/claude/messages.js`, the redaction patterns, and the
   injection test runner under Security Center.
3. **Approval bypass** by editing the SO after approval. Mitigated by the
   approval-bound payload hash (`stableStringify` + SHA-256) re-checked on
   every state transition.
4. **Tally double-export** from network retries. Mitigated by the
   `(tenant_id, voucher_no, payload_hash)` idempotency key in
   `tally_voucher_records`.
5. **Malware in uploads** (PO PDFs, ZIP imports). Mitigated by deterministic
   ZIP guards (size, count, nesting, executable, macro hint) and optional
   ClamAV via `CLAMAV_URL`.
6. **PII / secrets in logs**. Mitigated by `REDACTION_PATTERNS` for credit
   cards, Aadhaar, PAN, plus admin-managed redaction rules.

## Reporting issues

If you find a vulnerability, do not open a public issue. Email the security
contact (set this up before going live) and include reproduction steps.

## Authentication

- Production: Supabase magic link. Each user maps to one or more tenants
  via `tenant_members.role`.
- Development: a paste-token field accepts a Supabase access token.
- Service-to-service: bearer tokens for `EMAIL_INBOUND_TOKEN` and
  `CRON_SECRET`. Both must be unset to disable the corresponding endpoint;
  the inbound endpoint refuses calls when its token is unset (no implicit
  accept-all).

## Secrets management

- Never commit `.env.local`. The `.gitignore` blocks it.
- Rotate keys at least quarterly: Supabase service role, Anthropic, Mistral,
  cron secret, email inbound token.
- The Tally bridge token, if used, lives only in Vercel env vars and never
  in the browser.

## Audit trail

Every write goes through `_lib/audit.recordAudit`. The audit log is exposed
read-only via `/api/audit` and the Ops Assistant audit modal. Approvals,
amendments, Tally pushes, and admin actions all leave entries.

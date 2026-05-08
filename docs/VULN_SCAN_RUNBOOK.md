# Vulnerability Scan Runbook

> SOC 2 CC7.1 + CC7.2 evidence. The weekly checklist for
> identifying, triaging, and patching vulnerabilities in
> dependencies, container images, and the runtime.

## Cadence

- **Weekly**: Dependabot alerts + `npm audit` + Snyk scan.
  Triaged on Mondays. SEV review of any High or Critical
  finding the same day.
- **Per-PR**: GitHub Dependabot opens a PR for each new advisory
  affecting a direct or transitive dependency. CI runs the
  upgrade against the test suite.
- **Quarterly**: full SCA + container-image scan against the
  deployed Vercel image.

## Sources

The scans we run, in priority order:

1. **GitHub Dependabot**. Native; runs continuously against the
   `package-lock.json`. PRs auto-open for any High or Critical;
   Medium and below get an alert in the security tab.
2. **`npm audit`**. Command-line check. Run on every CI build
   (`npm run check` includes a non-blocking audit warn);
   blocking on High / Critical is the cron behavior.
3. **Snyk** (or Mend / GitHub Advanced Security; same role,
   pick one). Adds reachability analysis: a Critical CVE in a
   transitive dep we don't actually call is downgraded.
4. **OWASP ZAP** baseline scan against the deployed preview URL
   on every PR. Catches common web findings (XSS, missing
   security headers, etc.); not a SAST tool.
5. **Container image scan** against the Vercel build output.
   Catches OS-level CVEs in the runtime base image.

## Triage

Every finding gets one of four dispositions:

- **Patch now**: ship the upgrade as a PR within 7 calendar days
  (24h for Critical that affect a reachable code path).
- **Patch this sprint**: scheduled in the next two-week sprint;
  not blocking, not deferred indefinitely.
- **VEX-rejected**: the CVE applies to the dep but not to our
  use of it. Documented in `docs/SBOM_VEX.md` (one row per
  rejection, with the reachability argument).
- **Accept risk**: acknowledged, signed off by the security
  lead, time-boxed to the next quarterly review. Used sparingly.

A VEX rejection is a security artifact, not a bug fix excuse. We
require the reachability argument to be specific: "we import
package X but only call function Y; the CVE is in function Z" is
acceptable. "We don't think it affects us" is not.

## Workflow

### Monday (weekly review)

1. Open the GitHub security tab and the Dependabot tab. Filter
   to "Open" alerts on `main`.
2. For each new High / Critical:
   - Read the advisory.
   - Check whether the affected function is called from our
     code (Snyk reachability or grep).
   - Decide disposition (patch now / sprint / VEX / accept).
   - Open a tracking ticket if patching this sprint or later.
3. Run `npm audit --omit=dev | tee audit.weekly.txt`. Diff
   against the previous week's file in
   `docs/audits/<yyyy>/<mm>/`. New rows trigger triage.
4. Run a Snyk scan via the CLI (or hit the API). Reconcile with
   step 2; Snyk catches things Dependabot misses (and vice
   versa).

### Per-PR

- Dependabot PRs auto-merge after CI passes IF the advisory is
  Low or Medium. High and Critical require human review (we want
  someone to actually read the CVE before the upgrade lands).
- The on-call reviews any failed Dependabot PR within one
  business day.

### Quarterly

- Full SBOM regenerated from `package-lock.json`. Diffed
  against the previous quarter; new transitive deps get a
  one-line review.
- Container image scan via Trivy or Grype against the latest
  Vercel build. Findings filed against the runtime upgrade
  ticket.
- VEX rejections re-read. Anything older than two quarters is
  re-justified or upgraded.

## Tooling expectations

The on-call has, in their browser bookmarks:

- `https://github.com/<org>/<repo>/security` (Dependabot +
  CodeQL)
- `https://app.snyk.io/org/<org>/projects` (Snyk dashboard)
- The Vercel build logs (image scan results)

Local CLI:

- `npm audit --omit=dev` (no dev-dep noise; we patch dev separately)
- `gh api /repos/<org>/<repo>/dependabot/alerts` (programmatic
  read; useful when scripting weekly reports)

## Reporting

The auditor pulls three artifacts per quarter:

1. The week-by-week audit-output diffs in `docs/audits/`.
2. The list of patched advisories with PR numbers + merge dates.
3. The current VEX file (`docs/SBOM_VEX.md`).

The auditor reads these alongside the change log
(`/api/deploys`) so they can correlate "advisory found Monday,
patched Tuesday, deployed Wednesday."

## See also

- `docs/INCIDENT_RESPONSE.md`: what happens when a vuln is
  exploited rather than just identified.
- `docs/RUNBOOK.md`: day-to-day ops.
- `/api/deploys`: production change log.

## Changelog

| Date       | Reviewer  | Notes                                    |
|------------|-----------|------------------------------------------|
| 2026-05-08 | (initial) | First version. SOC 2 CC7.1 + CC7.2 evidence. |

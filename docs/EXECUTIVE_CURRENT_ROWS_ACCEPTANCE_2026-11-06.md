# Executive report: current schedule rows — 6 November 2026

Base5cdf8bf7d46383c7702d6b6b409bbc558e97e7e9. This is a bounded report-consumer correction for the existing controlled local pilot, not a new scheduling engine or commercial release acceptance.

The actual production UI on isolated3134 reopened the previously UI-entered QA Synthetic Progress20261104 project. Dashboard and Executive canonical forecast said2026-09-16, but the report critical table still displayed stored activity dates ending2026-09-10. Its lookahead also used stored percent/float/criticality. This was a contradictory user-facing result, not merely a test failure.

The report now projects current rows from the existing F5 analyzeScheduleControl output. Started/completed activities quote actual start/finish, otherwise current CPM dates, matching F5 currentStart/currentFinish semantics. Progress, completion, float and criticality quote the same governed as-of status. Labels explicitly say actual/CPM; null float is N/A rather than zero. Lookahead excludes governed completed activities and uses these current rows with the existing21-day window. The existing project finish resolver and all EVM/CPM/governance/calendars remain unchanged. No storage writes, dates or business assumptions were changed.

The first review of raw earlyStart exposed that a started activity's remaining-work start is not its whole-activity start. The final projection uses actualStart first, as F5's variances already do. It does not change or "repair" engine dates in the adapter.

Verification:
-44 targeted assertions: stale saved dates, unstarted, approved in-progress, completed, future/unapproved progress, empty input, exact F5 quotes and no input mutation. A separate current-base four-path guard and protected-engine diff equality pass.
- TypeScript and production build exit0. Existing bundle-size/Browserslist warnings retained; no installs or dependency edits.
- Executive view lint3errors/0warnings matches baseline message groups, no added group; new projection module lint0.
- Full historical1886-check harness:1873passed,13failed. All13 failures are old batch-wide changed-path guards S24/S26/S27/S28/S29/S30/S31/S32/S33/S34 comparing later accepted report/safety work to historical batch boundaries. These guards were not relaxed or edited. This is not reported as a fully green harness. The current increment's independent scope/protected-engine guard passed. Initial sandbox run also could not read installed xlsx; the bounded rerun with access completed and produced these exact totals.
- Real final UI: A-001 nowSep14–16; A-002 actualSep9/currentfinishSep13 with20%; A-003 actualSep10/currentfinishSep13 with10%; finish milestoneSep16. Lookahead shows F5 floats-5/-1/0 and current criticality. Header forecast remainsSep16; BAC7000/PV7000/EV900/AC450/CPI2/EAC3500/ETC3050/VAC3500 remain unchanged. No engine recomputation was replaced by handwritten formulas.
- Actual UI full workspace export after the report review:34tables and auxiliary state exactly match the prior cost-after-reopen export. Private executive-current-backup-proof.json records the actual downloaded path and SHA. The browser download-event waiter hung until timeout; the file was subsequently found and verified, and export was not retried. No PDF/print-dialog success is claimed.

Evidence is private under AUTONOMOUS_EXECUTION_2026-10-27: executive-rows-check.mjs, executive-current-controls-final.log, executive-current-lint-comparison.json, executive-current-backup-proof.json and executive-current-ui-proof.json. Owner storage on3130 was not used. Actual installed/GitHub SHA and rollback are recorded after safe promotion. Human/business acceptance and unrelated analytical screens remain open.

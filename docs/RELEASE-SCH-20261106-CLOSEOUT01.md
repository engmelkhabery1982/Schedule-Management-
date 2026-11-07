# SCH-20261106-CLOSEOUT01 — local candidate 2026.11.07-rc0

**Status: CODE DELIVERED (uncompiled); OWNER-HOST QA PENDING; RELEASE CANDIDATE READY: NO.**
This is a source candidate, not a built/distributable release or commercial acceptance.
The full assignment is not closed until the required release gates below pass.

## Authority / remote / rollback manifest

- Session branch: `arena/3db7d6ec-schedule-management` (only branch changed/pushed).
- Initial checkout: `1a12ad7b17dd7db9e394461b976d1bfd1c6b8a3a`, clean.
- Reviewed remote/base: `a494d39b3b3b5d5d3ccb73fb4892ed2d4a367da9`.
  `git ls-remote origin refs/heads/review/owner-pilot-20261104` verified this tip before work and again before publication. Session fast-forwarded to it; no main merge/rebase/reset/clean.
- Product code: `efa141590ff3b9ccbf244f836e885adb313b924b`.
- Validation/bookkeeping: `a2aaf27fb846c033d588bf65f223d27b0a81c547`.
- No initial dirty files/stashes/other local worktrees. No local competing writer observed;
  remote listing cannot establish that no other person is currently editing.
- Historical parent objects were fetched with bounded `--deepen=25` to make historical guards executable. No historical branch was changed.
- No owner F, running3130, live DB, environment configuration or owner files accessed/changed.
- Rollback target: reviewed base above. This increment writes no new field/table and changes no backup format, SQL or storage code. No migration/rollback SQL is required or authorized.
- If rejected, leave this branch unpromoted. If already copied into an isolated QA installation, owner can replace its application files with the reviewed-base build using the existing installation procedure. Back up that QA workspace first. Do not reset Git, replace owner storage, or run restore on3130 from these instructions.
- Only the owner review agent may advance `review/owner-pilot-20261104` and F after acceptance. No deploy/merge authorization is implied.

## Finite implementation list

1. Missing per-VO cross-domain evidence presentation: added `buildVoImpactEvidence` inside the existing scope engine and rendered it in the existing ScopeChangeRegister. No parallel pricing, forecast or delay engine.
2. Scope reads could finish into a later project editor, expose partial data after failures, or permit actions against incomplete reads: keyed project editor, read generations, all-result failures, project-response checks, project-filtered baseline reads, ready-gated data/actions and explicit Retry. Failed saves keep existing draft-modal data. A project switch remounts the editor (it is not a cross-project draft cache).
3. Approved label could say evidence-backed while required approval fields were absent: now gated on the actual actor/date/reference/evidence fields.
4. Historical changed-path guards incorrectly covered later accepted work: S24/S26/S27/S28/S29/S30/S31/S32/S33/S34 now inspect immutable delivered ranges, with unchanged assertions/allowlists. Current release has a separate exact six-path guard, wired into controls alongside focused regressions. No mathematical/data-integrity assertion was removed, skipped or relaxed.

### Historical anchors

| Guard | Delivered range |
|---|---|
| S24 | `de96ffd8f61b3c04980012b82855e9fba237f3fd^` → `de96ffd8f61b3c04980012b82855e9fba237f3fd` |
| S26 | `250400c51830be1067147e82f670a3f4a50a6fd7^` → same SHA |
| S27 | `c296cda5e7ed705ce0233fecc7c25bd83d5d424b^` → same SHA |
| S28 | `1a12ad7b17dd7db9e394461b976d1bfd1c6b8a3a^` → same SHA |
| S29 | `1a12ad7b17dd7db9e394461b976d1bfd1c6b8a3a` → `e7d9a13d0fb67cdd785885eefcf27f70a1b25637` |
| S30 | `140e7def681f2913e112987d5d5154e521e3ab57` → `6f7862cc6a780d86b25372085e72e8494dfcab26` |
| S31 | `3b873fbf8bf4e5db1aa5445b0596645de39cc336^` → same SHA |
| S32 | `7ff992031755e17c1078c975e322afad10b0d07f^` → same SHA |
| S33 | `97ac2b34315292f42d11716294557a5083e4d75c^` → same SHA |
| S34 | `7cf85ec69593086fda96f3533ce34ba49a367f04^` → same SHA |

Anchors are inspected by the full harness when available; they are not reported as executed here.
Current guard compares base→working tree plus untracked paths, so clean commits do not evade it.

## Authorities and 3B acceptance matrix

PASS(new) below means model-only evidence unless explicitly stated otherwise. It does not accept the UI.
Artifact: `node scripts/validate-scope-bridge.mjs` executes production scopeChangeEngine through Node22 built-in TypeScript stripping (no copied implementation); 27/27 assertions pass. Initial regression-first run failed with missing production function, then passed after implementation.

| Requirement | Status / artifact / limit |
|---|---|
| Pending ≠ approved; rejected/withdrawn excluded | PASS(new), six statuses and scope roll-ups in focused script |
| Original / approved / revised / pending | PASS(reused authority), existing calculateScopeSummary and immutable baseline; no financial formula added |
| Stored direct values, null ≠ zero, no current rate pricing | PASS(new), focused zero/null/absent and stored-value assertions |
| Quantity + BOQ/WBS/activity/source/approval trace | CODE DELIVERED; existing links and approval rows plus per-impact IDs/quantities, order ID/updated_at/status/revision rendered; bilingual UI NOT RUN |
| Cost evidence when available | PASS(new), same-project BOQ/activity/WBS-related transaction context; source/ID/date/status/approval level/amount displayed; not a proven VO attribution or commitment |
| No duplicate AC | PASS(new) read-only/no mutation and stored direct value independent of related transaction amount; protected F6 unchanged by exact path guard |
| Entered days ≠ measured delay; missing analysis→N/A | PASS(new), entered12 never becomes measured/approved12 |
| Explicit same-project analysis reference | PASS(new), exact existing delay_claims ID only; foreign ID and free text do not resolve |
| Stale analysis refused as current | PASS(new), ALL existing claim records lack source schedule revision/Data Date; historical claim quoted but current measured and approved days remain N/A |
| VO approval ≠ schedule approval | PASS(new), even approved VO with claim has no inferred current measurement or EOT |
| Overlap / aggregation | CODE DELIVERED, explicit potential overlap/aggregation unavailable; no days summed; UI NOT RUN |
| New persistent fields / prior backups | No new persistent field, format or storage change. Existing VO reference and claim rows remain unchanged. Actual changed-screen backup/reopen NOT RUN |
| Foreign/late read, failed write, retry | CODE DELIVERED; project remount/read generation/ready gate and retained error drafts; adversarial UI NOT RUN |

Existing `delay_claims` may quote historical critical_delay_days, analysis_method, created_at and status. Those records **do not prove which current schedule/Data Date produced them**. The bridge deliberately does not parse narrative assumptions, rerun TIA, infer entitlement, or create a freshness certificate. TIA's newly calculated results remain in-memory in its existing screen; this increment does not persist them or invent an analysis hand-off. Current authoritative freshness-qualified measured/approved schedule evidence therefore stays N/A with the current schema. If the owner requires current certified TIA evidence rather than honest N/A, that capability remains undelivered and requires a separately reviewed provenance hand-off—not a claim that these historical records suffice.

Cost records share existing links, not a dedicated VO transaction attribution. No commitment-specific or F6-attributed VO amount is claimed where no authoritative link exists. Costs are NOT added to approved direct scope or posted into BAC/AC/EAC/F6.

Protected F5/F6/F7/CPM/calendar/Recovery/TIA/Leveling and original baseline/history are unchanged. Executive current rows/recorded Drag and other accepted reads are inherited, not reimplemented.

## Batch4 release matrix

| Scope | Status | Precise artifact / remaining condition |
|---|---|---|
| Storage/new project/complete restore | PASS(reused evidence) | docs/PILOT-STORAGE-SAFETY.md, 4Nov actual JSON-paste restore/reopen section; unchanged storage |
| IPC, XER/BOQ, baseline/progress/cost entry | PASS(reused evidence) | docs/FIRST-USE-AND-BACKUP.md accepted local-pilot sections; scripts/validate-controls.ts S28–S34 inherited, not rerun here |
| Budget/Portfolio/Dashboard/Executive read isolation; Risks read/write | PASS(reused evidence) | corresponding dated acceptance documents in docs; unchanged paths |
| Executive current CPM / recorded Drag | PASS(reused evidence) | docs/EXECUTIVE_CURRENT_ROWS_ACCEPTANCE_2026-11-06.md; historical 1873/1886 and13 guard failures remain historical, not this run |
| New model regressions | PASS(new) | scripts/validate-scope-bridge.mjs:27/27;0 failed,0 skipped |
| Current release scope / protected engines | PASS(new) | scripts/validate-release-boundary.mjs; exact six allowed paths, all other paths protected |
| Full controls | NOT RUN | npm run validate:controls exits127: esbuild absent; no current full totals |
| Typecheck | NOT RUN | npm run typecheck exits127: tsc absent |
| Production build / distributable artifact | NOT RUN | npm run build exits127: vite absent; rc0 is source-only |
| Whitespace patch check | PASS(new) | git diff --check exit0 after final source changes |
| New bilingual UI/adversarial/reopen | NOT RUN | no installed browser/dependencies; bounded owner-host plan below |
| One complete representative chain through changed VO screen + snapshots + restore equality | NOT RUN | historical steps reused, but no single new integrated actual artifact produced; this is a mandatory open release gate |
| Actual schedule CSV/XER/XML export | NOT RUN (current candidate) | existing ExportView routes unchanged; verify actual downloaded artifacts below |
| Executive print / saved PDF | NOT RUN | ExecutiveReportView uses window.print(); no preview or saved PDF claimed |
| Live backend transaction/security/migration | NOT RUN | no live service access authorized; QA adapter not equivalent |
| Business acceptance / scope and EOT authority | OWNER DECISION | human review and sign-off, never synthetic QA approval |

Required final source checks were attempted after source changes; earlier attempts were repeated only because harness integration then changed. No install/ci/browser provisioning was performed. There is no current full-harness green result, no skipped case labeled green, and no current type/build result. Native Node reports its experimental stripping warning. No external runtime service was contacted.

## Actual backend / first use / backup / restore

The source selects browser LocalStorage when valid VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are absent; with valid configuration it selects Supabase. No runtime/browser configuration was opened in this sandbox, so the installed owner's actual backend mode is **not verified**. Candidate qualification is limited to the existing single-user local pilot, not cloud/multi-user/SaaS/RBAC security.

Use docs/FIRST-USE-AND-BACKUP.md for the bilingual operating guide. In brief:
1. Use a separate isolated QA origin/profile; do not open3130 or change F. Confirm the local-mode banner and selected project.
2. Reuse the accepted synthetic QA export if available privately on the owner host. Export a complete backup before any restore. CSV/XER/XML are NOT complete backups.
3. Open Scope/VO register. Enter stored quantity/value impacts; leave unquantified fields blank, not zero. VO approval requires actual existing approval evidence. Schedule days remain documentary.
4. To quote an existing claim, use its **exact ID** in the existing schedule reference field. Arbitrary reference text stays documentary; no substring matching. Historical claim freshness stays unverified.
5. Export complete workspace JSON from Export; validate the file or paste its text; inspect preview before explicit restore. Use one tab. Keep downloaded pre-restore recovery copy and original export outside Git. Reopen the project and compare records/auxiliary data, not just visible totals.
6. On load errors use Retry; no authoritative figures/actions are available until complete reads succeed. On save errors retain the draft and correct the error; do not assume persistence.

## Compact owner-host QA / acceptance checklist (finite, no new agent task)

External condition: run this exact branch in the **already provisioned owner QA toolchain**, isolated from owner3130. No new installation/environment is requested here.

- [ ] Run validate:controls, typecheck, build and diff --check at the published tip. Record exact totals/failures/skips and artifact hashes privately. Review any genuine non-guard failure before proceeding.
- [ ] Reopen accepted synthetic project (historical example BAC7000/EV900/AC450). Reuse its accepted imported schedule/BOQ, baseline, DataDate, approved progress and two-level cost approval; do not repeat unchanged micro-gates. Record which private export supplied it.
- [ ] Add one pending and one approved VO through actual UI. Verify stored0 vs blank, quantity without invented pricing, revised scope vs pending exposure, approval history and no AC/BAC change. Reject/withdraw a draft cohort through existing lifecycle and confirm exclusion.
- [ ] Use an exact same-project stored claim ID then foreign/missing/free-text IDs; historical record may display, but current/approved delay must remain N/A without revision/DataDate proof. Two VOs sharing activities must not display summed delay.
- [ ] AR/EN review: per-VO IDs/revision/links/source/evidence/status visible; no unsupported commitment attribution; approval does not imply delay acceptance.
- [ ] Switch projects during delayed reads; induce one read failure and one failed write. No previous/partial figures may be usable; Retry recovers; failed-save modal retains input. Do not use synthetic adapter results as proof of a live DB transaction.
- [ ] Compare F5/F6/F7/F8/Executive on that one project using canonical recorded outputs (record N/A honestly). Save existing schedule/cost snapshots. Download complete backup; restore into isolated workspace, reopen, download again and compare canonical tables/IDs/approval events/auxiliary stores, including VO reference and claim records. Keep actual exports/hashes privately. This integrated result is currently absent.
- [ ] Exercise unchanged actual CSV/XER/XML downloads and reopen/inspect the files. For Executive use the owner browser's existing print route once and save a real PDF; inspect saved pages and record path/hash. If browser dialog/download policy blocks it, record the exact policy condition to remove; do not repeat the same blocked automation or label preview PDF success.
- [ ] Owner signs the local-pilot acceptance scope or records exact remaining decisions. No commercial, backend-security or enterprise-cloud claim follows from tests alone.

Outstanding release gates are finite: installed-toolchain checks; actual changed-screen/error QA; one integrated snapshot/export/restore equality artifact; real export/PDF routes; human business acceptance. Source delivery alone does not close these gates.

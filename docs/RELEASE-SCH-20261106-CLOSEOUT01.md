# Consolidated release package — SCH CLOSEOUT01 + CLOSEOUT02

**Version:** 2026.11.07-rc1-source. **CODE DELIVERED / OWNER-HOST DELTA QA PENDING / RELEASE CANDIDATE READY: NO.**
This replaces the earlier rc0 matrix, not the accepted historical evidence. Independent work for CLOSEOUT02 is delivered; actual qualification of the new delta, snapshot UI chain, final XML save and PDF/human acceptance remain explicitly open. No finished-product, commercial, multi-user/cloud or live-backend-security claim.

## 1. Authority, continuation and metadata recovery

- Repository: `engmelkhabery1982/Schedule-Management-`; only session branch `arena/3db7d6ec-schedule-management` changed/pushed.
- Approved/review authority remains `a494d39b3b3b5d5d3ccb73fb4892ed2d4a367da9`. F and3130 are untouched. Only reviewer may promote authority/F after acceptance.
- CLOSEOUT02 continuation base / HOST-reviewed code: `6a814940194bdf440b54031db6a8e022f565d2d6`.
- Source/harness tip before this report-only commit: `805592d070debeb1a1b7edc7b64ea240a2554ef0`. Final report commit/full remote tip are returned in the closeout message; the report cannot contain its own hash.
- Remote was read before recovery and before publication. Expected review tip `a494d39…`, expected session remote tip `6a814940…`; no competing remote changes observed. No second local worktree, stash or Git lock was present. This does not claim global knowledge of another person's editor.
- On continuation the sandbox Git metadata unexpectedly pointed to `1a12ad7b17dd7db9e394461b976d1bfd1c6b8a3a`, while all148 target files already matched `6a814940…` byte-for-byte. Owner-authorized metadata-only recovery used:
  ```text
  git update-ref refs/heads/arena/3db7d6ec-schedule-management 6a814940194bdf440b54031db6a8e022f565d2d6 1a12ad7b17dd7db9e394461b976d1bfd1c6b8a3a
  git read-tree 6a814940194bdf440b54031db6a8e022f565d2d6
  ```
  No `-u`, reset/clean/stash or working-file rewrite. Expected-old CAS, ancestry, target tree/index and target148 files verified. Complete worktree inventory excluding.git (159 file/directory entries, including ignored/extra entries) identical before/after. Recovery evidence is local, external to Git at `/home/user/sch-metadata-recovery-1794027294357179808`: original HEAD/ref/index, binary staged/unstaged patches, tracked/untracked/ignored inventories and before/after file hashes. No upload.

### Scoped commits

| Full SHA | Change |
|---|---|
| `de600e29521e10665442659a9da1edb745af0c92` | Required response and baseline freshness validation; robust rejected-value errors |
| `c8dfa90b459184dbbeb9e72707bc90e40806d9e8` | Existing RPC approval audit included in complete backup; real snapshot/persistence integration |
| `d09f24c36119f60864ff2856204607a3d9da5933` | Missing XML dates omitted; XML download MIME fixed |
| `f1e70c05ba1d242eba6cb9997e795eee88af5c6c` | Real React component adversarial HOST harness and exact delta guard |
| `0c95a86b2417a2d3d0be1a40a5b8825a1c40d897` | Late transition and second-phase baseline cases |
| `805592d070debeb1a1b7edc7b64ea240a2554ef0` | Accurate existing TIA method identity on original synthetic historical claim |

CLOSEOUT01 product code remains `efa141590ff3b9ccbf244f836e885adb313b924b`; historical boundary repair `a2aaf27fb846c033d588bf65f223d27b0a81c547`. No protected engine, financial/schedule formula, dependency, SQL schema, approval/date assumption or deployment change.

## 2. HOST REVIEW already completed — attribution, not sandbox execution

The owner supplied the following exact-SHA evidence for **6a814940**, from isolated3136. This report reuses it; it is not a claim that this agent executed it or received/uploaded private host exports:

- Ancestry/six-path review, typecheck/build exit0; full controls **1888/1888**; model **27/27**; release boundary and diffcheck passed.
- Actual UI restored prior synthetic workspace. Created/submitted/synthetically approved VO200, quantity2, entered12days, missing claim: revised approved scope7200, AC450 unchanged, current measured/approved delay N/A.
- Draft VO stored0, blank quantity and blank days retained0/N/A through save/reload/reopen. AR/EN reviewed.
- Actual backup→restore→re-export matched **34 tables + auxiliary stores**. Projects/activities/costs unchanged. BAC7000/PV7000/EV900/AC450/CPI2/EAC3500/ETC3050/VAC3500; CPMfinish2026-09-16.
- CSV/XER actually saved/opened.
- **That backup contained NO snapshots.** It cannot prove the snapshot chain.
- XML was an unconfirmed2355byte `.crdownload`, NOT a proven final XML and NOT proof of a code defect.
- Native PDF dialog/permission limit remained; no saved PDF acceptance.

Earlier unchanged-path evidence remains in the dated Budget/Portfolio/Dashboard/Executive/Risks acceptance docs and `FIRST-USE-AND-BACKUP.md` / `PILOT-STORAGE-SAFETY.md`. No repeat of accepted unchanged micro-gates is needed. New source changes below require delta qualification, not blind reuse of the old1888 result.

## 3. Finite reproduced defects and repairs

| Reproduction | Small repair | Evidence / status |
|---|---|---|
| Actual pre-fix Scope response loop, executed as production source, accepts required `data:null` as an empty successful read; malformed baseline responses also lacked project/revision checks | `scopeReadSafety.ts`: required arrays, optional-pointer distinction, project and baseline-ID checks; screen uses it for every required read; null rejected promises no longer cause a second exception in error handling | PASS(new)18 assertions; real-component fault grid delivered, HOST execution NOT RUN |
| Two real local cost-review contract calls create two `approval_events`; buildBackup drops both despite preserving final approval_level2 | Add **existing RPC-written table** to inventory and validate same-project cost-event references. Extend inventory test to derive actual RPC `db['table']` accesses as well as query calls; retain all old assertions | Regression failed with `backup.tables.approval_events === undefined`, then integration PASS63/63 |
| activitiesToMsProjectXml with null dates generates invalid `<Start>T08:00:00</Start>` / `<Finish>T17:00:00</Finish>` | Omit absent optional date elements; do not invent dates | Regression failed before fix; content suite PASS12/12 |
| XML route calls downloadXer and constructs a tab-separated MIME blob | Choose application/xml for.xml filenames; XER MIME unchanged | Actual blob/content/click request captured; NOT a saved-file claim |

The new inventory has **35 tables**, not34: approval_events already existed in the RPC contract and local persisted bytes. This is a backup-inventory omission repair, not a new SQL table/migration or schema-version change. Envelope version1/schema2 remain. Supported prior34/32-table backups pass checksum/validation and gain an empty audit table (no fabricated history). Unknown existing VO evidence fields survive validation; old approval data is not silently dropped. Missing transaction references in cost audit rows are refused. No live service migration was performed.

CLOSEOUT01 project-keyed editor/read-generation/ready-gating and draft-preserving error behavior are retained. No new stale-response architecture was invented without a repro. The new host harness exercises those existing protections rather than claiming tests alone prove them.

## 4. Scope/time/cost authorities and 3B status

| Requirement | Current evidence / status |
|---|---|
| Original / approved / revised / pending | Existing immutable baseline + stored governed VO impact values; HOST actual VO200 produced7200, AC unchanged; PASS(reused HOST) |
| Pending≠approved; rejected/withdrawn excluded | Existing production model27/27; new persistence lifecycle through real contracts; real-component lifecycle harness NOT RUN |
| Null≠zero; no invented quantity prices | PASS(reused HOST) actual0/N/A; PASS(new) source-model cases. No current BOQ pricing or automatic BAC/AC/EAC posting |
| BOQ/WBS/activity/source/approval/revision trace | Existing bilingual register HOST reviewed; new original synthetic VO/claim links and lifecycle events survive full restore/reopen |
| Cost evidence/no double count | Related same-project transactions are context only, not proven VO attribution, commitments or additional AC; canonical F6 remains authority |
| Entered days≠measured/approved delay | PASS(reused HOST) entered12/missing claim stays N/A. Historical claim3 quoted only historically in delivered real-component scenarios |
| Same-project exact reference, foreign/missing/free text | Existing model checks pass; original real-component scenarios delivered against actual production component, HOST execution pending |
| Freshness/source revision/Data Date | Existing delay_claims have no source schedule revision/DataDate. No certificate is invented: current measured and approved delay remain N/A even for approved VO |
| Shared activities / overlapping VOs | Production model always says potential overlap/aggregation unavailable, no summation; new persistence cases cover overlapping links; actual component scenario awaits HOST |
| Failure/retry/old project completion | PASS(new)18 response guards; actual React harness below covers reads and writes, execution NOT RUN here |

No TIA calculation, persistence hand-off, source revision, schedule entitlement or new forecast is added. The existing claim ID is exact-match only. No parsing of arbitrary narrative, speculative attribution, blind delay addition or alternate engine.

## 5. Newly executed evidence and release matrix

**New sandbox suites: 93/93 assertions (18 +63 +12),0 failed,0 skipped.** Existing model27/27 also passed in the finite QA entrypoint. These are synthetic/component-support and content tests, not actual HOST UI/live database acceptance. Experimental Node TypeScript-stripping warning is retained.

| Gate | Classification | Artifact / result |
|---|---|---|
| Base code qualification / actual local VO/restore/CSV/XER | PASS(reused evidence) | Owner HOST REVIEW at6a814940, §2; not rerun unchanged |
| Required Scope response integrity | PASS(new) | `scripts/closeout02/response-tests.mjs`18/18 |
| Existing persistence / snapshots / canonical restore | PASS(new), adapter only | `scripts/closeout02/integration.mjs`63/63, details §6 |
| XML/CSV/XER content + download request | PASS(new) | `scripts/closeout02/export-tests.mjs`12/12; no saved XML/PDF claim |
| Changed-storage recovery suite | PASS(new affected check) | Existing `validate-restore-repair.mjs`14/14 synthetic recovery cases |
| S29 query+RPC inventory | PASS(new focused execution) | Exact production S29-I1/I2 block executed with Node stripping,2 assertions passed; no copied table allowlist |
| Delta / protected-path boundary | PASS(new) | `scripts/closeout02/delta-boundary.mjs`, exact19 permitted delta paths; cumulative release guard also passed |
| Patch whitespace / QA JavaScript syntax | PASS(new) | git diff --check; node --check on all11closeout02.mjs files |
| New real React adversarial component execution | NOT RUN here | Real production component harness delivered, §7; existing HOST tools required |
| Delta controls / typecheck / build | NOT RUN here | Commands attempted after final source changes; esbuild/tsc/vite absent, exit127 each. Old HOST1888/1888 is not a new-delta result |
| Snapshot chain via actual existing UI controls | NOT RUN | Runnable persistence proof plus exact isolated-host replay, §6; prior HOST backups had no snapshots |
| Final XML save/open | NOT RUN | Content defects fixed; prior.crdownload not accepted; exact final save steps §8 |
| Saved PDF / rendered pages | NOT RUN, irreducible native-save gate | No repeated blocked attempt, alternate generator or security bypass |
| Owner business acceptance / promotion | OWNER DECISION | Reviewer alone may accept local scope/promote F; synthetic approvers do not give contractual authorization |
| Cloud/RBAC/backend-security/live transaction | NOT RUN / not authorized scope | Local adapter never proves live database transactions or enterprise readiness |

No failing case was deleted or converted into a green skip. Historical batch boundaries remain anchored to their original delivered SHAs. The only global inventory correction additionally derives real RPC table usage; it does not remove the no-missing/no-unused/no-duplicate assertions. All F5/F6/F7/CPM/calendar/Recovery/TIA/Leveling paths are excluded from the exact delta allowlist.

## 6. Completed runnable snapshot/persistence chain and private synthetic artifacts

`integration.mjs` uses original minimal synthetic alpha project, not owner exports: schedule+BOQ/WBS/activity allocation → actual approve-scope-baseline contract with activity PMB → recorded approved physical progress → **two actual cost-review levels** → pending/approved VO plus shared activity/claim links → real reject/withdraw transitions → F5/F6/F7/F8/Executive quotes → snapshot builders and the **same MockQueryBuilder.upsert/table/conflict key** used by ScheduleView/BudgetView → complete backup → validator → real restoreWorkspace → readWorkspace reopen → re-export.

- DataDate2026-09-13; original1000 / approvedVO200 / revised1200 / pending200.
- BAC1000/PV1000/EV200/AC100/CPI2/EAC500/ETC400/VAC500; forecast2026-09-16. These are original synthetic test facts, NOT the HOST7000 project.
- One schedule and one cost snapshot saved; repeat same-Date upsert leaves exactly1+1. No snapshot invented by a fixture.
- F7 totals quote F6; F8 trust quotes F5 finish/F6 EAC; Executive projection matches F5; canonical EVM quotes F6. Full reports equal after reopen on the same snapshot history.
- All35table rows and auxiliary stores canonically equal after restore/re-export; snapshot IDs/details, VO/claim references, VO lifecycle and two cost approval audit events retained. Raw backup envelopes may differ in source metadata; this is canonical table/aux/checksum equality, not a false whole-file byte-equality claim.
- Unsupported/unknown schemas remain the existing validator's refusal behavior; old32/34 backups and unknown future VO evidence fields are specifically exercised without invented approval records.

Executed external-local artifact directory: `/home/user/sch-closeout02-synthetic-proof-final` (synthetic data only, not committed/uploaded):

| File | SHA256 |
|---|---|
| before-snapshots.json | `2d9bfeade5f3fbe19cb401e0d9f9cb1343720d1a4b51f6c4b73b18fe7f837767` |
| after-snapshots.json | `c0e7dac8b8872456237ea5455980ac2485a036c7b34ffcce67bf4ffb19bb3f29` |
| restored-reexport.json | `124d5e934abf797f20a91b27735dff47bda03d14b04ffb4e43ebe6daa1901216` |

`proof.json` records provenance, hashes and63 assertions. Re-running generates new legitimate IDs; per-run hashes change. Do not compare raw UUIDs against another run.

**Exact remaining actual-UI replay (only the snapshot delta):** on isolated HOST QA (not3130), generate a local artifact directory with command below; restore that run's `before-snapshots.json` via existing Export validator/explicit restore. Select Synthetic alpha, Schedule → existing “Save update snapshot” control (ScheduleView.handleSaveControlSnapshot), then Budget → existing “Save cost snapshot” (BudgetView.handleSaveCostSnapshot). Both use DataDate2026-09-13. Reopen the project; Export complete backup. Verify exactly one row in each snapshot table, matching DataDate/forecast and F6 figures above, nonempty version1 per-activity details. Restore that actual downloaded backup, reopen, re-export, compare all35 tables + auxiliary state canonically including audit events. Use the same file pair, not independently generated UUID fixtures. This actual UI result remains required and is NOT claimed by the adapter proof.

## 7. Runnable QA entrypoints — no installation, no separate agent task

From repository root in **existing Node22.22+ / already provisioned HOST tools**:

```sh
node scripts/closeout02/run.mjs
node --experimental-strip-types scripts/validate-restore-repair.mjs
node scripts/validate-release-boundary.mjs
```

To generate original synthetic artifacts outside Git:
```sh
SCH_QA_ARTIFACT_DIR=/absolute/external/qa-directory node --import ./scripts/closeout02/node-loader.mjs scripts/closeout02/integration.mjs
```
For PowerShell set `$env:SCH_QA_ARTIFACT_DIR` first, then use the same Node command without the Unix assignment. The script refuses a directory inside the repository. No owner data/config/auth is loaded.

**Real component HOST harness** (no fake hooks/copied component):
```sh
npm run dev -- --config scripts/closeout02/vite.config.mjs
```
Open `http://127.0.0.1:3137/scripts/closeout02/component.html` in the existing installed host browser. It runs React/createRoot + **production ScopeChangeRegister.tsx**, with an exact QA-only Vite alias for the Supabase adapter. The product vite.config is unchanged. Adapter uses only original synthetic memory storage, actual contracts/query builder/backup validator. It never reaches live DB/owner workspace.

Six automated groups: held Alpha initial and baseline-phase reads followed by Beta completion and Alpha success/error/rejection/finally;98 required-read fault cases plus pointer/stale cases with Retry; rejected save/transition retained drafts/status; held Alpha save AND transition success/rejection preserving Beta modal; exact historical/foreign/missing/free-text claim refs and overlapping VOs; real rejected/withdrawn UI lifecycle validated by production backup. Assertion count is computed at runtime; no predeclared green total. Page exposes `window.__closeout02` and visible PASS/FAIL output. Browser execution is currently NOT RUN.

Optional automated runner uses **only an existing executable**:
```sh
SCH_QA_BROWSER=/absolute/path/to/existing/browser node scripts/closeout02/run.mjs --browser
```
Vite must already be running. PowerShell: set `$env:SCH_QA_BROWSER` first. Runner requires the explicit existing path, uses a fresh temporary profile, never downloads a browser, never disables security/sandbox, never automates print/PDF, and writes computed results/errors outside Git. Any component failure or browser error exits nonzero; do not report an unexecuted harness as accepted.

Qualify only the changed source with `npm run validate:controls`, `npm run typecheck`, `npm run build`, `git diff --check` at final published tip in that provisioned toolchain. No install/ci/provisioning command is authorized. Historical passing gates are not a reason to re-enter the original pilot data.

## 8. Final XML/PDF gate, backend mode and operations

- Existing XML generator exports activity-oriented MSP XML, not a complete round-trip representation of all relationships/resources. Content tests verify namespace/escaping/noninvented dates/duration and actual Blob type/text/click invocation. They do not certify Microsoft Project compatibility or native save completion.
- On isolated HOST Export, click existing Microsoft Project XML route once. Allow the existing browser download to finish under normal policy; verify a final.xml filename (no.crdownload), nonzero bytes, parse/open it, record hash/path privately. If it remains policy-blocked, record the precise browser download-policy/permission condition rather than repeating the same automation or calling it a source failure.
- Executive print source is unchanged: `window.print()` after existing load/error gates; print-hidden toolbar and report container. No additional reproducible print-source defect was established without rendering. The native permission/dialog blocker is not solved by new generators, security bypass or another browser download. Authorized owner uses existing installed browser's print control → Save as PDF → explicit local filename, then opens the actual saved PDF and checks pages/totals/date/Arabic layout. If policy prevents that final save, the exact irreducible condition is permission for that installed browser's native print/save destination; keep this gate NOT RUN. Print preview is not a saved PDF.
- Backend selection is unchanged: valid VITE_SUPABASE_URL/key selects Supabase; otherwise local browser LocalStorage. No owner configuration was inspected. Qualification here is synthetic/local single-user, not live backend security or multi-user authorization.
- Operating guide remains `docs/FIRST-USE-AND-BACKUP.md`; its historical34-table description is superseded for this delta by the35-table audit repair here. Export a **complete workspace backup**, not CSV/XER/XML, before QA restore. Validate/paste → preview → explicit Restore, one tab, keep pre-restore recovery copy. On read failure use Retry; on failed write keep modal input; do not assume storage success.

## 9. Rollback, outgoing-path safety and remaining decisions

- No deployment/owner storage change has occurred. Safest rollback is **do not promote** this branch; approved base remainsa494d39. Existing installation remains untouched.
- If isolated QA needs rollback, preserve the new35-table complete export and raw recovery bytes first. An older34-table build will refuse a35-table backup as unknown approval_events; do NOT delete that table to force validation. Restore the pre-QA backup only in isolated QA using its matching supported build. Retain35-table audit evidence separately; an old exporter cannot preserve the audit table. No live migration/rollback SQL.
- Exact changed-path declarations: `scripts/closeout02/delta-boundary.mjs` enumerates each of19 allowed paths, not a directory-wide allowance. Cumulative release guard includes only original six paths + this explicit delta. No engine/dependency/SQL/main/PR/deploy paths are allowed.
- Outgoing content is source, QA code and this consolidated package only. Synthetic/recovery artifacts, browser profiles, owner exports/data/media/config, dependencies and build output stay out of Git. No private upload or spending.

**Only remaining external/human gates:** execute the delivered real-component harness and delta type/build/controls in the existing HOST toolchain; perform the specific snapshot-save/35-table actual UI restore replay; finish final XML/native PDF saved-file verification under normal browser policy; reviewer/human local-pilot acceptance and authorized promotion. No new product roadmap or fresh agent order is proposed. Independent implementation/tests are delivered; final qualification and business acceptance remain open.

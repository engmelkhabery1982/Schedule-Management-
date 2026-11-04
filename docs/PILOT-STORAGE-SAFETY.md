# SCH-20261027-SAFETY — local workspace storage safety (pilot increment)

## Owner review repair — 4 November: actual-date restore cut-off

Independent reproduction on b673a58 accepted checksum-valid backups whose activity actual_start or
actual_finish was 2026-09-14 against the project's 2026-09-13 Data Date. Progress/cost-row validation
did not cover these activity fields. Restores now reject future actuals, impossible actual dates and
reversed actual start/finish, while preserving null actuals, execution on the cut-off and future
planned dates. Regression coverage also forges a previously validated state and proves restore's
second validation refuses it without workspace or recovery-key writes. The real browser paste path
rejects the future completion and exposes no Restore button. This closes this restore-integrity gate
only; it does not accept the complete historical work line or update the owner installation.

**Task:** safe local single-user first pilot. **Not** new scheduling features, **not** a sale-ready
claim, **not** commercial acceptance.
**Base commit:** `1a12ad7b17dd7db9e394461b976d1bfd1c6b8a3a` (`main` == `arena/01a0d254-schedule-management` at start).
**Branch:** `arena/d9730ed9-schedule-management`.

---

## 1. The three reproduced defects (pre-fix behaviour)

Reproduced by extracting the storage functions from the previous commit
(`git show 1a12ad7:src/lib/supabase.ts` → `LOCAL_STORAGE_KEY` … `resetDemoDatabase`) and running them
in Node against synthetic LocalStorage. Verbatim output:

```
DEFECT 1 — swallowed write error:
   saveDb threw?    false (defect: false)
   bytes on disk?   null — the write was LOST
DEFECT 2 — valid empty state re-seeded on read:
   seed() calls     1 (defect: 1)
   projects loaded  ["proj-seed-001"]
   bytes rewritten  true (defect: true)
DEFECT 3 — corrupt JSON replaced without preservation:
   seed() calls     1 (defect: 1)
   original bytes?  DESTROYED (overwritten with seed)
   served projects  ["proj-seed-001"]
   preservation keys 0 (defect: 0)
```

| Defect | Root cause in `src/lib/supabase.ts` | Repair |
| --- | --- | --- |
| 1. Writes reported success | `saveDb()` caught `setItem` failures and `console.warn`ed; every caller returned `{ error: null }` | `commitWorkspace()` mutates a **clone**, persists, **reads the bytes back and compares**, rolls back on any failure, and returns a typed error. Query writes (`insert/upsert/update/delete`) and every RPC contract write go through it |
| 2. Empty valid state re-seeded | `loadDb()` re-seeded unless `projects.length > 0 && activities.length > 0` | Reads never write. An absent key loads as a **valid empty** workspace; seeding happens only in `seedDemoWorkspace()` (explicit demo action) |
| 3. Corrupt JSON destroyed | `catch { console.warn }` then seed-write over the payload | Parse/shape/version/migration failures return a typed `fault`; the exact bytes are copied to `…__preserved__…` (identical payloads collapse to one copy) and the primary key is **left untouched** |

The same three behaviours are pinned as executable checks (S29-A1…A3) against a faithful in-harness
replica of the pre-fix algorithm, and immediately followed by checks that the repaired loader does not
exhibit them (S29-B4…B13).

---

## 2. What changed

| File | Change |
| --- | --- |
| `src/lib/localWorkspace.ts` **(new)** | Single owner of the local workspace: key + schema constants, **complete persisted-table inventory** (`PERSISTED_TABLES`, 32 tables) plus the whitelisted project-scoped auxiliary stores (cut-off revisions, legacy subcontract register and its import flag), lossless versioned migration (1 → 2, in-memory, read-only), typed faults, byte preservation, atomic `commitWorkspace`, explicit demo/empty lifecycle, selected-project preference (excluded from backups), versioned backup builder with checksum over tables **and** auxiliary stores, full backup validator, and a rollback-safe restore that writes a pre-restore copy |
| `src/lib/localQueryBuilder.ts` **(new)** | The demo-store query builder, extracted from `supabase.ts` so the harness drives the real code; **every write** is one `commit` (atomic), preserving all previous semantics (relations, `!inner` fail-closed `eq`, project-boundary trigger mirror) |
| `src/lib/supabase.ts` | Thin adapter: env detection, `isDemoMode`, health/copies API, storage port, RPC contracts through `commitWorkspace`, explicit demo/empty actions. No `saveDb`, no seed-on-read, no swallowed errors |
| `src/components/views/PortfolioView.tsx` | Genuine new-project creation: empty form, required-field / numeric / date-order validation, error surfacing, **no invented WBS/BOQ/activities/links/budget/cost/progress**, derived duration, governed Data Date, new project becomes (and stays) the selected project. Demo creation is a separate, labelled action |
| `src/App.tsx` | No demo fallback project; remembered-project selection restored on boot; loud failure when a Data Date save fails; workspace banner for faulted / unavailable / empty workspaces with explicit actions |
| `src/components/Sidebar.tsx` | Project list empties with the workspace; demo button relabelled and confirmed (it preserves the previous bytes) |
| `src/components/views/WorkspaceBackupPanel.tsx` **(new)** | Backup/restore UI on the existing Export surface: export complete backup, validate-then-preview restore, explicit restore with automatic pre-restore download, preserved-copy list, start-empty |
| `src/components/views/ExportView.tsx` | Mounts the panel (also when no project is selected — exactly when it is needed) |
| `scripts/validate-controls.ts` | New **S29** section (192 checks) + legacy batch path guards extended by the established "subtract the later batch's paths" convention + S17-E/S25/S27 source checks retargeted to the files that now own that code |
| `docs/FIRST-USE-AND-BACKUP.md` **(new)** | Short bilingual first-use / backup / restore / troubleshooting guide |

### Preserved domain rules

* Governed Data Date `2026-09-13` and "no progress/cost after the Data Date" — enforced on **backup
  validation** (restore refuses a file that violates it) and asserted after a round trip (S29-F11).
* Approvals (`progress_updates.status/approved_at`, `cost_transactions.status/approval_level`) are
  data, not presentation: preserved verbatim by backup/restore (S29-F9) and by the RPC contract path
  (S29-C9…C13).
* Hospital BAC/`contract_value` = 125,000,000 SAR survives a restore (S29-F12), and the restored
  Hospital BAC equals the independently summed baseline `planned_cost` (S29-F17).
* `zero` vs `null` is preserved (S29-D7).

---

## 3. Gate results

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript | `npm run typecheck` | **PASS** (no output) |
| Production build | `npm run build` | **PASS** (`dist/assets/index-*.js` 2,113 kB / 590 kB gzip; existing chunk-size warning only) |
| Validation harness | `npm run validate:controls` | **PASS 1749/1749** — the 1557 pre-existing controls all still pass, plus **192 new S29 checks** |
| Lint (pre-existing debt, informational) | `npm run lint` | baseline `227 problems (205 errors, 22 warnings)` → now `199 problems (177 errors, 22 warnings)`. **No new warnings; 28 fewer errors.** The new modules are lint-clean (only the pre-existing `export const supabase: any` remains in `supabase.ts`) |
| Real browser flow (AR/EN) | — | **BLOCKED (owner-host gate)** — see §4 |

### Acceptance mapping

| Acceptance item | Where it is checked |
| --- | --- |
| Reproduce all three defects first | §1 evidence + S29-A1…A3 |
| Denied writes | S29-C1…C4 |
| Quota writes | S29-C5…C7, S29-C9…C11, S29-J4 |
| Silently dropped writes | S29-C8 (read-back verification) |
| Valid empty state not reseeded | S29-B4…B8, S29-F19…F21, S29-J1…J2 |
| Malformed JSON, bytes preserved | S29-B9…B13 |
| Supported migration | S29-B18…B22 |
| Failed migration (bytes identical) | S29-B23…B25 |
| Unsupported/newer schema | S29-B16…B17 |
| Two real empty projects | S29-D1…D3 |
| Three activities + two links on one project | S29-D4…D6, S29-D13 |
| Save / reload / reopen: IDs, links, dates, selection, zero vs null | S29-D4…D14 |
| Complete backup into a fresh workspace, canonical table comparison | S29-E1…E11, S29-F1…F8 |
| Independently checked CPM | S29-F14…F15 |
| Independently checked EVM (+ hand-summed BAC) | S29-F16…F18 |
| Approvals + Data Date preserved | S29-F9…F11, S29-F12 |
| Invalid backup leaves state byte-identical | S29-G (16 classes × 3 assertions) + S29-G final |
| Auxiliary project-scoped stores (cut-off revisions, legacy subcontract register) are backed up, restored byte-faithfully, and cannot be used to inject non-workspace keys | S29-L1…L14 |
| No unrelated browser keys / credentials in a backup | S29-E6…E7, S29-E11, S29-F13 |
| Recoverable pre-restore backup | S29-F22…F23 |
| Full table inventory | S29-I1…I4 (re-derived from every `supabase.from('<table>')` in `src/`) |
| Shipped adapter honours the contracts | S29-H1…H11 |
| Increment scope | S29-K1…K2 |

---

## 4. Blockers and limits

1. **Real isolated browser flow — BLOCKED (owner-host gate).** No browser binary is installed in this
   environment (`chrome`/`chromium`/`firefox` absent; `~/.cache/puppeteer` is empty) and a new runtime
   download is explicitly out of scope, so the Arabic/English click-through (create project → add
   activities → reload → export → restore) **was not run**. This is a gate, not a completed pilot. The
   synthetic-storage harness is not a substitute and is not reported as one.
2. **Lint debt** is pre-existing (205 errors at the base commit); this increment reduces it and adds
   none.
3. **`localStorage` is the only persistence** in this mode: one browser, one user, no sync, no
   automatic re-rotation of backups. Backups are the user's responsibility.
4. S29's `changed-file` guard asserts the increment stays inside the paths it declares; when a later
   task extends these files it must extend that list (same convention as the earlier batch guards).

---

## 5. SCH-20261028-RESTORE-REPAIR — assistant review delivery

Session branch: `arena/473194ba-schedule-management`. Delivered starting point verified locally
and against the remote `arena/d9730ed9-schedule-management`:
`4e03e8e303028edbbfa5ccb57037ad123465b802`. No later commits existed at session start.
No factory code, owner data, dependencies, downloads, deployment, main merge or history rewrite.

### Reproduction before repair

`node --experimental-strip-types scripts/validate-restore-repair.mjs` was first run with the
unmodified delivered storage module. All nine initial cases failed: second auxiliary throw,
second auxiliary dropped write, stale deletion throw, auxiliary read failure, main read failure,
enumeration failure, silent omission from auxiliary backup, rollback failure evidence, and
successful replacement of stale auxiliary keys. The first two showed the first auxiliary value
remaining `[{"new":1}]` instead of `[{"old":1}]` after failure.

Separately, `git archive 4e03e8e` into ignored `.cache/delivered`, with an independent index loaded
by `git read-tree 4e03e8e` and explicit `GIT_WORK_TREE`/`GIT_DIR`, exercised the actual original
harness against the clean delivered tree (no branch switch, no fake dirty files). Result:
`FAIL S29-K2 ...`, `VALIDATION FAILED: 1 of 1749 checks failed.`

### Repair and review boundaries

* Complete snapshots now reject unavailable enumeration, null/duplicate enumeration entries,
  changed enumeration length, auxiliary disappearance, and thrown owned reads. Only owned payloads
  are read; unrelated key names are enumerated to select the whitelist, never their values.
  Export surfaces failure rather than claiming a complete backup.
* Before any business mutation, a read-back-verified recovery archive carries exact main bytes
  (including absence) and **all** auxiliary bytes. The historical main-only copy remains for
  compatibility. The archive uses a distinct `__auxiliary` key under the pre-restore prefix; the
  failure message identifies it, the recovery list can download it, and failed restore UI also
  downloads available recovery evidence. Recovery archives are not validated restore envelopes.
* Restore replaces the entire owned auxiliary set. Every write/delete is read-back-checked;
  final values and auxiliary membership are checked. A journal records attempted keys before the
  operation (including writes that might mutate then throw). Failure reverses all attempted
  main/aux operations, removes new keys, verifies each rollback and explicitly reports any failed
  rollback with the archive key and in-memory exact bytes. Recovery copies are deliberately retained.
* Browser storage is not a database transaction: permanent policy/quota failures can prevent
  rollback. Recovery evidence and explicit failure are the contract, not an impossible guarantee
  against permanent storage denial, browser termination or concurrent tabs. Run restore in one tab.
* S29 paths compare explicit safety base `1a12ad7b17dd7db9e394461b976d1bfd1c6b8a3a`
  against HEAD **plus** unstaged, staged and untracked paths. K1/K2 remain enforced on clean commits.
* Exact protected-file exception: ProgressView adds only the `writeAuxiliaryStores` import and
  replaces the monthly revision `setItem` with its checked result, throwing into the existing
  error path on a thrown or dropped write. Success text/wizard advance occur only afterward.
  S28's other protected files remain unchanged. S29-M compares the entire ProgressView to delivered
  SHA after reversing exactly these two substitutions, and separately requires the checked path.
  No planning, governance, chronology, approval, CPM, EVM or seed logic is changed.

### Verification and remaining gates

The standalone suite passes **14/14** synthetic cases (the initial nine plus new-key removal,
dropped stale deletion, dropped protection archive, absent enumeration and dropped monthly write).
It is also executed by the full controls harness. Full harness with Node's built-in TypeScript
transformation and a temporary ignored alias resolver: **1752/1752 PASS** before commit.
This fallback executes the real controls, not a substitute implementation; the resolver only maps
`@/` and extensionless TypeScript imports. Temporary resolver/output are not committed.

Normal requested commands were attempted: `npm run typecheck`, `npm run build`,
`npm run validate:controls` fail to start because `tsc`, `vite`, and `esbuild` are absent respectively.
No installation/download was performed under the task prohibition. Typecheck and production build
therefore remain **BLOCKED**, not passed. Run all three normal commands in the assistant's existing
provisioned environment before integration. The checked-in standalone test needs Node 22.6+ with
`--experimental-strip-types`; the fallback full-harness execution used Node 22.22.3.

Real isolated Arabic/English browser create/edit/reload/export/restore, denied/quota storage,
monthly cut-off error display and recovery archive download remain **NOT RUN**. Synthetic storage
is not a replacement for that real-browser gate. No owner acceptance is claimed.

Changed files: `src/lib/localWorkspace.ts`, `src/components/views/ProgressView.tsx`,
`src/components/views/WorkspaceBackupPanel.tsx`, `scripts/validate-controls.ts`,
`scripts/validate-restore-repair.mjs`, and this document.

# Independent owner review — restore repair (3 November 2026)

Incoming SHA: e7d9a13d0fb67cdd785885eefcf27f70a1b25637; verified remote and ancestor4e03e8e. Six incoming files, no dependency or owner-data changes.

Independent local gates: TypeScript exit0; production Vite build exit0 (existing chunk-size warning); actual restore regressions14/14; controls1752/1752 after the Windows guard correction below. Bundles/logs were kept outside the repository in the strategy QA folder because node_modules links to the installed owner dependencies. The first default controls command's cache write was refused; the equivalent build used a QA output file without modifying owner dependencies.

The original independent partial-rollback reproduction now leaves the first auxiliary bytes unchanged and returns an explicit rollback-failure report plus recovery archive when the synthetic store permanently denies another key. Main bytes also match. This verifies the original defect's closure without claiming storage transactions survive permanent denial or concurrent tabs.

Windows-only guard defect: the exact ProgressView substitution compared CRLF checkout bytes to LF from git show. The initial repaired-tree controls failed1/1752. Normalize CRLF to LF on BOTH inputs, retaining exact source substitutions and every assertion. Controls now1752/1752. Product behavior is unchanged by this local guard edit.

Still open: actual isolated AR/EN browser project creation/reopen, backup/restore and error/recovery-download UI. No owner acceptance, owner F update, main merge or deploy.


## Owner browser date-entry review — 3 November2026
React date inputs now handle the input event as well as committed change events. Before this narrow fix, native date values displayed correctly but form state stayed empty and rejected creation. On the isolated browser origin, the same ISO date entry now persists through project creation and reload. Existing date validation and native picker remain unchanged. Typecheck/build pass and1752controls pass. This closes project-creation browser evidence only; full restore browser acceptance and owner installation remain pending.


## Validated JSON paste and real restore round trip —4November2026
The existing Export recovery surface now also accepts pasted JSON locally through the same validateBackup/preview/explicit restoreWorkspace path. Editing text invalidates the prior preview; switching inputs invalidates pending file reads. No new provider, permission, dependency or storage format. File import remains available.
Independent browser evidence: exported the existing isolated QA project; malformed JSON refused with no Restore button; editing validated text removed Restore; restored the prior valid empty backup, then restored the exported one-project backup and reopened the portfolio. Project QA Controls Pilot 20261103, client Local QA Owner, contract1M SAR persisted. Pre-restore archives were downloaded for both operations and preserved copies appeared. Synthetic QA project only, no owner data; aux rollback evidence remains the earlier14cases. Typecheck/build and1752controls pass. This closes the paste-based restore browser gate, not all application commercial-quality gates. Existing native confirm and file chooser routes remain separately unproven in this automation backend.

## Owner dashboard evidence repair —4November2026
The new real project could show four fabricated live alerts (float erosion, cash deficit, guarantee expiry, claim deadline) and100%Excellenthealth with no activities or measured CPI/SPI. Replace those illustrative cards with persisted project_alerts and an explicit no-recorded-alerts/insufficient-data message. Health stays N/A until activities and valid canonical CPI/SPI exist; correction prompts also report unmeasured values rather than invent1.00 or assume a deficit. Existing EVM/CPM/health scoring math is unchanged. S29 scope inventory narrowly includes Dashboard.tsx for this recorded first-use honesty defect; all controls retained.
Real isolated browser checks passed EN/AR missing-data cases (no312,000/3.5/Excellent claims), and a validated imported one-project/one-synthetic-alert backup displayed exactly its stored title/message/severity/status. Synthetic alert is QA only, not a real project issue. Typecheck/build pass, controls1752/1752. Targeted lint has pre-existing findings; before/after report retained outside repo. Owner installation/full commercial acceptance remains open.

---

## Payment certificate first-use and persistence repair — 4 November 2026 (TASK SCH-20261104-IPC01)

**Task:** Close the payment certificate first-use and persistence gap in `PaymentCertificatesView.tsx`.
**Base commit:** `140e7def681f2913e112987d5d5154e521e3ab57` on branch `arena/182ee6f6-schedule-management`.

### 1. Defect reproduction

1. **Cross-project fabricated default:** `PaymentCertificatesView.tsx` initialized `certificates` and `subcontractorIpcs` from hardcoded financial examples (`IPC-01...04`, `SUB-IPC-01...03`) regardless of the selected project. Genuine new/empty projects displayed 505,940 SAR certified gross and 144,350 SAR subcontractor profit without any actual commercial contract or certification records.
2. **Reload data loss:** Modifications and newly created certificates existed only in component-local React state. Because no persistence adapter was wired, reload or project switching discarded user entries immediately.

Both defects are reproduced in `scripts/validate-controls.ts` under S30-A1...A3.

### 2. Architecture and repairs

| File | Change |
| --- | --- |
| `src/types/index.ts` | Added `project_id?: string;` to `PaymentCertificate` and exported `SubcontractorIpc` and `SubcontractorIpcItem` interfaces. |
| `src/lib/localWorkspace.ts` | Added `payment_certificates` and `subcontractor_payment_certificates` to `PERSISTED_TABLES` (now 34 tables). Registered demo certificates for `proj-seed-001` in `DEMO_PAYMENT_CERTIFICATES` and `DEMO_SUBCONTRACTOR_CERTIFICATES` embedded strictly for explicit `seedDemoWorkspace(..., 'demo')` actions without touching `src/lib/mockSeed.ts`. Enhanced `validateBackup` to verify certificate project integrity, line BOQ item project alignment, subcontract package reference integrity, finite numeric fields, and Data Date chronology. |
| `src/lib/localQueryBuilder.ts` | Added `validateCertificateRecord` enforcing project scope, Data Date chronology (actual/certified/paid cannot be dated after Data Date), BOQ project consistency, and package reference integrity on insert, upsert, and update mutations. |
| `src/components/views/PaymentCertificatesView.tsx` | Rewrote view to load project-scoped main and subcontractor certificates asynchronously from `supabase.from('payment_certificates')` and `supabase.from('subcontractor_payment_certificates')`. Added stale-response race cancellation on project switch, honest empty state (zero certificates, 0 SAR certified, 0 sub profit), atomic durable insert/delete mutations, and creation modals for main and subcontractor IPCs with strict Data Date validation and user-visible error/success notifications. |
| `scripts/validate-controls.ts` | Added S30 test suite (60 checks, S30-A through S30-K) verifying defect reproduction, empty project isolation, reload persistence, cross-project data boundaries, write failures on refusing stores, full backup/restore round-trip with line items, invalid restore rejection, zero commercial math drift in `commercialControlsEngine.ts`, and strict path guards. |
| `docs/FIRST-USE-AND-BACKUP.md` | Updated table inventory and empty project guarantees to document payment certificates. |

### 3. Preserved domain rules

* **Single calculation authority:** All reconciliation, contractual retention, VAT, and Data Date chronology logic remains strictly delegated to `src/lib/commercialControlsEngine.ts`. Zero math drift across all inputs.
* **Governed Data Date:** Payment certificates dated after the project Data Date cannot be approved, certified, or paid. Draft certificates are permitted into the future as look-aheads.
* **Project and BOQ boundary enforcement:** Line items on a project's payment certificate can only reference BOQ items belonging to that exact same project. Cross-project references are rejected at both write and restore time.
* **Durable writes:** Writes require verified storage commits (`commitWorkspace`). Quota or storage refusal returns an explicit error without claiming false success.

### 4. Gate results

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript | `npm run typecheck` | **PASS** (zero errors) |
| Production build | `npm run build` | **PASS** (`dist/` built successfully) |
| Validation harness | `npm run validate:controls` | **PASS 1832/1832** (all 1772 prior checks + 60 new S30 checks) |
| Lint | `npm run lint` | baseline `199 problems (177 errors, 22 warnings)` → now `193 problems (171 errors, 22 warnings)`. Zero lint errors in new/updated code. |
| Browser binary | `google-chrome`, `chromium`, `firefox` | **NOT INSTALLED IN SANDBOX** — flagged as owner-review gate. |

# IPC01 independent owner review — 2026-11-04

The delivered branch passed 1832 controls, but browser review found that valid older
32-table schema-v2 backups were rejected after adding the two certificate tables.
Integrity is now checked against the original declared table inventory before the
missing tables are initialized empty. Tampered older files still fail validation.

Writes and restores now share certificate date/status/numeric/line-ID validation;
duplicate certificate IDs and nonexistent subcontract packages are refused. Partial
upserts validate the merged record. Project changes remount the certificate view,
discarding another project's draft and late response. Contract deductions are entered
explicitly rather than invented as 5%/10%; the existing VAT calculation is unchanged.

Independent controls: 1856/1856; TypeScript and production build passed. Browser QA
restored an original 32-table backup, created a paid main IPC in project A and an
approved subcontract IPC in project B, reopened both, verified isolation and zero
invented deductions, exported 34 tables, and restored that actual export. All original
32 tables remained byte-for-byte equal as JSON values. A future-dated paid IPC was
refused visibly. Header-only certificates remain explicitly **Not itemized**; this
does not constitute acceptance of commercial readiness or automatic EVM posting.


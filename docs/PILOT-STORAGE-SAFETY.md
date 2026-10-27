# SCH-20261027-SAFETY — local workspace storage safety (pilot increment)

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

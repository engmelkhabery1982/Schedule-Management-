# Multi-Agent Repository Workflow

These rules apply to **every** coding agent working in this repository. Read this file
before editing anything, and re-read it at the start of every new session.

> **Branch-scoped edition.** This copy of `AGENTS.md` lives on the accepted working
> lineage `arena/legacy-work-f16622d` → `arena/01a09b83-schedule-management`.
> It is **compatible with** (a superset of) the `AGENTS.md` published on `main`; it adds
> the baseline, branch-protection, and verification rules that this lineage requires.
> The detailed synchronization protocol, branch map, and guard checks are in
> [`docs/MULTI-AGENT-SYNC.md`](docs/MULTI-AGENT-SYNC.md).

---

## 0. Accepted baseline for this line of work

| Item | Value |
| --- | --- |
| Accepted base commit | `f16622dd7a7cffd44d1659495ea4abbd9165db20` (`f16622d`) |
| Base branch (remote) | `origin/arena/legacy-work-f16622d` |
| Active work branch | `arena/01a09b83-schedule-management` |
| Base commit subject | `fix(logic-reconciliation): enforce strict chronological validity at 2026-09-13 data date, eliminate future progress records, synchronize Hospital BAC to 125M SAR, and harmonize multi-EAC/BudgetView engines` |

Rules that follow from this baseline:

1. **`f16622d` is the baseline for this branch**, not `origin/main`. Every commit made here
   must be a **descendant of `f16622d`** (verify with the guard checks in §7).
2. **This branch history is unrelated to `origin/main`.** `git merge-base f16622d origin/main`
   returns *no common ancestor*. Therefore:
   - Never `git pull --rebase origin main` here.
   - Never merge or rebase `main` into this branch.
   - Never "fix" the divergence by rewriting history.
3. **Pushes to the session branch must be fast-forward only.** `--force`, `--force-with-lease`,
   and any history rewrite of a published commit are prohibited.
4. **Do not open a merge/PR into `main`** unless the human owner explicitly asks for it in the
   current task. Publishing this branch with `git push` is allowed and expected; merging is not.

## 1. Before any task

1. Check the working tree with `git status --short`.
2. If local uncommitted changes exist, stop and report them before editing.
3. Synchronize remote references: `git fetch --prune origin` (see §7 for the refspec caveat —
   the local clone tracks `main` only, so use `git ls-remote --heads origin` to read the tips of
   the `arena/*` branches).
4. Confirm you are on the session branch and that the base is still in your ancestry:
   `git rev-parse --abbrev-ref HEAD` and `git merge-base --is-ancestor f16622dd7a7cffd44d1659495ea4abbd9165db20 HEAD`.
5. Update the **session branch only** (`git pull --rebase origin arena/01a09b83-schedule-management`)
   when that remote branch exists and the rebase is a no-op or trivially safe. If it would not be,
   stop and report.
6. After synchronizing, read the current repository instructions and **only** the files required
   for the assigned task. Do not scan the entire repository unless explicitly requested.

## 2. During work

- Work only on the assigned scope; keep diffs minimal and reviewable.
- Do not overwrite unrelated work from another agent, and do not "clean up" files outside scope.
- Do not rewrite repository history or force changes to the remote.
- Prefer targeted checks (`npm run typecheck`, then `npm run lint`) before the full build.
- Do not commit build output, dependencies, logs, or generated binaries
  (`dist/`, `node_modules/`, `*.log`, `project_controls_platform_full.zip`, large sample exports).
  These are governed by `.gitignore`; never force-add them.
- If synchronization produces a conflict or reveals ambiguous newer work, stop and report the
  exact files, branches, and commits involved.

## 3. At the end of every task

1. Review `git status` and `git diff` (and `git diff --stat` for the file list).
2. Run the verification required by the task — see §6.
3. Commit only task-related changes with a clear, conventional-commit message
   (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`) describing *what* and *why*.
4. Synchronize again (`git fetch --prune origin`, then re-check §1.4) before pushing, so work
   published by another agent is detected first.
5. If a conflict appears, do not discard another agent's work; stop and report it unless the
   resolution is trivial and clearly safe.
6. Push the session branch normally:
   `git push -u origin arena/01a09b83-schedule-management` (first push creates the remote branch;
   later pushes must be plain fast-forwards). Never push to `main`, never push another agent's
   branch, never force.
7. Report only: branch, base commit, commit SHA, push status, verification results, changed
   files, and any remaining issue. No PR unless requested.

## 4. Shared-agent rule

The latest accepted state is the **remote repository**, not an agent's old chat context or stale
workspace. Every new agent or session must synchronize first, then continue from the repository
state it actually fetched. When two agents' instructions disagree, the newer published commit on
the session branch wins, and the disagreement must be reported rather than silently resolved.

## 5. Repository map (orientation only)

| Path | Role |
| --- | --- |
| `src/App.tsx`, `src/components/Sidebar.tsx` | Shell, routing between workstations |
| `src/components/views/*.tsx` | Feature workstations (Dashboard, ScheduleView, ProgressView, BudgetView, FinancialControlsView, BoqView, PaymentCertificatesView, DataGovernanceView, DcmaAuditView, TIA / scenario / recovery / BIM 4D / linear views, reports, import/export) |
| `src/lib/*.ts` | Deterministic engines: `cpmEngine`, `calendarEngine`, `earnedScheduleEngine`, `sCurveEngine`, `trendEngine`, `scenarioEngine`, `complexScenarioSimulator`, `monteCarloEngine`, `recoveryEngine`, `recoveryOptimizerEngine`, `resourceLevelingEngine`, `resourceConflictEngine`, `scheduleQualityEngine`, `scheduleDiffEngine`, `dataGovernanceEngine`, `controlHealthEngine`, `alertEngine`, `tiaEngine`, `subcontractEngine`, `planningEngine`, `scheduleGenerator`, `scheduleImporter`, `xerImporter`, `xerExporter`, `boqParser`, `i18n`, `mockSeed`, `supabase` |
| `src/types/index.ts` | Shared domain types (single source of truth for shapes) |
| `supabase/migrations/*.sql` | Schema, RLS, and planning/cost control migrations |
| `sample-data/`, `README.md`, `.bolt/` | Sample BOQ, product documentation, template prompt |

Stack: Vite 5 + React 18 + TypeScript 5 + Tailwind 3, `lucide-react` icons, `xlsx`,
`@supabase/supabase-js`. Import project modules with the `@/` alias (`@/lib/cpmEngine`),
not deep relative paths. UI text is bilingual (Arabic RTL / English LTR) via `src/lib/i18n.ts` —
keep both languages in sync when touching labels.

## 6. Verification commands

There is **no test runner** configured in `package.json`, so verification is static + build:

```bash
npm install          # only if node_modules is missing
npm run typecheck    # tsc --noEmit -p tsconfig.app.json  (fast, run first)
npm run lint         # eslint .
npm run build        # production build (also type-checks); do not commit dist/
npm run dev          # local dev server when a visual check is needed
```

Docs-only or instruction-only commits (like this one) require no build; state that explicitly in
the report instead of skipping verification silently.

## 7. Domain invariants that must not regress

These were established by the base commit `f16622d`. Any change that breaks them is a defect,
even if it compiles:

1. **Data date = `2026-09-13`** (`defaultDataDate` in `src/lib/mockSeed.ts`, with
   `now = 2026-09-13T08:00:00Z`), and each project's `data_date` must agree with it.
2. **Strict chronological validity**: no actual/progress record may be dated *after* the data
   date. `actual_finish`, progress updates, cost transactions, and IPC entries dated beyond the
   data date are invalid; in-progress activities carry `actual_start` with `actual_finish = null`.
3. **No future progress**: `percent_complete` and `actual_quantity` must be consistent with work
   physically achievable by the data date (a not-started activity is `0` with `null` actuals).
4. **Hospital project (`proj-seed-003`) BAC / `contract_value` = 125,000,000 SAR.** The same
   figure must be used by every consumer (BudgetView, EVM, dashboards, reports) — no hardcoded
   duplicates that can drift.
5. **Harmonized forecasting**: the multi-EAC models (optimistic / realistic / pessimistic /
   bottom-up) must produce identical numbers in every view that displays them
   (`BudgetView`, `FinancialControlsView`, `Dashboard`, scenario simulator). One engine,
   many consumers — never re-implement an EVM formula inside a view component.
6. **Single source of truth (SSOT)**: quantities, costs, and schedule dates flow from the
   engines in `src/lib/*`; views render them. Do not introduce a second, divergent calculation
   path, and do not mutate seed data from a view.

## 8. Guard checks (run before committing and before pushing)

```bash
# Am I on the session branch?
git rev-parse --abbrev-ref HEAD                      # -> arena/01a09b83-schedule-management

# Is the accepted base still my ancestor? (must exit 0)
git merge-base --is-ancestor f16622dd7a7cffd44d1659495ea4abbd9165db20 HEAD && echo OK

# Did I touch anything outside my scope?
git status --short && git diff --stat

# Will the push be a fast-forward (no force needed)?
git push --dry-run origin arena/01a09b83-schedule-management
```

Caveats specific to this workspace: the clone is **shallow** (depth 1 at `f16622d`) and its
fetch refspec is limited to `+refs/heads/main:refs/remotes/origin/main`, so
`origin/arena/legacy-work-f16622d` may not exist as a local remote-tracking ref. Read the
`arena/*` tips with `git ls-remote --heads origin` instead of assuming a stale local ref, and do
not run `git fetch --unshallow` unless the task requires history.

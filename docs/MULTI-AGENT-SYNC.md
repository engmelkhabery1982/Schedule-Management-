# Multi-Agent Synchronization Protocol

Companion to [`AGENTS.md`](../AGENTS.md). This document is the operational procedure: which branch
is authoritative, how an agent joins a session, how it publishes work, and what it must never do.

**Status:** active · **Applies to:** the `arena/legacy-work-f16622d` lineage ·
**Last verified:** 2026-09-13 against `https://github.com/engmelkhabery1982/Schedule-Management-`

---

## 1. Why this protocol exists

Several agents work on this repository concurrently, and each one starts from a chat context that
can be older than the repository. Two failure modes are explicitly prevented here:

- **Lost work** — an agent pushes over another agent's commits, or force-pushes a rewritten
  history. Prevented by fast-forward-only pushes and mandatory pre-push fetch.
- **Wrong baseline** — an agent treats `origin/main` as the baseline and rebases/merges onto it,
  destroying the accepted line of work. Prevented by §2 and the unrelated-history rule.

The authoritative state is always **what is on the remote for the session branch**, never an
agent's memory of it.

## 2. Branch map

| Branch | Tip (verified 2026-09-13) | Role | Agent may push? |
| --- | --- | --- | --- |
| `arena/01a09b83-schedule-management` | *(created by this lineage; first push creates it)* | **Active session branch — all work goes here** | ✅ Yes, fast-forward only |
| `arena/legacy-work-f16622d` | `f16622dd7a7cffd44d1659495ea4abbd9165db20` | **Accepted base** of the session lineage; frozen reference | ❌ No (read-only baseline) |
| `main` | `1f289a87f5838313f1738adc137c21d1b8213761` | Repository default branch, **unrelated history** to the lineage above | ❌ No |
| `chore/agent-sync-workflow` | `a1fa827af0c59e4b49c4cb37fdba75e3b5f94e01` | Earlier sync-instructions experiment on the `main` lineage | ❌ No |
| `arena/01a09af6-schedule-management` | `1f289a87f5838313f1738adc137c21d1b8213761` | Other agent session on the `main` lineage | ❌ No (not yours) |

**Lineage:**

```
(unrelated) main ── 1f289a8                     ← do NOT merge/rebase with the line below

f16622d  (arena/legacy-work-f16622d)  ← accepted base
   └── <new commits>  (arena/01a09b83-schedule-management)  ← this session, descendants only
```

Because `git merge-base f16622d origin/main` has **no common ancestor**, cross-lineage operations
(`merge`, `rebase`, `cherry-pick` between `main` and this branch) are out of scope for agents and
require an explicit human decision. Opening a PR/merge into `main` is **not** part of any task
unless the owner asks for it directly.

## 3. Session start checklist (every agent, every session)

```bash
# 1. Where am I, and is the tree clean?
git rev-parse --abbrev-ref HEAD
git status --short                      # must be empty; if not, STOP and report

# 2. What is my HEAD, and is the accepted base in my ancestry?
git rev-parse HEAD
git merge-base --is-ancestor f16622dd7a7cffd44d1659495ea4abbd9165db20 HEAD && echo "BASE OK"

# 3. What does the remote actually say? (local refspec tracks main only)
git fetch --prune origin
git ls-remote --heads origin | grep -E 'arena|main'

# 4. Fast-forward my session branch if it already exists remotely
git pull --rebase origin arena/01a09b83-schedule-management   # skip if the branch does not exist yet

# 5. Authentication sanity check before doing any work
gh auth status
```

Expected healthy result: branch = `arena/01a09b83-schedule-management`, clean tree, `BASE OK`,
`gh` logged in, and (after the first push) the remote tip equal to or ahead of local `HEAD`.

## 4. Publishing work

```bash
git add <only the files in scope>       # never `git add -A` blindly
git status --short && git diff --cached --stat
npm run typecheck && npm run lint       # docs-only commits: state that verification is N/A
git commit -m "<type>(<scope>): <what and why>"
git fetch --prune origin                # detect other agents' work first
git push --dry-run origin arena/01a09b83-schedule-management   # must NOT say "forced update"
git push -u origin arena/01a09b83-schedule-management
```

Commit message conventions: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, with a scope such
as `(logic-reconciliation)`, `(evm)`, `(schedule)`, `(agents)`. One logical change per commit;
instructions/documentation get their own commit, separate from functional work.

## 5. Prohibited operations

| Operation | Why |
| --- | --- |
| `git push --force` / `--force-with-lease` on any shared branch | Destroys another agent's published work |
| `git rebase` / `git commit --amend` / `git reset --hard` on a pushed commit | Rewrites shared history; the next push will not be fast-forward |
| Pushing to `main`, `arena/legacy-work-f16622d`, or another agent's `arena/*` branch | Out of authorized scope; the session is bound to one branch |
| Merging or rebasing `main` ↔ this lineage | Unrelated histories; a human decision, not an agent's |
| Opening a PR/merge into `main` unprompted | Not requested; publish the branch only |
| Deleting/renaming the repository root or `.git` | Breaks the workspace |
| Committing `dist/`, `node_modules/`, logs, or regenerating the tracked `.zip` artifact | Bloats the repo; `.gitignore` already excludes what should be excluded |
| Editing feature/engine files while the task is documentation-only | Violates the scope of the assigned task |

## 6. Conflict and anomaly handling

1. **Non-fast-forward push rejection** → run `git fetch --prune origin`, inspect
   `git log --oneline HEAD..origin/arena/01a09b83-schedule-management`, then `git rebase` **your
   local unpublished commits only** on top of it. Never force. If the rebase conflicts, stop and
   report the files and both commit SHAs.
2. **Dirty tree at session start** → stop, report `git status --short` verbatim. Do not stash or
   discard another agent's in-progress edits.
3. **Base no longer an ancestor** (`merge-base --is-ancestor` fails) → stop. Someone rewrote the
   lineage; report it instead of building on a broken base.
4. **Ambiguous newer work** (another commit changes the same invariant, e.g. the data date or the
   Hospital BAC) → stop and report; do not pick a winner silently.
5. **Authentication failure** (`git`/`gh` 401/403) → stop and tell the owner the GitHub connection
   needs attention. Never ask for tokens, passwords, or 2FA codes in chat.

## 7. Report format at the end of a task

Report exactly these items and nothing else:

- **Current branch**
- **Base commit** (must be `f16622dd7a7cffd44d1659495ea4abbd9165db20` or a descendant chain from it)
- **Commit hash**
- **Push status** (fast-forward / new branch / rejected)
- **Verification** (`typecheck`, `lint`, `build`, or N/A with reason)
- **Changed files**
- **Remaining issues / blockers**

## 8. Workspace caveats

- **Shallow clone:** depth 1 at `f16622d`; the parent commit object is not present locally, so
  `git log` shows a single entry. This is expected — do not "repair" it, and do not run
  `git fetch --unshallow` unless the task needs history.
- **Restricted fetch refspec:** `remote.origin.fetch = +refs/heads/main:refs/remotes/origin/main`.
  Consequently `origin/arena/legacy-work-f16622d` may not resolve locally even though the remote
  branch exists. Use `git ls-remote --heads origin` (authoritative) rather than local
  remote-tracking refs for `arena/*`.
- **Preview servers:** bind to `0.0.0.0`, use relative URLs, and let the dev server proxy API
  calls — the browser is not the sandbox.

## 9. Change log of this protocol

| Date | Change |
| --- | --- |
| 2026-09-13 | Protocol adopted on `arena/01a09b83-schedule-management`, based on `f16622d`. Documentation-only; no application logic or feature file modified. Compatible superset of the `AGENTS.md` published on `main`. |

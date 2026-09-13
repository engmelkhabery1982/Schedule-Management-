# Multi-Agent Repository Workflow

These rules apply to every coding agent working in this repository.

## Before any task
1. Check the working tree with `git status --short`.
2. If local uncommitted changes exist, stop and report them before editing.
3. Synchronize remote references with `git fetch --all --prune`.
4. Update the current tracked branch with `git pull --rebase` when it is safe to do so.
5. Treat `origin/main` as the accepted baseline unless the task explicitly identifies another accepted branch.
6. After synchronization, read the current repository instructions and only the files required for the assigned task. Do not scan the entire repository unless explicitly requested.

## During work
- Work only on the assigned scope.
- Do not overwrite unrelated work from another agent.
- Do not rewrite repository history or force changes to the remote.
- Prefer targeted tests before full test suites.
- If synchronization produces a conflict or reveals ambiguous newer work, stop and report the exact files, branches, and commits involved.

## At the end of every task
1. Review `git status` and `git diff`.
2. Run the tests required by the task.
3. Commit only task-related changes with a clear message.
4. Synchronize again using `git fetch --all --prune` and `git pull --rebase` before pushing, so work published by another agent is detected first.
5. If a conflict appears, do not discard another agent's work; stop and report it unless the resolution is trivial and clearly safe.
6. Push the current branch normally with `git push`. If the branch has no upstream, use `git push -u origin HEAD`.
7. Report only the branch, commit SHA, push status, tests, and any remaining issue.

## Shared-agent rule
The latest accepted state is the remote repository, not an agent's old chat context or stale workspace. Every new agent or session must synchronize first, then continue from the repository state it actually fetched.

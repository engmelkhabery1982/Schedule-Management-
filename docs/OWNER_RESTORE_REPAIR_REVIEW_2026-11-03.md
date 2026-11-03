# Independent owner review — restore repair (3 November 2026)

Incoming SHA: e7d9a13d0fb67cdd785885eefcf27f70a1b25637; verified remote and ancestor4e03e8e. Six incoming files, no dependency or owner-data changes.

Independent local gates: TypeScript exit0; production Vite build exit0 (existing chunk-size warning); actual restore regressions14/14; controls1752/1752 after the Windows guard correction below. Bundles/logs were kept outside the repository in the strategy QA folder because node_modules links to the installed owner dependencies. The first default controls command's cache write was refused; the equivalent build used a QA output file without modifying owner dependencies.

The original independent partial-rollback reproduction now leaves the first auxiliary bytes unchanged and returns an explicit rollback-failure report plus recovery archive when the synthetic store permanently denies another key. Main bytes also match. This verifies the original defect's closure without claiming storage transactions survive permanent denial or concurrent tabs.

Windows-only guard defect: the exact ProgressView substitution compared CRLF checkout bytes to LF from git show. The initial repaired-tree controls failed1/1752. Normalize CRLF to LF on BOTH inputs, retaining exact source substitutions and every assertion. Controls now1752/1752. Product behavior is unchanged by this local guard edit.

Still open: actual isolated AR/EN browser project creation/reopen, backup/restore and error/recovery-download UI. No owner acceptance, owner F update, main merge or deploy.

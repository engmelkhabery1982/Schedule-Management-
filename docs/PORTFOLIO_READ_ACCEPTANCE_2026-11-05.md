# Portfolio read safety — 5 November 2026

Base7485b4c1056dd78d19e300d9e9ed1d74fd0bca70. Existing portfolio reads nine tables; previous destructuring discarded result errors and catch only logged rejected promises. Partial failure could present incomplete totals or a false empty portfolio. Now every result is validated before any setters, failed/rejected reads show an explicit error/retry screen, and a mounted request-generation guard prevents earlier refreshes (including catch/finally) from replacing the latest results. No formulas, query scope, project creation, storage, schema or approvals changed.

Validation: typecheck/build exit0; source/table-to-slot binding9/9 exactly matches the existing S17-E regression expectation, including separate baseline/progress slots and active-approved baseline query. Targeted lint exactly matches baseline11 existing errors/0warnings. Shared read-safety validation covers eleven per-result failures, null payload and asynchronous success/error suppression; reused unchanged.

Actual production PortfolioView in isolated3134 with synthetic read adapter, no writes/owner storage: partial budget read failure out of nine hides portfolio totals and shows error; clicking the actual Retry then completing nine successful reads displays the preserved QA project. Two actual existing DataDate-refresh events were triggered from explicit QA buttons; the newest nine reads displayed QA Portfolio Round2, and releasing the older nine did not replace it. This is read-fault/refresh evidence only, not commercial or financial-model acceptance.

Private proof: PORTFOLIO_READ01_QA/ui-proof.json and affected-checks.json. Historical creation/BOQ/IPC/progress/cost flows were not rerun. No new packages/downloads or engine changes.

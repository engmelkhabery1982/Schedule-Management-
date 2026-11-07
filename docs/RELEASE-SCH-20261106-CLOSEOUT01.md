# Consolidated release package — CLOSEOUT01 / CLOSEOUT02 / PRINT-CLOSEOUT03

**Version:** 2026.11.07-rc2-source. **Remaining product code delivered; RELEASE ACCEPTED: NO.**
Print pagination still requires the final native-PDF review. XML remains a human browser Keep confirmation, not a source failure. No new order, roadmap, deployment or commercial acceptance is implied.

## 1. Exact authority and continuation

- Branch: `arena/3db7d6ec-schedule-management` only.
- PRINT-CLOSEOUT03 base: `faac19970d7389f109cb33c6306cef8a8ec313f3`; clean HEAD/index/worktree and identical session remote tip verified before editing. No additional local worktree, stash or Git lock; no competing remote update observed (not global knowledge of other editors).
- Approved authority remains `a494d39b3b3b5d5d3ccb73fb4892ed2d4a367da9`. F,3130, live services, owner storage/configuration are untouched. Reviewer alone may promote approved/F after acceptance.
- Print code/host-correction commit: `b423d3fea2a221a667b621135b074847237fddba`.
- Prior continuation base: `6a814940194bdf440b54031db6a8e022f565d2d6`. CLOSEOUT02 source/harness tip `805592d070debeb1a1b7edc7b64ea240a2554ef0`; its consolidated report tip wasfaac199. PRINT-CLOSEOUT03 commits/full remote tip are returned with the closeout; a report cannot contain its own hash.

### Historical metadata recovery evidence — preserved, not independently audited here

- On continuation the sandbox Git metadata unexpectedly pointed to `1a12ad7b17dd7db9e394461b976d1bfd1c6b8a3a`, while all148 target files already matched `6a814940…` byte-for-byte. Owner-authorized metadata-only recovery used:
  ```text
  git update-ref refs/heads/arena/3db7d6ec-schedule-management 6a814940194bdf440b54031db6a8e022f565d2d6 1a12ad7b17dd7db9e394461b976d1bfd1c6b8a3a
  git read-tree 6a814940194bdf440b54031db6a8e022f565d2d6
  ```
  No `-u`, reset/clean/stash or working-file rewrite. Expected-old CAS, ancestry, target tree/index and target148 files verified. Complete worktree inventory excluding.git (159 file/directory entries, including ignored/extra entries) identical before/after. Recovery evidence is local, external to Git at `/home/user/sch-metadata-recovery-1794027294357179808`: original HEAD/ref/index, binary staged/unstaged patches, tracked/untracked/ignored inventories and before/after file hashes. No upload.

The path above is a locator, **not independent reviewer verification**. Original recovery evidence remains outside Git; no new recovery was performed in PRINT-CLOSEOUT03 and no working file was rewritten to repair metadata. Reviewer must verify those records before relying on that historical claim. No private artifacts are uploaded.

## 2. HOST REVIEW completed — reuse, no rerun

Owner reports HOST REVIEW at approximately **08:23 Asia/Riyadh,7November2026**, at **faac199 plus the five authorized uncommitted host corrections** incorporated below. These results are attributed to HOST, not this sandbox execution:

| Accepted evidence | Status / exact result |
|---|---|
| Full controls | PASS(reused HOST)1888/1888 |
| Delta response/persistence/export suites | PASS(reused HOST)93/93 =18+63+12 |
| Existing scope model / restore recovery | PASS(reused HOST)27/27 and14/14 |
| Typecheck / production build | PASS(reused HOST)exit0; shell correction also rebuilt0 |
| REAL production ScopeChangeRegister React harness | PASS(reused HOST)6groups /456assertions, including98read-fault cases, late reads/writes, Retry, failed-save retention, historical/foreign/missing/free-text refs, overlap and reject/withdraw. Explicit synthetic adapter, NOT live DB proof |
| ACTUAL production UI snapshots and restore on isolated3136 | PASS(reused HOST): schedule/cost saved at DataDate2026-09-13; actual35-table export → chooser/preview/Restore → reopen/re-export, all35tables+aux equal; approval_events2, snapshots1+1 |
| Canonical agreement on that actual UI chain | PASS(reused HOST): BAC1000/PV1000/EV200/AC100/CPI2/SPI0.2/EAC500/ETC400/VAC500; CPMfinish2026-09-16 |
| Native Microsoft Print to PDF | HOST saved2pages. Initial render exposed app shell; after host shell correction, actual592016byte PDF had no sidebar/header and readable Arabic/totals. **NOT pagination acceptance:** S-curve heading/card on page1, chart continues page2 |
| XML final save | HUMAN GATE: browser security Keep confirmation pending. Do not retry, bypass security or replace exporter |

Earlier HOST evidence at6a814940 also accepted original7000 project VO200/revised7200/AC450 unchanged, draft0/N/A, AR/EN, actual34-table restore equality and actual saved/opened CSV/XER. That older backup had no snapshots; the newer HOST35-table actual chain above now closes the snapshot gate. Historical dated acceptance docs remain supporting evidence for unchanged paths. No accepted gate was rerun for this print-only increment.

## 3. Precisely incorporated five HOST fixes

1. `scripts/closeout02/component.mjs`: row lookup checks `e.cells[0]?.textContent.includes(number)`, not unrelated linked-VO text in another cell.
2. `scripts/closeout02/vite.config.mjs`: `optimizeDeps:{entries:['scripts/closeout02/component.html']}` prevents scanning product index with the QA adapter.
3. `src/components/views/ExecutiveReportView.tsx`: successful report root is `className="executive-report-print space-y-6"`.
4. `src/index.css`: executive-scoped print rules hide only `body:has(.executive-report-print) aside` and `body:has(.executive-report-print) main > header`; clear main margin/padding/min-height; report width100% and color#0f172a.
5. `scripts/closeout02/delta-boundary.mjs`: add **only** `src/index.css` and `src/components/views/ExecutiveReportView.tsx` to existing exact deltaPaths. All existing assertions retained; no blanket allowance.

Sandbox started clean: host corrections were supplied by the owner's task, not silently taken from unknown local edits. No host files/storage were opened or uploaded.

## 4. Only new product-code repair: S-curve pagination

HOST's actual native-PDF render reproduced a split S-curve card. The existing outer card now has `executive-report-scurve`, enclosing its existing Arabic/English heading, SCurveChart and its full legend/footer.

Print-only CSS scoped under `.executive-report-print`:
- `break-inside: avoid-page` plus legacy `page-break-inside: avoid` on **that card only**; heading uses break-after avoidance as a fallback.
- Plotted `svg.select-none` alone (not icon SVGs) keeps width100%, auto height, complete viewBox and bounded72mm print height. No data or label deletion, forced page start or scaling of the whole report.
- Card height remains auto and overflow visible; the chart's scroll container has visible print overflow. No max-height/clipping/hidden content on the card, no fixed-height page wrapper, and no whole-report/table keep-together rule. A card taller than the available page may have avoidance relaxed by native fragmentation rather than becoming an unbreakable overflowing object. No unconditional break that manufactures blank pages.

No screen layout class removed or altered; new classes have rules only in @media print. `SCurveChart.tsx`, chart data/paths/legend, engines, amounts, Arabic text, tables, totals and DataDate are unchanged. Existing native `window.print()` route is unchanged. No library/generator, JavaScript pagination, alternate exporter, browser security bypass or installation.

## 5. Current print-only validation matrix

| Gate | Classification | Scope |
|---|---|---|
| All HOST functional/calculation/integration results in §2 | PASS(reused HOST) | Not re-executed for print delta |
| Exact six-path print delta / ancestry / protected paths | PASS(new source-level) | Comparefaac199 to working tree/index/untracked; only six paths in §6. Existing cumulative boundary guard retained and executed |
| Print/source integrity | PASS(new source-level) | Native print retained; only root/card markers and adjacent comment change in Executive source; shared chart exact unchanged; scoped fragmentation/no hard card height verified. Static check, NOT render/PDF proof |
| Whitespace and changed QA JavaScript syntax | PASS(new) | git diff --check; node --check for corrected component/config/guard |
| Affected print-delta typecheck/build | NOT RUN here | Attempted once; no installed tsc/vite. No install allowed. Existing HOST type/build0 remains attributed to HOST; new pagination CSS is not claimed compiled/rendered here |
| Final native-PDF pagination | NOT RUN | Remaining HOST gate: full heading/chart/legend together on a printable page, no shell/blank pages/cropped labels; preserve Arabic/tables/totals/DataDate. Safe fragmentation if a card is taller than a page |
| Final XML | HUMAN GATE | Existing browser Keep decision and final saved-file confirmation; no new source defect or repeat attempt |
| Final reviewer closeout | OWNER/REVIEWER GATE | Exact final diff/ancestry, historical recovery evidence, rollback and authorized promotion; no commercial acceptance by tests alone |

No1888controls,93/27/14suites,456assertions, snapshot/restore/UI workflow or historical gates were rerun. Local static checks are not a fabricated PDF/screenshot success. The preliminary ad-hoc CSS assertion falsely matched whitespace in its negative regex; the corrected exact-declaration check passed without changing product code or removing a regression assertion.

## 6. Exact outgoing paths and rollback

Only these **six paths** differ fromfaac199 for PRINT-CLOSEOUT03:
- `scripts/closeout02/component.mjs`
- `scripts/closeout02/vite.config.mjs`
- `scripts/closeout02/delta-boundary.mjs`
- `src/components/views/ExecutiveReportView.tsx`
- `src/index.css`
- `docs/RELEASE-SCH-20261106-CLOSEOUT01.md`

The prior delta guard's19paths become21 by adding the two specifically authorized print files. No assertion is removed. Direct diff againstfaac199 protects all engines, shared chart, data/storage, SQL, dependencies, product configuration, approval/date rules and all other paths. Only session branch receives normal commits/push; no main/PR/force/history rewrite/deploy.

Rollback: **do not promote** if final print review fails. Pre-print source target is `faac19970d7389f109cb33c6306cef8a8ec313f3`; the pagination and shell rules are isolated above and require no data rollback/migration. Host shell fix was uncommitted at that base, so a complete return tofaac199 would also remove shell isolation; preserve/review those approved host corrections rather than blindly reverting them. Approved installation remainsa494d39; F/3130 untouched.

For any later authorized isolated-QA application rollback preserve the35-table backup and raw recovery bytes first. Older34-table builds reject35-table envelopes as unknown approval_events; do not strip audit evidence or feed a new backup into an older validator. No owner restore or live rollback is authorized by this package.

## 7. Authorities and retained earlier artifacts

Immutable original scope and governed VO stored values remain separate original/approved/revised/pending authorities. Related cost records are context, not duplicated AC or invented commitment attribution. Entered days are documentary; historical exact-ID claims lack source revision/DataDate and do not certify current measured/approved delay. Shared activity impacts are not blindly summed. F5/F6/F7/F8/Executive authority is reused, not recalculated in this print change. No formula/schema/approval/date assumptions changed.

The earlier original-synthetic sandbox proof is retained as supporting evidence, separate from actual HOST qualification now completed:

Executed external-local artifact directory: `/home/user/sch-closeout02-synthetic-proof-final` (synthetic data only, not committed/uploaded):

| File | SHA256 |
|---|---|
| before-snapshots.json | `2d9bfeade5f3fbe19cb401e0d9f9cb1343720d1a4b51f6c4b73b18fe7f837767` |
| after-snapshots.json | `c0e7dac8b8872456237ea5455980ac2485a036c7b34ffcce67bf4ffb19bb3f29` |
| restored-reexport.json | `124d5e934abf797f20a91b27735dff47bda03d14b04ffb4e43ebe6daa1901216` |

`proof.json` records provenance, hashes and63 assertions. Re-running generates new legitimate IDs; per-run hashes change. Do not compare raw UUIDs against another run.

No re-run of those artifact generators is needed for this print change. The runnable QA files remain available for future reproduction, but this order does not request another functional audit loop.

## 8. Remaining gates only

1. **Native PDF pagination:** after the already provisioned host builds this final source, save through existing native Microsoft Print to PDF and inspect actual rendered pages. Confirm S-curve heading/full chart/legend together when it fits, no shell, blank pages or truncation, Arabic/tables/totals/DataDate intact. If the card exceeds a page under chosen paper/scale/font, confirm safe readable fragmentation rather than forced overflow. No alternate generator or preview-as-PDF claim.
2. **Final XML human Keep:** owner decides the existing browser security warning; confirm the resulting final XML file locally. No repeat automation, security bypass or alternate export.
3. **Final review:** verify exact full remote tip/diff/ancestry and historical metadata evidence, approve rollback/acceptance scope and promote only via reviewer authority. Report alone or a recovery-directory path is not independent audit or human acceptance.

**Code-complete for the remaining print work; release acceptance remains pending these gates.** Local/synthetic evidence does not authorize live backend security, cloud/multi-user deployment, commercial acceptance or owner storage changes.

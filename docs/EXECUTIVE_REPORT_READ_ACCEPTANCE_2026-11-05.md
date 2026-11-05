# Executive report read safety — 5 November 2026

Baseline: 7cf85ec69593086fda96f3533ce34ba49a367f04. Bounded T04 correction in the existing executive report; no financial/schedule formulas, schema, DataDate or owner records changed.

The old view ignored errors from eight required reads and allowed an earlier project's delayed request to replace current report rows. It now rejects partial/invalid reads, hides the report and print action on failure, offers retry, invalidates callbacks after project changes/unmount, and masks previous rows immediately until the selected project has loaded. A successful empty array remains valid; null data does not become an invented empty result. The active/approved baseline join and activity membership filter are preserved.

Validation: report-read regression script passes all eight partial-read failures, null data, out-of-order success, stale rejection/finally suppression, rejected promise, retry and valid empty reads. Application typecheck and production build exit 0. Targeted lint has the same three existing unused bindings (Award, GitCommit, risks); helper has no lint errors. No dependency changes or installs.

Actual isolated browser QA used the production ExecutiveReportView and a controlled asynchronous read adapter on 127.0.0.1:3134, explicitly synthetic and without owner storage. Alpha remained pending; Beta's eight reads completed first, then Alpha's eight were released: Beta stayed selected/reported. A budget read failure hid the entire report/print button and showed the Arabic error with retry. Clicking the actual retry button and releasing eight successful reads restored Alpha's report. Selecting no project showed the selection prompt with no print/report. This is read-fault UI coverage, not a new acceptance claim for the financial engine or empty-project business readiness.

Private QA: AUTONOMOUS_EXECUTION_2026-10-27/REPORT_READ01_QA. The synthetic adapter is not shipped. Owner server/storage were not used for these tests. Existing unrelated creation/restore/IPC/XER/BOQ/baseline/progress/cost gates were reused without rerunning.

## Header metadata correction — separate bounded follow-up
Actual QA exposed hardcoded fallback client (شركة الأفق), location (الرياض), currency and zero contract value when fields were absent. Header now labels missing client/location/value/currency explicitly, preserves supplied text and a genuine zero contract value, and changes no stored data or financial engine. Actual production-view browser QA: null fields showed غير مسجل / غير مسجلة / عملة غير مسجلة; supplied QA client/location and 0 USD displayed exactly. No owner storage, input gate retesting or new dependencies. Typecheck/build rerun for this source delta; the financial/business acceptance remains open.

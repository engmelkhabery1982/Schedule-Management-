# أول استخدام ونسخ احتياطي — First use & backup (single-user local pilot)

> **نطاق هذه الوثيقة / Scope.** This guide covers the **local, single-user pilot workspace** (the
> browser-resident store used when no Supabase credentials are configured). It is deliberately short:
> it documents the first three actions a pilot user takes and the one backup rule that matters.
> It is **not** a commercial acceptance statement and **not** a deployment procedure.

---

## 1. ما الذي يُحفظ وأين؟ / What is stored, and where?

The pilot keeps **one** LocalStorage key:

| Item | Value |
| --- | --- |
| Storage key | `schedule_mgmt_db_v5` |
| Schema version | `2` (`__meta.schema_version`); version `1` (unversioned) is migrated **in memory** on read |
| Scope | every table listed in `PERSISTED_TABLES` (`src/lib/localWorkspace.ts`, 34 tables) — projects, WBS, BOQ, activities, links, resources, assignments, allocations, budgets, costs, progress/approvals, risks, issues, submittals, inspections, calendars, alerts, delay claims, snapshots, subcontracts, payment certificates (`payment_certificates`), subcontractor payment certificates (`subcontractor_payment_certificates`), baselines (header + activity/WBS/BOQ snapshots), the active scope-baseline pointer, and the variation-order register with its links/impacts/events |
| Project-scoped auxiliary stores (also part of a complete backup) | `schedule_diff_revisions_<projectId>` (monthly cut-off revisions + activity snapshots), `construction_subcontracts_data_<projectId>` (legacy subcontract register), `construction_subcontracts_db_import_<projectId>` (one-time import timestamp) |
| Not stored there | language/UI preference (`app_lang`), the selected-project pointer (`schedule_mgmt_selected_project`), and anything belonging to another application or to Supabase auth — these are never read and never exported |

**Rule:** nothing is ever written on read. An absent workspace loads as a **valid empty** workspace,
and a damaged or unreadable one is reported — it is never replaced by demo data.

---

## 2. أول ثلاث خطوات / First three steps

### أ. إنشاء مشروع حقيقي / Create a real project

1. افتح **مركز التحكم بالمحفظة (Portfolio)** ← زر **إضافة مشروع جديد للمحفظة / New Project**.
2. املأ الحقول المطلوبة: اسم المشروع، العميل/المالك، قيمة العقد (رقم > 0)، تاريخ البداية، تاريخ
   الانتهاء التعاقدي. الحقول المطلوبة معلَّمة بـ `*`، والأخطاء تظهر داخل النافذة قبل الإرسال.
3. اضغط **«إنشاء المشروع (فارغ)» / “Create empty project”**.

المشروع الجديد يُنشأ **فارغاً تماماً**: لا BOQ ولا أنشطة ولا روابط ولا بنود تكلفة ولا مستخلصات مالية ولا إنجاز. المدة
التعاقدية تُحسب من التاريخين، وتاريخ البيانات المحكوم (`2026-09-13`) يُطبَّق كسياسة. المشروع الجديد
يصبح المشروع النشط، ويبقى محدَّداً بعد إعادة تحميل المتصفح.

> The new project is created **completely empty** — no BOQ, activities, links, cost lines, payment certificates or progress.
> Its contractual duration is derived from the two dates; the governed Data Date (`2026-09-13`) is
> applied as policy. It becomes the active project and the selection survives a reload.

### ب. بيانات العرض التجريبية / Demo data (منفصل تماماً / entirely separate)

زر **«تحميل مساحة عمل تجريبية (بيانات مُتخيَّلة)» / “Load demo workspace (invented data)”** موجود في
المحفظة وفي الشريط الجانبي وفي شاشة التصدير. هذا الزر هو **الطريق الوحيد** الذي يكتب البيانات
التجريبية (أربعة مشاريع مُتخيَّلة). قبل الاستبدال تُحفظ نسخة من مساحة العمل الحالية تحت مفتاح
`…__pre_reset…` ويمكن تنزيلها من شاشة التصدير.

### ج. النسخ الاحتياطي / Back up

**شاشة التصدير (Export)** ← لوحة **«النسخ الاحتياطي الكامل لمساحة العمل والاستعادة»**:

* **تصدير نسخة احتياطية كاملة / Export complete backup** — ملف JSON واحد، مُصدَّر الإصدارات
  (`format: schedule-management.local-workspace-backup`, `format_version: 1`, `schema_version: 2`)
  يحتوي **كل** الجداول المحفوظة مع عدد السجلات وبصمة تحقق (checksum).
* **ملفات CSV / XER / XML ليست نسخة احتياطية لمساحة العمل.** هي ملفات جدول زمني تُستخدم في P6 أو
  Excel، ولا تحمل الموافقات ولا خطوط الأساس ولا أوامر التغيير. لوحة الاستعادة ترفضها صراحةً.

---

## 3. الاستعادة الآمنة / Safe restore (خطوتان / two presses)

1. **اختيار الملف (لا يُغيّر شيئاً)** — يُقرأ الملف ويُتحقق من: الصيغة، الإصدار، جرد الجداول،
   المعرّفات (فريدة وغير فارغة)، علاقات المشاريع (الأنشطة/الروابط/WBS/BOQ/خطوط الأساس/أوامر التغيير)،
   ترتيب التواريخ، قاعدة تاريخ البيانات (لا سجل إنجاز أو تكلفة بعد تاريخ البيانات)، وحقول الموافقات،
   ثم البصمة. تظهر **معاينة**: المشاريع وتواريخها وتاريخ البيانات وعدد سجلات كل جدول وحالة الموافقات.
   أي خطأ ⇒ لا شيء يُكتب إطلاقاً، ومساحة العمل تبقى **متطابقة بايت ببايت**.
2. **«استعادة الآن» / “Restore now”** — تُكتب نسخة **قبل الاستعادة** (`…__pre_restore…`) وتُنزَّل
   تلقائياً، ثم تُكتب الحالة الجديدة ويُعاد قراءتها للتحقق. أي فشل ⇒ رجوع تلقائي إلى البايتات السابقة
   بالضبط.

**ترتيب مقترح لكل جلسة عمل:** صدّر نسخة كاملة قبل أي استعادة، وقبل تحميل بيانات تجريبية، وقبل مسح
مساحة العمل.

---

## 4. عند حدوث مشكلة / When something is wrong

| ما تراه / What you see | معناه / Meaning | ما تفعله / What to do |
| --- | --- | --- |
| شريط أحمر: «تعذّر قراءة مساحة العمل المحلية» / red banner “The local workspace could not be read” | البايتات المحفوظة غير صالحة (JSON تالف/إصدار أحدث/ترحيل فاشل). **لم يتم استبدالها.** | افتح شاشة التصدير → **تنزيل البايتات المحفوظة** (نسخة `…__preserved…`)، ثم استعد ملفاً صالحاً أو ابدأ مساحة فارغة |
| شريط «لا توجد مشاريع في مساحة العمل المحلية» / “No projects in this local workspace” | مساحة عمل فارغة **صالحة** — ليست خطأ | أنشئ مشروعاً، أو استعد نسخة، أو حمّل بيانات تجريبية |
| فشل حفظ عند الإدخال (رسالة خطأ) | كتابة رُفضت (سياسة المتصفح) أو امتلأ التخزين (quota). **لم يتم حفظ شيء** | حرّر مساحة (نزّل نسخة احتياطية أولاً) وأعد المحاولة؛ التطبيق لا يدّعي النجاح |
| زر التصدير يعرض «تعذّر تصدير مساحة العمل» | البايتات تالفة، والنسخة المحفوظة متاحة أسفل اللوحة | نزّل النسخة المحفوظة قبل أي إجراء آخر |

---

## 5. حدود هذا الوضع / Limits of this mode

* مساحة عمل **محلية لمستخدم واحد** في متصفح واحد؛ لا مزامنة، ولا تعدد مستخدمين، ولا نسخ تلقائي.
* النسخة الاحتياطية = مسؤولية المستخدم: صدّرها إلى مجلد محفوظ (ليست في المتصفح فقط).
* لا تُعدّ هذه البوابة قبولاً تجارياً ولا بديلاً عن مراجعة المساعد وتكامله.

## Existing XER import: file or pasted text (4 November 2026)

On Import Project, choose Primavera P6 (.xer). Either select a file or expand
**لصق محتوى XER / Paste XER text**, paste its original tab-delimited text, and
press **تحليل ومعاينة XER / Analyze and preview XER**. Both inputs use the same
parser, reconciliation preview and explicit import confirmation. Previewing does
not save a project. Changing either source invalidates its old preview and any
baseline opt-in; late file reads cannot replace a newer source. Invalid text
cannot import an earlier preview. The same file can be selected again after a
failed/replaced preview.

Review Data Date, currency, unsupported/dropped fields and calendar warnings before
confirming. No calendar work pattern or approved baseline is invented by this
input route. Existing parser warnings and save/cleanup semantics remain visible.
This is a local single-user workflow; it does not establish remote-backend or
commercial readiness.

Independent isolated browser acceptance used original XER text for three activities
and two FS links (not a workspace-restore fixture), then saved, reopened, exported
and compared all34 tables exactly. IDs, dates, durations, WBS/calendar references,
null actual dates and zero progress survived; no baseline or financial records
were invented. Invalid initial text was refused, and editing a valid preview
immediately disabled import and removed the stale activities. TypeScript/build,
focused ImportView lint and1858controls passed; prior IPC acceptance was retained.

## Existing BOQ wizard input and data preservation (4 November 2026)

Select Import Project → BOQ (Excel/CSV), then choose a file or expand
**لصق جدول CSV / Paste BOQ CSV** and paste headers plus item rows. Both routes
use the existing parser and planning wizard. Review classification, productivity
assumptions, activities, relationships and cost allocation before explicitly saving
a planning draft. Parsing itself saves nothing. Editing the source clears the
previous preview and overrides; late reads cannot restore an obsolete plan.

Malformed/nonfinite numeric text is rejected instead of being saved as zero or
being guessed as a spreadsheet date. Raw CSV codes retain leading zeroes; scientific
notation and recognized currency tokens remain supported. Existing blank optional
number handling and commercial/planning formulas are unchanged. New BOQ records
retain their existing category field; planning-family classification and the coarse
BOQ category remain distinct existing classifications.

New generated drafts explicitly start with zero reported progress/actual quantity,
null actual dates, and the governed default Data Date shown in the preview. This
creates no actual cost/progress or approved-baseline records. Previously stored
projects are not rewritten. Approval still requires the existing explicit evidence.

Independent acceptance used three source rows totaling7000, reviewed classifications
and all generated links, manually changed excavation duration to2days, saved the
draft, reopened BOQ and CPM, and compared two real exports across all34tables and
auxiliary stores. Quantities/rates/categories, UUIDs,6links and the duration override
remained exact; no baseline or actual cost was invented.1861controls,14focused
CSV/XLSX/persistence regressions, TypeScript, build and focused implementation lint
passed. This closes a local input workflow, not commercial readiness or field
validation of library productivity assumptions. Browser file-chooser permission was
not retried or claimed as passed.

## Daily progress pilot (4 November2026)
Open Progress → Single activity, select the activity, enter a positive finite physical quantity and a valid daily date on/before the governed DataDate, then save. Reopen the project and compare the approved record and cumulative quantity. Empty/impossible dates are refused before daily writes. Neither daily mode changes the project DataDate.
Progress valuation quotes the existing canonical F6 activity budget (approved baseline first, otherwise the direct activity budget), converted using its planned physical quantity. No project BAC is split equally across activities and no BOQ-description similarity assigns a price. Missing price basis stays N/A; explicit zero stays zero. This is planned earned-value valuation, not cash received, a paid invoice or proof of profit. Historical stored commercial values remain unchanged. Synthetic QA approval is not owner business approval.

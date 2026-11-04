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

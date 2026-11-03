import { useRef, useState } from 'react';
import {
  backupFileName,
  buildBackup,
  listPreservedCopies,
  readAuxiliaryStores,
  readWorkspace,
  restoreWorkspace,
  serializeBackup,
  validateBackup,
  type BackupValidation,
} from '@/lib/localWorkspace';
import {
  getWorkspaceStorage,
  loadDemoWorkspace,
  startEmptyWorkspace,
} from '@/lib/supabase';
import { getLanguage, type Language } from '@/lib/i18n';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  HardDriveDownload,
  RotateCcw,
  ShieldAlert,
  Upload,
} from 'lucide-react';

/**
 * S29 — complete local-workspace backup & validated restore, on the existing Export surface.
 *
 * What it does, in the order it does it:
 *   1. EXPORT writes a versioned JSON file holding every persisted table (the inventory lives in
 *      `localWorkspace.PERSISTED_TABLES`). It never reads or writes any other browser key, so
 *      credentials, language/UI preferences and unrelated storage are structurally excluded.
 *   2. RESTORE parses and FULLY validates the file first (format, version, table inventory, ids,
 *      project relationships, date ordering, Data Date chronology, approvals fields, checksum) and
 *      only then shows a preview. Nothing is written until the user presses Restore.
 *   3. The restore itself writes a recoverable pre-restore copy of the current bytes, then the new
 *      state, then verifies it; a failed write rolls back to the exact previous bytes.
 *
 * A CSV or XER export is a schedule file, not a workspace backup, and is rejected by the format check.
 */
export default function WorkspaceBackupPanel() {
  const [lang] = useState<Language>(getLanguage());
  const isAr = lang === 'ar';
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [backupText, setBackupText] = useState<string | null>(null);
  const [validation, setValidation] = useState<BackupValidation | null>(null);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'info'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copies, setCopies] = useState(() => (getWorkspaceStorage() ? listPreservedCopies(getWorkspaceStorage()!) : []));

  // Read on each render: this panel is the recovery surface, so it must reflect the bytes on disk
  // rather than a cached copy that could disagree with them.
  const workspaceLoaded = (() => {
    const storage = getWorkspaceStorage();
    return storage ? readWorkspace(storage) : null;
  })();
  const workspaceState = workspaceLoaded === null
    ? null
    : workspaceLoaded.status === 'fault'
      ? { fault: workspaceLoaded.fault, state: null }
      : { fault: null, state: workspaceLoaded.state };

  function downloadText(text: string, name: string) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  function refreshCopies() {
    const storage = getWorkspaceStorage();
    try { setCopies(storage ? listPreservedCopies(storage) : []); }
    catch (err) { setStatus({ tone: 'error', message: String(err) }); }
  }

  function handleExport() {
    const storage = getWorkspaceStorage();
    if (!storage) {
      setStatus({ tone: 'error', message: isAr ? 'لا تتوفر مساحة تخزين محلية في هذا المتصفح.' : 'This browser exposes no local workspace storage.' });
      return;
    }
    try {
      const loaded = readWorkspace(storage);
      if (loaded.status === 'fault') {
        setStatus({
          tone: 'error',
          message: isAr
            ? `تعذّر تصدير مساحة العمل: ${loaded.fault.message}. الملف التالف محفوظ كما هو (${loaded.fault.preservedKey ?? '—'}).`
            : `The workspace could not be exported: ${loaded.fault.message}. The damaged payload is preserved as-is (${loaded.fault.preservedKey ?? '—'}).`,
        });
        return;
      }
      // A complete backup carries the inventoried tables AND the workspace-owned project-scoped
      // auxiliary stores (monthly cut-off revisions, legacy subcontract register). No other browser key
      // is ever read.
      const backup = buildBackup(loaded.state, new Date().toISOString(), readAuxiliaryStores(storage));
      downloadText(serializeBackup(backup), backupFileName(backup));
      setStatus({
        tone: 'ok',
        message: isAr
          ? `تم تصدير نسخة كاملة: ${backup.source.project_count} مشروعاً و${backup.source.row_count} سجلاً في ${Object.keys(backup.counts).length} جدولاً.`
          : `Complete backup exported: ${backup.source.project_count} projects, ${backup.source.row_count} rows across ${Object.keys(backup.counts).length} tables.`,
      });
      refreshCopies();
    } catch (err) {
      setStatus({ tone: 'error', message: isAr ? `تعذّر تصدير نسخة كاملة: ${String(err)}` : `Complete backup refused: ${String(err)}` });
    }
  }

  async function handleFile(file: File | null) {
    if (!file) return;
    setFileName(file.name);
    setValidation(null);
    setStatus(null);
    const text = await file.text();
    setBackupText(text);
    const result = validateBackup(text);
    setValidation(result);
    if (!result.ok) {
      setStatus({
        tone: 'error',
        message: isAr
          ? 'الملف غير صالح كنسخة احتياطية لمساحة العمل — لم يتم تغيير أي بيانات.'
          : 'The file is not a valid workspace backup — no data was changed.',
      });
    }
  }

  function handleRestore() {
    const storage = getWorkspaceStorage();
    if (!storage || !validation?.state) return;
    setBusy(true);
    try {
      const result = restoreWorkspace(storage, validation);
      if (!result.ok) {
        if (result.preRestoreKey !== null || result.preRestoreAuxiliary.length > 0) {
          downloadText(JSON.stringify({ main_workspace_bytes: result.preRestoreBytes,
            auxiliary: result.preRestoreAuxiliary, error: result.error }, null, 2),
          'schedule-workspace-failed-restore-recovery.json');
        }
        refreshCopies();
        setStatus({ tone: 'error', message: result.error ?? 'restore failed' });
        return;
      }
      // Recoverable pre-restore copy: the exact previous bytes of the workspace AND of every
      // auxiliary store the restore replaced, downloaded before anything else happens.
      downloadText(
        JSON.stringify({
          note: 'pre-restore recovery archive (not a restore file): the workspace bytes and auxiliary stores that the restore replaced',
          created_at: new Date().toISOString(),
          pre_restore_storage_key: result.preRestoreKey,
          main_workspace_bytes: result.preRestoreBytes,
          auxiliary: result.preRestoreAuxiliary,
        }, null, 2),
        `schedule-workspace-pre-restore_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      );
      refreshCopies();
      setStatus({
        tone: 'ok',
        message: isAr
          ? 'تمت الاستعادة والتحقق منها. النسخة السابقة محفوظة ومُصدَّرة. سيُعاد تحميل الواجهة الآن.'
          : 'Restore completed and verified. The previous workspace was preserved and downloaded. Reloading now.',
      });
      window.setTimeout(() => window.location.reload(), 1200);
    } finally {
      setBusy(false);
    }
  }

  function handleDownloadCopy(key: string) {
    const storage = getWorkspaceStorage();
    if (!storage) return;
    const raw = storage.getItem(key);
    if (raw === null) return;
    downloadText(raw, `${key.replace(/[^\w.-]+/g, '_')}.json`);
  }

  function handleStartEmpty() {
    const message = isAr
      ? 'سيتم مسح مساحة العمل إلى حالة فارغة وصالحة (بدون مشاريع). ستُحفظ النسخة الحالية كنسخة قابلة للاستعادة أولاً. المتابعة؟'
      : 'This clears the workspace to a valid empty state (no projects). The current bytes are preserved as a recoverable copy first. Continue?';
    if (!window.confirm(message)) return;
    const result = startEmptyWorkspace();
    if (!result.ok) {
      setStatus({ tone: 'error', message: result.error ?? 'reset failed' });
      return;
    }
    refreshCopies();
    window.location.reload();
  }

  const summary = validation?.summary ?? null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-black text-slate-900 flex items-center gap-2">
            <Database size={18} className="text-amber-500" />
            {isAr ? 'النسخ الاحتياطي الكامل لمساحة العمل والاستعادة' : 'Complete workspace backup & restore'}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {isAr
              ? 'نسخة JSON مُصدَّرة الإصدارات تشمل كل الجداول المحفوظة (المشاريع، WBS، BOQ، الأنشطة، الروابط، الالتزامات، خطوط الأساس، الموافقات، التكاليف، المخاطر، المستخلصات، أوامر التغيير…). ملفات CSV/XER ليست نسخة احتياطية لمساحة العمل.'
              : 'A versioned JSON file containing every persisted table (projects, WBS, BOQ, activities, links, baselines, approvals, costs, risks, submittals, variation orders…). CSV/XER files are schedules, not workspace backups.'}
          </p>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-amber-400 text-xs font-bold cursor-pointer"
        >
          <HardDriveDownload size={15} />
          {isAr ? 'تصدير نسخة احتياطية كاملة' : 'Export complete backup'}
        </button>
      </div>

      {status && (
        <div
          className={`rounded-xl border p-3 text-xs leading-relaxed ${
            status.tone === 'ok'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
              : status.tone === 'error'
                ? 'border-rose-300 bg-rose-50 text-rose-900'
                : 'border-slate-300 bg-slate-50 text-slate-700'
          }`}
          role={status.tone === 'error' ? 'alert' : 'status'}
        >
          {status.message}
        </div>
      )}

      {workspaceState?.fault && (
        <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900" role="alert">
          <p className="font-bold flex items-center gap-1">
            <ShieldAlert size={14} />
            {isAr ? 'مساحة العمل المحلية تالفة — لم يُستبدل منها أي بايت' : 'The local workspace is damaged — none of its bytes were replaced'}
          </p>
          <p className="mt-1">{workspaceState.fault.message}</p>
          {workspaceState.fault.preservedKey && (
            <p className="mt-1 font-mono text-[11px] break-all">{workspaceState.fault.preservedKey}</p>
          )}
          <div className="flex flex-wrap gap-2 mt-2">
            {workspaceState.fault.preservedKey && (
              <button
                onClick={() => handleDownloadCopy(workspaceState.fault!.preservedKey!)}
                className="px-3 py-1.5 rounded-lg bg-rose-700 text-white text-[11px] font-bold cursor-pointer"
              >
                {isAr ? 'تنزيل البايتات المحفوظة' : 'Download preserved bytes'}
              </button>
            )}
            <button
              onClick={handleStartEmpty}
              className="px-3 py-1.5 rounded-lg bg-white border border-rose-400 text-rose-800 text-[11px] font-bold cursor-pointer"
            >
              {isAr ? 'بدء مساحة عمل فارغة (مع الحفظ)' : 'Start an empty workspace (keeps a copy)'}
            </button>
          </div>
        </div>
      )}

      {/* Restore */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
        <h3 className="text-sm font-black text-slate-800 flex items-center gap-2">
          <Upload size={15} className="text-indigo-500" />
          {isAr ? 'استعادة نسخة احتياطية (تحقق كامل قبل أي تغيير)' : 'Restore a backup (full validation before any change)'}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
            className="text-xs"
          />
          {fileName && <span className="text-[11px] text-slate-500 font-mono">{fileName}</span>}
        </div>

        {validation && (
          <div className="space-y-2">
            {validation.errors.length > 0 && (
              <div className="rounded-lg border border-rose-300 bg-rose-50 p-2.5 text-[11px] text-rose-900" role="alert">
                <p className="font-bold">{isAr ? 'أخطاء التحقق (لم يتم تغيير أي شيء):' : 'Validation errors (nothing was changed):'}</p>
                <ul className="mt-1 space-y-1">
                  {validation.errors.map((issue) => (
                    <li key={`${issue.code}-${issue.path}-${issue.message}`}>• <span className="font-mono">{issue.path}</span> — {issue.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {validation.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-[11px] text-amber-900">
                {validation.warnings.map((warning) => <p key={warning}>• {warning}</p>)}
              </div>
            )}

            {validation.ok && summary && (
              <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-[11px] text-emerald-950 space-y-2">
                <p className="font-black flex items-center gap-1">
                  <CheckCircle2 size={13} />
                  {isAr ? 'معاينة الاستعادة — تم التحقق من البنية والإصدار والمعرّفات والعلاقات' : 'Restore preview — structure, version, ids and relationships verified'}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono">
                  <span>{isAr ? 'الإصدار' : 'schema'} v{summary.schemaVersion}</span>
                  <span>{isAr ? 'السجلات' : 'rows'} {summary.totalRows}</span>
                  <span>{isAr ? 'المشاريع' : 'projects'} {summary.projects.length}</span>
                  <span>
                    {isAr ? 'البصمة' : 'checksum'} {summary.checksumVerified ? '✓' : '—'}
                  </span>
                </div>
                <div>
                  <p className="font-bold">{isAr ? 'المشاريع في النسخة:' : 'Projects in this backup:'}</p>
                  <ul className="mt-0.5">
                    {summary.projects.length === 0 && <li>— ({isAr ? 'مساحة فارغة صالحة' : 'valid empty workspace'})</li>}
                    {summary.projects.map((project) => (
                      <li key={project.id}>
                        • <span className="font-semibold">{project.name}</span>{' '}
                        <span className="font-mono text-[10px]">
                          [{project.id}] {project.start_date ?? '—'} → {project.end_date ?? '—'} ·{' '}
                          {isAr ? 'تاريخ البيانات' : 'data date'} {project.data_date ?? '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="font-bold">{isAr ? 'الجداول:' : 'Tables:'}</p>
                  <p className="font-mono text-[10px] leading-relaxed">
                    {summary.counts.filter((count) => count.rows > 0).map((count) => `${count.table}=${count.rows}`).join(' · ')}
                  </p>
                </div>
                {summary.auxiliary.length > 0 && (
                  <p className="font-mono text-[10px] break-all">
                    {isAr ? 'مخازن مساندة' : 'auxiliary'}: {summary.auxiliary.map((entry) => `${entry.key} (${entry.bytes}B)`).join(' · ')}
                  </p>
                )}
                <p className="font-mono text-[10px]">
                  {isAr ? 'الموافقات' : 'approvals'}: {isAr ? 'تحديثات' : 'progress'} {summary.approvals.progressApproved}
                  {' / '}
                  {summary.approvals.progressApproved + summary.approvals.progressOther} · {isAr ? 'تكاليف' : 'cost'} {summary.approvals.costApproved}
                  {' / '}
                  {summary.approvals.costApproved + summary.approvals.costOther}
                  {summary.dataDates.length > 0 && ` · ${isAr ? 'تواريخ البيانات' : 'data dates'}: ${summary.dataDates.join(', ')}`}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    onClick={handleRestore}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-bold cursor-pointer disabled:opacity-60"
                  >
                    {busy
                      ? (isAr ? 'جارٍ الاستعادة…' : 'Restoring…')
                      : (isAr ? 'استعادة الآن (سيتم حفظ نسخة قبل الاستعادة)' : 'Restore now (a pre-restore copy is saved)')}
                  </button>
                  <button
                    onClick={() => { setValidation(null); setBackupText(null); setFileName(null); if (fileInput.current) fileInput.current.value = ''; }}
                    className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-slate-700 text-xs font-bold cursor-pointer"
                  >
                    {isAr ? 'إلغاء' : 'Cancel'}
                  </button>
                </div>
                {backupText !== null && (
                  <p className="text-[10px] text-emerald-800">
                    {isAr ? 'الملف المقروء: ' : 'Read file: '}{fileName} · {backupText.length} {isAr ? 'حرفاً' : 'chars'}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {!validation && (
          <p className="text-[11px] text-slate-500 flex items-center gap-1">
            <AlertTriangle size={12} className="text-amber-500" />
            {isAr
              ? 'لا يتم أي تغيير عند اختيار الملف: التحقق والمعاينة فقط. الاستعادة تتطلب ضغط الزر صراحةً.'
              : 'Selecting a file changes nothing: it is parsed, validated and previewed only. Restoring requires pressing the button explicitly.'}
          </p>
        )}
      </div>

      {/* Recoverable copies */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-black text-slate-800 flex items-center gap-2">
            <RotateCcw size={15} className="text-slate-500" />
            {isAr ? 'النسخ القابلة للاستعادة في هذا المتصفح' : 'Recoverable copies in this browser'}
            <span className="font-mono text-[11px] text-slate-400">({copies.length})</span>
          </h3>
          <button onClick={refreshCopies} className="text-[11px] font-bold text-slate-600 underline cursor-pointer">
            {isAr ? 'تحديث' : 'Refresh'}
          </button>
        </div>
        {copies.length === 0 ? (
          <p className="text-[11px] text-slate-500">
            {isAr ? 'لا توجد نسخ محفوظة بعد.' : 'No preserved copies yet.'}
          </p>
        ) : (
          <ul className="space-y-1">
            {copies.slice(0, 10).map((copy) => (
              <li key={copy.key} className="flex flex-wrap items-center justify-between gap-2 text-[11px] border border-slate-100 rounded-lg px-2 py-1">
                <span className="font-mono break-all">{copy.key}</span>
                <span className="flex items-center gap-2">
                  <span className="text-slate-400">{(copy.bytes / 1024).toFixed(1)} KB</span>
                  <button
                    onClick={() => handleDownloadCopy(copy.key)}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-slate-100 text-slate-700 font-bold cursor-pointer"
                  >
                    <Download size={11} />
                    {isAr ? 'تنزيل' : 'Download'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-600 leading-relaxed">
        <p className="font-bold text-slate-800">
          {isAr ? 'تحميل مساحة عمل تجريبية' : 'Load a demo workspace'}
        </p>
        <p>
          {isAr
            ? 'مساحة العمل التجريبية تُنشأ بأربعة مشاريع مُتخيَّلة لأغراض العرض فقط، وهي منفصلة تماماً عن إنشاء مشروع حقيقي. تُحفظ مساحة العمل الحالية كنسخة قابلة للاستعادة قبل الاستبدال.'
            : 'A demo workspace is four invented projects for demonstration only, entirely separate from creating a real project. The current workspace is preserved as a recoverable copy before it is replaced.'}
        </p>
        <button
          onClick={() => {
            const message = isAr
              ? 'سيتم استبدال مساحة العمل التجريبية بالبيانات الحالية بعد حفظ نسخة قابلة للاستعادة. المتابعة؟'
              : 'Load the demo workspace? The current workspace is preserved as a recoverable copy. Continue?';
            if (!window.confirm(message)) return;
            const result = loadDemoWorkspace();
            if (!result.ok) setStatus({ tone: 'error', message: result.error ?? 'demo workspace failed' });
            else window.location.reload();
          }}
          className="mt-1 px-3 py-1 rounded-lg bg-amber-100 border border-amber-300 text-amber-900 font-bold cursor-pointer"
        >
          {isAr ? 'تحميل البيانات التجريبية (مع حفظ الحالية)' : 'Load demo data (keeps a recoverable copy)'}
        </button>
      </div>
    </section>
  );
}

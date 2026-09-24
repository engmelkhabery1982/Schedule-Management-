import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertCircle,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Clock3,
  FileCheck2,
  FileText,
  History,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import type {
  Activity,
  ActivityBoqAllocation,
  BaselineBoqItem,
  BaselineWbsNode,
  BoqItem,
  Project,
  ProjectBaseline,
  VariationOrder,
  VariationOrderActivityLink,
  VariationOrderBoqImpact,
  VariationOrderEvent,
  VariationOrderStatus,
  VariationOrderWbsLink,
  WbsNode,
} from '@/types';
import { getLanguage, type Language } from '@/lib/i18n';
import { approveScopeBaseline } from '@/lib/boqPlanService';
import {
  calculateScopeSummary,
  getScopeItemMetrics,
  isPendingVariationOrderStatus,
} from '@/lib/scopeChangeEngine';
import { supabase } from '@/lib/supabase';

interface ScopeChangeRegisterProps {
  project: Project | null;
}

interface VoBoqImpactDraft {
  boqItemId: string;
  quantityImpact: string;
  valueImpact: string;
  notes: string;
}

interface VoDraftForm {
  id: string | null;
  revisionOfId: string | null;
  voNumber: string;
  title: string;
  description: string;
  cause: 'client_request' | 'design_change' | 'site_condition' | 'authority_requirement' | 'other';
  source: string;
  sourceReference: string;
  requestedDate: string;
  requestedBy: string;
  scheduleImpactDays: string;
  scheduleImpactReference: string;
  notes: string;
  boqImpacts: VoBoqImpactDraft[];
  wbsIds: string[];
  activityIds: string[];
}

interface TransitionIntent {
  order: VariationOrder;
  nextStatus: VariationOrderStatus;
}

interface TransitionForm {
  actor: string;
  effectiveDate: string;
  reference: string;
  evidenceReference: string;
  notes: string;
}

const CAUSES: VoDraftForm['cause'][] = [
  'client_request',
  'design_change',
  'site_condition',
  'authority_requirement',
  'other',
];

function emptyDraft(number = 'VO-001'): VoDraftForm {
  return {
    id: null,
    revisionOfId: null,
    voNumber: number,
    title: '',
    description: '',
    cause: 'client_request',
    source: '',
    sourceReference: '',
    requestedDate: '',
    requestedBy: '',
    scheduleImpactDays: '',
    scheduleImpactReference: '',
    notes: '',
    boqImpacts: [],
    wbsIds: [],
    activityIds: [],
  };
}

function parseNullableInput(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function amountLabel(value: number | null, lang: Language, currency: string): string {
  if (value === null || !Number.isFinite(value)) return lang === 'ar' ? 'غير متاح (N/A)' : 'N/A';
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;
}

function numericLabel(value: number | null | undefined, unit: string | null, lang: Language): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return lang === 'ar' ? 'غير متاح (N/A)' : 'N/A';
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`;
}

function statusLabel(status: VariationOrderStatus, lang: Language): string {
  const labels: Record<VariationOrderStatus, [string, string]> = {
    draft: ['مسودة', 'Draft'],
    submitted: ['مقدم', 'Submitted'],
    under_review: ['قيد المراجعة', 'Under Review'],
    approved: ['معتمد', 'Approved'],
    rejected: ['مرفوض', 'Rejected'],
    withdrawn: ['مسحوب', 'Withdrawn'],
  };
  return labels[status][lang === 'ar' ? 0 : 1];
}

function causeLabel(cause: VoDraftForm['cause'], lang: Language): string {
  const labels: Record<VoDraftForm['cause'], [string, string]> = {
    client_request: ['طلب العميل', 'Client request'],
    design_change: ['تغيير تصميم', 'Design change'],
    site_condition: ['ظروف الموقع', 'Site condition'],
    authority_requirement: ['متطلبات جهة رسمية', 'Authority requirement'],
    other: ['أخرى', 'Other'],
  };
  return labels[cause][lang === 'ar' ? 0 : 1];
}

function statusTone(status: VariationOrderStatus): string {
  if (status === 'approved') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (status === 'rejected') return 'bg-rose-100 text-rose-800 border-rose-200';
  if (status === 'withdrawn') return 'bg-slate-100 text-slate-600 border-slate-200';
  if (status === 'under_review') return 'bg-blue-100 text-blue-800 border-blue-200';
  return 'bg-amber-100 text-amber-800 border-amber-200';
}

function nextVoNumber(orders: VariationOrder[]): string {
  const max = orders.reduce((highest, order) => {
    const match = order.vo_number.match(/(\d+)$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `VO-${String(max + 1).padStart(3, '0')}`;
}

export default function ScopeChangeRegister({ project }: ScopeChangeRegisterProps) {
  const [lang, setLang] = useState<Language>(getLanguage());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [baselinePointer, setBaselinePointer] = useState<{ baseline_id: string } | null>(null);
  const [baselineHistory, setBaselineHistory] = useState<ProjectBaseline[]>([]);
  const [baselineItems, setBaselineItems] = useState<BaselineBoqItem[]>([]);
  const [baselineWbs, setBaselineWbs] = useState<BaselineWbsNode[]>([]);
  const [currentBoq, setCurrentBoq] = useState<BoqItem[]>([]);
  const [currentWbs, setCurrentWbs] = useState<WbsNode[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [allocations, setAllocations] = useState<ActivityBoqAllocation[]>([]);
  const [orders, setOrders] = useState<VariationOrder[]>([]);
  const [boqImpacts, setBoqImpacts] = useState<VariationOrderBoqImpact[]>([]);
  const [wbsLinks, setWbsLinks] = useState<VariationOrderWbsLink[]>([]);
  const [activityLinks, setActivityLinks] = useState<VariationOrderActivityLink[]>([]);
  const [events, setEvents] = useState<VariationOrderEvent[]>([]);
  const [showBaselineModal, setShowBaselineModal] = useState(false);
  const [baselineEvidence, setBaselineEvidence] = useState({ approvedBy: '', approvalReference: '', approvedAt: '' });
  const [draftForm, setDraftForm] = useState<VoDraftForm>(() => emptyDraft());
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [transition, setTransition] = useState<TransitionIntent | null>(null);
  const [transitionForm, setTransitionForm] = useState<TransitionForm>({ actor: '', effectiveDate: '', reference: '', evidenceReference: '', notes: '' });
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);

  useEffect(() => {
    const updateLanguage = () => setLang(getLanguage());
    window.addEventListener('app-language-changed', updateLanguage);
    return () => window.removeEventListener('app-language-changed', updateLanguage);
  }, []);

  async function loadData() {
    if (!project?.id) {
      setBaselinePointer(null);
      setBaselineHistory([]);
      setBaselineItems([]);
      setBaselineWbs([]);
      setCurrentBoq([]);
      setCurrentWbs([]);
      setActivities([]);
      setAllocations([]);
      setOrders([]);
      setBoqImpacts([]);
      setWbsLinks([]);
      setActivityLinks([]);
      setEvents([]);
      return;
    }
    setLoading(true);
    setLoadError('');
    setBaselinePointer(null);
    setBaselineHistory([]);
    setBaselineItems([]);
    setBaselineWbs([]);
    try {
      const [pointerResult, baselinesResult, boqResult, wbsResult, activityResult, allocationResult, orderResult, impactResult, wbsLinkResult, activityLinkResult, eventResult] = await Promise.all([
        supabase.from('project_scope_baseline_current').select('*').eq('project_id', project.id).maybeSingle(),
        supabase.from('project_baselines').select('*').eq('project_id', project.id).order('version', { ascending: false }),
        supabase.from('boq_items').select('*').eq('project_id', project.id).order('sort_order', { ascending: true }),
        supabase.from('wbs_nodes').select('*').eq('project_id', project.id).order('sort_order', { ascending: true }),
        supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order', { ascending: true }),
        supabase.from('activity_boq_allocations').select('*').eq('project_id', project.id),
        supabase.from('variation_orders').select('*').eq('project_id', project.id).order('requested_date', { ascending: false }),
        supabase.from('variation_order_boq_impacts').select('*').eq('project_id', project.id),
        supabase.from('variation_order_wbs_links').select('*').eq('project_id', project.id),
        supabase.from('variation_order_activity_links').select('*').eq('project_id', project.id),
        supabase.from('variation_order_events').select('*').eq('project_id', project.id).order('changed_at', { ascending: false }),
      ]);
      const allResults = [pointerResult, baselinesResult, boqResult, wbsResult, activityResult, allocationResult, orderResult, impactResult, wbsLinkResult, activityLinkResult, eventResult];
      const failed = allResults.find((result) => result.error);
      if (failed?.error) throw new Error(failed.error.message || 'Unable to load scope governance records');

      const pointer = (pointerResult.data || null) as { baseline_id: string } | null;
      const revisions = (baselinesResult.data || []) as ProjectBaseline[];
      const activeBaseline = pointer ? revisions.find((revision) => revision.id === pointer.baseline_id) : undefined;
      setBaselinePointer(pointer);
      setBaselineHistory(revisions.filter((revision) => revision.baseline_kind === 'scope' || revision.baseline_kind === 'integrated'));
      setCurrentBoq((boqResult.data || []) as BoqItem[]);
      setCurrentWbs((wbsResult.data || []) as WbsNode[]);
      setActivities((activityResult.data || []) as Activity[]);
      setAllocations((allocationResult.data || []) as ActivityBoqAllocation[]);
      setOrders((orderResult.data || []) as VariationOrder[]);
      setBoqImpacts((impactResult.data || []) as VariationOrderBoqImpact[]);
      setWbsLinks((wbsLinkResult.data || []) as VariationOrderWbsLink[]);
      setActivityLinks((activityLinkResult.data || []) as VariationOrderActivityLink[]);
      setEvents((eventResult.data || []) as VariationOrderEvent[]);

      if (pointer?.baseline_id) {
        if (!activeBaseline || activeBaseline.status !== 'approved' || !['scope', 'integrated'].includes(activeBaseline.baseline_kind || '')) {
          throw new Error('The current scope pointer does not resolve to an approved scope baseline revision.');
        }
        const [baselineBoqResult, baselineWbsResult] = await Promise.all([
          supabase.from('baseline_boq_items').select('*').eq('baseline_id', pointer.baseline_id).order('sort_order', { ascending: true }),
          supabase.from('baseline_wbs_nodes').select('*').eq('baseline_id', pointer.baseline_id).order('sort_order', { ascending: true }),
        ]);
        if (baselineBoqResult.error) throw new Error(baselineBoqResult.error.message);
        if (baselineWbsResult.error) throw new Error(baselineWbsResult.error.message);
        setBaselineItems((baselineBoqResult.data || []) as BaselineBoqItem[]);
        setBaselineWbs((baselineWbsResult.data || []) as BaselineWbsNode[]);
      } else {
        setBaselineItems([]);
        setBaselineWbs([]);
      }
    } catch (error) {
      setLoadError((error as Error).message || 'Unable to load scope governance records');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
    // Loading is project-scoped; keeping the callback local avoids stale project records on switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const currentBaseline = useMemo(
    () => baselinePointer ? baselineHistory.find((revision) => revision.id === baselinePointer.baseline_id) || null : null,
    [baselineHistory, baselinePointer],
  );
  const scopeSummary = useMemo(() => calculateScopeSummary(baselineItems, orders, boqImpacts), [baselineItems, orders, boqImpacts]);
  const pendingOrders = useMemo(() => orders.filter((order) => isPendingVariationOrderStatus(order.status)), [orders]);
  const approvedOrders = useMemo(() => orders.filter((order) => order.status === 'approved'), [orders]);
  const impactByOrder = useMemo(() => {
    const map = new Map<string, VariationOrderBoqImpact[]>();
    for (const impact of boqImpacts) map.set(impact.variation_order_id, [...(map.get(impact.variation_order_id) || []), impact]);
    return map;
  }, [boqImpacts]);
  const wbsById = useMemo(() => new Map(currentWbs.map((node) => [node.id, node])), [currentWbs]);
  const activityById = useMemo(() => new Map(activities.map((activity) => [activity.id, activity])), [activities]);
  const boqById = useMemo(() => new Map(currentBoq.map((item) => [item.id, item])), [currentBoq]);
  const baselineWbsByBoq = useMemo(() => {
    const map = new Map<string, BaselineWbsNode[]>();
    for (const node of baselineWbs) if (node.boq_item_id) map.set(node.boq_item_id, [...(map.get(node.boq_item_id) || []), node]);
    return map;
  }, [baselineWbs]);
  const allocationsByBoq = useMemo(() => {
    const map = new Map<string, ActivityBoqAllocation[]>();
    for (const allocation of allocations) map.set(allocation.boq_item_id, [...(map.get(allocation.boq_item_id) || []), allocation]);
    return map;
  }, [allocations]);
  const wbsLinksByOrder = useMemo(() => {
    const map = new Map<string, VariationOrderWbsLink[]>();
    for (const link of wbsLinks) map.set(link.variation_order_id, [...(map.get(link.variation_order_id) || []), link]);
    return map;
  }, [wbsLinks]);
  const activityLinksByOrder = useMemo(() => {
    const map = new Map<string, VariationOrderActivityLink[]>();
    for (const link of activityLinks) map.set(link.variation_order_id, [...(map.get(link.variation_order_id) || []), link]);
    return map;
  }, [activityLinks]);
  const eventsByOrder = useMemo(() => {
    const map = new Map<string, VariationOrderEvent[]>();
    for (const event of events) map.set(event.variation_order_id, [...(map.get(event.variation_order_id) || []), event]);
    return map;
  }, [events]);

  function openNewDraft(revision?: VariationOrder) {
    const form = emptyDraft(nextVoNumber(orders));
    if (revision) {
      const copiedImpacts = impactByOrder.get(revision.id) || [];
      setDraftForm({
        ...form,
        revisionOfId: revision.id,
        title: revision.title,
        description: revision.description,
        cause: revision.cause,
        source: revision.source,
        sourceReference: revision.source_reference || '',
        requestedBy: revision.requested_by,
        scheduleImpactDays: revision.schedule_impact_days === null ? '' : String(revision.schedule_impact_days),
        scheduleImpactReference: revision.schedule_impact_reference || '',
        notes: revision.notes || '',
        boqImpacts: copiedImpacts.map((impact) => ({
          boqItemId: impact.boq_item_id,
          quantityImpact: impact.quantity_impact === null ? '' : String(impact.quantity_impact),
          valueImpact: impact.value_impact === null ? '' : String(impact.value_impact),
          notes: impact.notes || '',
        })),
        wbsIds: (wbsLinksByOrder.get(revision.id) || []).map((link) => link.wbs_node_id),
        activityIds: (activityLinksByOrder.get(revision.id) || []).map((link) => link.activity_id),
      });
    } else {
      setDraftForm(form);
    }
    setLoadError('');
    setShowDraftModal(true);
  }

  function openEditDraft(order: VariationOrder) {
    const copiedImpacts = impactByOrder.get(order.id) || [];
    setDraftForm({
      id: order.id,
      revisionOfId: order.revision_of_id,
      voNumber: order.vo_number,
      title: order.title,
      description: order.description,
      cause: order.cause,
      source: order.source,
      sourceReference: order.source_reference || '',
      requestedDate: order.requested_date,
      requestedBy: order.requested_by,
      scheduleImpactDays: order.schedule_impact_days === null ? '' : String(order.schedule_impact_days),
      scheduleImpactReference: order.schedule_impact_reference || '',
      notes: order.notes || '',
      boqImpacts: copiedImpacts.map((impact) => ({
        boqItemId: impact.boq_item_id,
        quantityImpact: impact.quantity_impact === null ? '' : String(impact.quantity_impact),
        valueImpact: impact.value_impact === null ? '' : String(impact.value_impact),
        notes: impact.notes || '',
      })),
      wbsIds: (wbsLinksByOrder.get(order.id) || []).map((link) => link.wbs_node_id),
      activityIds: (activityLinksByOrder.get(order.id) || []).map((link) => link.activity_id),
    });
    setLoadError('');
    setShowDraftModal(true);
  }

  async function handleSaveDraft() {
    if (!project?.id) return;
    const unlinkedLineHasData = draftForm.boqImpacts.some((line) => !line.boqItemId && (line.quantityImpact !== '' || line.valueImpact !== '' || line.notes.trim() !== ''));
    const selectedLines = draftForm.boqImpacts.filter((line) => line.boqItemId);
    const parsedLines = selectedLines.map((line) => ({
      boq_item_id: line.boqItemId,
      quantity_impact: parseNullableInput(line.quantityImpact),
      value_impact: parseNullableInput(line.valueImpact),
      notes: line.notes.trim(),
    }));
    if (unlinkedLineHasData || parsedLines.some((line) => Number.isNaN(line.quantity_impact) || Number.isNaN(line.value_impact))) {
      setLoadError(lang === 'ar' ? 'أكمل مرجع بند BOQ وقيم الأثر، أو احذف السطر الفارغ.' : 'Complete each BOQ reference and numeric impact, or remove the empty line.');
      return;
    }
    if (draftForm.scheduleImpactDays.trim() !== '' && !Number.isFinite(Number(draftForm.scheduleImpactDays))) {
      setLoadError(lang === 'ar' ? 'أثر الجدول يجب أن يكون رقماً أو N/A.' : 'Schedule impact must be a finite number or N/A.');
      return;
    }
    setBusy(true);
    setLoadError('');
    try {
      const { data, error } = await supabase.rpc('save_variation_order_draft', {
        p_project_id: project.id,
        p_variation_order_id: draftForm.id,
        p_header: {
          vo_number: draftForm.voNumber.trim(),
          title: draftForm.title.trim(),
          description: draftForm.description.trim(),
          cause: draftForm.cause,
          source: draftForm.source.trim(),
          source_reference: draftForm.sourceReference.trim() || null,
          requested_date: draftForm.requestedDate,
          requested_by: draftForm.requestedBy.trim(),
          schedule_impact_days: draftForm.scheduleImpactDays.trim() === '' ? null : Number(draftForm.scheduleImpactDays),
          schedule_impact_reference: draftForm.scheduleImpactReference.trim() || null,
          notes: draftForm.notes.trim() || null,
          revision_of_id: draftForm.revisionOfId,
        },
        p_boq_impacts: parsedLines,
        p_wbs_ids: draftForm.wbsIds,
        p_activity_ids: draftForm.activityIds,
        p_actor: draftForm.requestedBy.trim(),
      });
      if (error) throw new Error(error.message || 'Unable to save VO draft');
      if (!data) throw new Error('Draft save returned no variation-order id');
      setNotice(lang === 'ar' ? `تم حفظ مسودة ${draftForm.voNumber}.` : `Draft ${draftForm.voNumber} saved.`);
      setShowDraftModal(false);
      await loadData();
    } catch (error) {
      setLoadError((error as Error).message || 'Unable to save VO draft');
    } finally {
      setBusy(false);
    }
  }

  function openTransition(order: VariationOrder, nextStatus: VariationOrderStatus) {
    setTransition({ order, nextStatus });
    setTransitionForm({ actor: '', effectiveDate: '', reference: '', evidenceReference: '', notes: '' });
    setLoadError('');
  }

  async function handleTransition() {
    if (!transition) return;
    setBusy(true);
    setLoadError('');
    try {
      const { error } = await supabase.rpc('transition_variation_order', {
        p_variation_order_id: transition.order.id,
        p_expected_status: transition.order.status,
        p_next_status: transition.nextStatus,
        p_actor: transitionForm.actor.trim(),
        p_effective_date: ['approved', 'rejected', 'withdrawn'].includes(transition.nextStatus) ? transitionForm.effectiveDate || null : null,
        p_reference: transitionForm.reference.trim() || null,
        p_evidence_reference: transitionForm.evidenceReference.trim() || null,
        p_notes: transitionForm.notes.trim() || null,
      });
      if (error) throw new Error(error.message || 'Unable to change VO status');
      setNotice(lang === 'ar' ? `تم تسجيل الحالة ${statusLabel(transition.nextStatus, lang)} مع حفظ سجل التدقيق.` : `Status changed to ${statusLabel(transition.nextStatus, lang)} and audit history recorded.`);
      setTransition(null);
      await loadData();
    } catch (error) {
      setLoadError((error as Error).message || 'Unable to change VO status');
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveScopeBaseline() {
    if (!project?.id) return;
    setBusy(true);
    setLoadError('');
    setNotice('');
    const result = await approveScopeBaseline(supabase, project.id, {
      approvedBy: baselineEvidence.approvedBy,
      approvalReference: baselineEvidence.approvalReference,
      approvedAt: baselineEvidence.approvedAt,
    });
    if (!result.ok) {
      setLoadError(result.error || 'Scope baseline approval failed');
      setBusy(false);
      return;
    }
    setNotice(lang === 'ar' ? `تم اعتماد وحفظ خط أساس النطاق v${result.version}.` : `Approved and snapshotted scope baseline v${result.version}.`);
    setShowBaselineModal(false);
    setBaselineEvidence({ approvedBy: '', approvalReference: '', approvedAt: '' });
    await loadData();
    setBusy(false);
  }

  const isArabic = lang === 'ar';
  const currency = project?.currency || 'SAR';
  const text = (arabic: string, english: string) => isArabic ? arabic : english;
  const formatDate = (value: string | null | undefined) => value || text('غير متاح (N/A)', 'N/A');

  if (!project) {
    return <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">{text('اختر مشروعاً لعرض سجل النطاق والتغييرات.', 'Select a project to view the scope and change register.')}</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-slate-900">
            <ArrowRightLeft size={20} className="text-amber-600" />
            <h2 className="text-lg font-black">{text('خط الأساس والنطاق وسجل الأوامر التغييرية', 'Scope Baseline & Change / VO Governance')}</h2>
          </div>
          <p className="mt-1 max-w-4xl text-xs leading-5 text-slate-500">
            {text(
              'النطاق الأصلي مأخوذ من لقطة BOQ/WBS المعتمدة. النطاق المعدل = الأصل + آثار الأوامر المعتمدة فقط؛ المسودات والتغييرات المعلقة تظهر كتعرض منفصل.',
              'Original scope is read from the approved BOQ/WBS snapshot. Revised approved scope = original + approved VO impacts only; drafts and pending changes remain separate exposure.',
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button disabled={loading || busy} onClick={() => openNewDraft()} className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-xs font-bold text-slate-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50">
            <Plus size={14} /> {text('أمر تغييري جديد', 'New VO')}
          </button>
          <button disabled={loading || busy} onClick={() => { setLoadError(''); setNotice(''); setBaselineEvidence({ approvedBy: '', approvalReference: '', approvedAt: '' }); setShowBaselineModal(true); }} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
            <ShieldCheck size={14} /> {text(currentBaseline ? 'اعتماد إصدار نطاق جديد' : 'اعتماد خط أساس النطاق', currentBaseline ? 'Approve scope revision' : 'Approve scope baseline')}
          </button>
        </div>
      </div>

      {loadError && !showDraftModal && !transition && !showBaselineModal && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800"><AlertCircle size={16} className="mt-0.5 shrink-0" />{loadError}</div>
      )}
      {notice && <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800"><CheckCircle2 size={16} className="mt-0.5 shrink-0" />{notice}</div>}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-black text-slate-900"><FileCheck2 size={16} className="text-emerald-600" />{text('إصدار خط أساس النطاق المعتمد', 'Approved scope baseline revision')}</h3>
            {currentBaseline ? (
              <p className="mt-1 text-[11px] text-slate-500">
                {text('الإصدار الحالي', 'Current revision')} v{currentBaseline.version ?? '—'} · {currentBaseline.approved_at?.slice(0, 10) || text('التاريخ غير متاح', 'date N/A')} · {currentBaseline.approved_by || text('المعتمد غير متاح', 'approver N/A')} · {currentBaseline.approval_reference || text('مرجع الاعتماد غير متاح', 'approval reference N/A')}
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-amber-800">{text('لا يوجد خط أساس نطاق معتمد؛ لا تُعرض قيم الأصل على أنها معتمدة قبل حفظ لقطة ومصدر اعتماد.', 'No approved scope baseline. Source BOQ rows are not presented as approved scope until a referenced approval snapshot is recorded.')}</p>
            )}
          </div>
          <div className="flex gap-2 text-[10px] font-bold">
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">{baselineItems.length} {text('بند BOQ', 'BOQ lines')}</span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">{baselineWbs.length} WBS</span>
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-800">{baselineHistory.length} {text('إصدار محفوظ', 'revision(s) retained')}</span>
          </div>
        </div>
        {baselineHistory.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {baselineHistory.map((revision) => (
              <div key={revision.id} className={`rounded-lg border px-3 py-2 text-[10px] ${revision.id === baselinePointer?.baseline_id ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-slate-50'}`}>
                <span className="font-black">v{revision.version ?? '—'} · {revision.name || text('خط أساس النطاق', 'Scope baseline')}</span>
                <span className="ml-2 text-slate-500">{revision.approved_at?.slice(0, 10) || 'N/A'} · {revision.approval_reference || 'N/A'}</span>
              </div>
            ))}
          </div>
        )}
        {!currentBaseline && !loading && (
          <p className="mt-3 text-[10px] text-slate-500">{text(`المصدر الحالي غير المعتمد: ${currentBoq.length} بند BOQ · ${currentWbs.length} عقدة WBS.`, `Unapproved source rows available to snapshot: ${currentBoq.length} BOQ lines · ${currentWbs.length} WBS nodes.`)}</p>
        )}
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard title={text('النطاق التعاقدي الأصلي', 'Original Contract Scope')} value={currentBaseline ? amountLabel(scopeSummary.originalContractValue, lang, currency) : text('غير متاح (N/A)', 'N/A')} detail={currentBaseline ? `${baselineItems.length} ${text('بند من لقطة الاعتماد', 'baseline BOQ lines')}` : text('يتطلب خط أساس نطاق معتمداً', 'Requires an approved scope baseline')} tone="slate" />
        <MetricCard title={text('التغييرات المعتمدة', 'Approved Changes')} value={currentBaseline ? amountLabel(scopeSummary.approvedChangesValue, lang, currency) : text('غير متاح (N/A)', 'N/A')} detail={`${approvedOrders.length} ${text('أمر معتمد', 'approved VO(s)')} · ${text('أثر البند فقط', 'item-level impacts only')}`} tone="emerald" />
        <MetricCard title={text('النطاق المعتمد المعدل', 'Revised Approved Scope')} value={currentBaseline ? amountLabel(scopeSummary.revisedApprovedScopeValue, lang, currency) : text('غير متاح (N/A)', 'N/A')} detail={text('الأصل + التغييرات المعتمدة فقط', 'Original + approved changes only')} tone="blue" />
        <MetricCard title={text('التعرض المعلق', 'Pending Exposure')} value={currentBaseline ? amountLabel(scopeSummary.pendingExposureValue, lang, currency) : text('غير متاح (N/A)', 'N/A')} detail={`${pendingOrders.length} ${text('مسودة / مقدم / قيد المراجعة', 'draft / submitted / under review')}`} tone="amber" />
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <div>
            <h3 className="text-sm font-black text-slate-900">{text('لقطة بنود النطاق وآثار التغيير', 'Baseline BOQ scope and change impacts')}</h3>
            <p className="mt-0.5 text-[10px] text-slate-500">{text('القيمة الأصلية من لقطة BOQ المعتمدة؛ لا يعاد احتسابها من الكمية × السعر. N/A تعني أثراً غير مقاس، والصفر يعني صفراً مسجلاً صراحة.', 'Original values are copied from the approved BOQ snapshot; no quantity × rate re-calculation. N/A means unmeasured, while zero is an explicitly recorded zero.')}</p>
          </div>
          {loading && <span className="text-[10px] font-bold text-slate-400">{text('جارٍ التحميل…', 'Loading…')}</span>}
        </div>
        {!currentBaseline ? (
          <div className="p-8 text-center text-xs text-slate-500">{text('لا توجد لقطة BOQ معتمدة لهذا المشروع.', 'No approved BOQ scope snapshot exists for this project.')}</div>
        ) : baselineItems.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">{text('الإصدار المعتمد لا يحتوي على بنود BOQ.', 'The approved revision has no BOQ lines.')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[1280px] w-full text-[10px]">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">{text('الكود / الوصف', 'Code / description')}</th>
                  <th className="px-3 py-2 text-right">{text('الكمية الأصلية', 'Original qty')}</th>
                  <th className="px-3 py-2 text-right">{text('أثر الكمية المعتمد', 'Approved qty impact')}</th>
                  <th className="px-3 py-2 text-right">{text('الكمية المعدلة', 'Revised qty')}</th>
                  <th className="px-3 py-2 text-right">{text('سعر الوحدة الأصلي', 'Original unit rate')}</th>
                  <th className="px-3 py-2 text-right">{text('القيمة الأصلية', 'Original value')}</th>
                  <th className="px-3 py-2 text-right">{text('أثر القيمة المعتمد', 'Approved value impact')}</th>
                  <th className="px-3 py-2 text-right">{text('القيمة المعدلة', 'Revised value')}</th>
                  <th className="px-3 py-2 text-right">{text('التعرض المعلق', 'Pending exposure')}</th>
                  <th className="px-3 py-2 text-left">{text('مراجع WBS / الأنشطة', 'WBS / activity references')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {baselineItems.map((item) => {
                  const metrics = getScopeItemMetrics(item, orders, boqImpacts);
                  const itemWbs = baselineWbsByBoq.get(item.source_boq_item_id || '') || [];
                  const itemAllocations = allocationsByBoq.get(item.source_boq_item_id || '') || [];
                  const linkedActivityCodes = [...new Set(itemAllocations.map((allocation) => activityById.get(allocation.activity_id)?.code).filter((code): code is string => Boolean(code)))];
                  const orderReferences = orders.filter((order) => (impactByOrder.get(order.id) || []).some((impact) => impact.boq_item_id === item.source_boq_item_id));
                  return (
                    <tr key={item.id} className="align-top hover:bg-slate-50/70">
                      <td className="px-3 py-2">
                        <div className="font-mono font-black text-slate-800">{item.item_code}</div>
                        <div className="mt-0.5 max-w-[240px] text-slate-500">{item.description}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{numericLabel(item.original_quantity, item.unit, lang)}</td>
                      <td className="px-3 py-2 text-right font-mono">{numericLabel(metrics.approvedQuantityImpact, item.unit, lang)}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold">{numericLabel(metrics.revisedQuantity, item.unit, lang)}</td>
                      <td className="px-3 py-2 text-right font-mono">{amountLabel(item.original_unit_price, lang, currency)}{item.unit ? ` / ${item.unit}` : ''}</td>
                      <td className="px-3 py-2 text-right font-mono">{amountLabel(item.original_value, lang, currency)}</td>
                      <td className="px-3 py-2 text-right font-mono">{amountLabel(metrics.approvedValueImpact, lang, currency)}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-emerald-800">{amountLabel(metrics.revisedValue, lang, currency)}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-amber-800">{amountLabel(metrics.pendingValueExposure, lang, currency)}</td>
                      <td className="px-3 py-2 text-left">
                        <div className="flex max-w-[290px] flex-wrap gap-1">
                          {itemWbs.map((node) => <TraceChip key={node.id} label={node.node_code} tone="violet" />)}
                          {linkedActivityCodes.map((code) => <TraceChip key={code} label={code} tone="blue" />)}
                          {orderReferences.map((order) => <TraceChip key={order.id} label={`${order.vo_number} · ${statusLabel(order.status, lang)}`} tone={order.status === 'approved' ? 'green' : isPendingVariationOrderStatus(order.status) ? 'amber' : 'slate'} />)}
                          {itemWbs.length === 0 && linkedActivityCodes.length === 0 && orderReferences.length === 0 && <span className="text-slate-400">N/A</span>}
                        </div>
                        {linkedActivityCodes.length > 0 && <div className="mt-1 text-[9px] text-slate-400">{text('روابط النشاط مأخوذة من activity_boq_allocations', 'Activity traces read from activity_boq_allocations')}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-black text-slate-900"><FileText size={16} className="text-amber-600" />{text('سجل الأوامر التغييرية', 'Variation order register')}</h3>
            <p className="mt-0.5 text-[10px] text-slate-500">{text('الاعتماد يحتاج تاريخاً ومعتمداً ومرجعاً ودليلاً. الحالات النهائية للقراءة فقط؛ التصحيح ينشئ إصداراً جديداً مرتبطاً بالأصل.', 'Approval requires a date, approver, reference and evidence. Terminal rows are read-only; corrections create a linked revision.')}</p>
          </div>
          <div className="flex flex-wrap gap-1 text-[10px] font-bold">
            <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-800">{pendingOrders.length} {text('معلق', 'pending')}</span>
            <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-800">{approvedOrders.length} {text('معتمد', 'approved')}</span>
            <span className="rounded-full bg-rose-50 px-2 py-1 text-rose-800">{orders.filter((order) => order.status === 'rejected').length} {text('مرفوض', 'rejected')}</span>
            <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">{orders.filter((order) => order.status === 'withdrawn').length} {text('مسحوب', 'withdrawn')}</span>
          </div>
        </div>
        {orders.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">{text('لا توجد أوامر تغيير مسجلة. أضف مسودة؛ لن تغيّر النطاق المعتمد حتى اعتمادها بدليل صريح.', 'No variation orders are registered. Add a draft; it will not change approved scope unless approved with explicit evidence.')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[1320px] w-full text-[10px]">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">{text('رقم / الحالة', 'Number / status')}</th>
                  <th className="px-3 py-2 text-left">{text('التغيير والمصدر', 'Change / source')}</th>
                  <th className="px-3 py-2 text-center">{text('التواريخ', 'Dates')}</th>
                  <th className="px-3 py-2 text-left">{text('مراجع BOQ / WBS / النشاط', 'BOQ / WBS / activity refs')}</th>
                  <th className="px-3 py-2 text-left">{text('اعتماد / رفض / دليل', 'Approval / rejection evidence')}</th>
                  <th className="px-3 py-2 text-left">{text('أثر الجدول ودليله', 'Schedule impact evidence')}</th>
                  <th className="px-3 py-2 text-left">{text('الإجراءات / التدقيق', 'Actions / audit')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {orders.map((order) => {
                  const itemImpacts = impactByOrder.get(order.id) || [];
                  const orderWbs = wbsLinksByOrder.get(order.id) || [];
                  const orderActivities = activityLinksByOrder.get(order.id) || [];
                  const orderEvents = eventsByOrder.get(order.id) || [];
                  const revisedFrom = order.revision_of_id ? orders.find((previous) => previous.id === order.revision_of_id) : null;
                  return (
                    <FragmentRow key={order.id}>
                      <tr className="align-top hover:bg-slate-50/70">
                        <td className="px-3 py-3">
                          <div className="font-mono font-black text-amber-900">{order.vo_number}</div>
                          <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 font-bold ${statusTone(order.status)}`}>{statusLabel(order.status, lang)}</span>
                          {revisedFrom && <div className="mt-1 text-[9px] text-violet-700">{text('تصحيح لـ', 'Revision of')} {revisedFrom.vo_number}</div>}
                          {order.status === 'approved' && <div className="mt-1 flex items-center gap-1 text-[9px] font-bold text-emerald-700"><CheckCircle2 size={11} />{text('الاعتماد بالدليل', 'Evidence-backed')}</div>}
                          {order.status === 'approved' && (!order.approval_reference || !order.approval_evidence_reference) && <div className="mt-1 text-[9px] font-bold text-rose-700">{text('دليل الاعتماد ناقص', 'Evidence incomplete')}</div>}
                        </td>
                        <td className="px-3 py-3">
                          <div className="max-w-[230px] font-bold text-slate-800">{order.title}</div>
                          <div className="mt-0.5 max-w-[230px] text-slate-500">{order.description || '—'}</div>
                          <div className="mt-1 text-slate-600">{causeLabel(order.cause, lang)} · {order.source || text('المصدر غير محدد', 'source N/A')}</div>
                          {order.source_reference && <div className="mt-0.5 break-all text-slate-400">{order.source_reference}</div>}
                          {itemImpacts.length > 0 && (
                            <div className="mt-1 text-slate-500">{itemImpacts.map((impact) => {
                              const item = boqById.get(impact.boq_item_id) || baselineItems.find((candidate) => candidate.source_boq_item_id === impact.boq_item_id);
                              const code = item ? ('code' in item ? item.code : item.item_code) : 'BOQ';
                              return `${code}: ${amountLabel(impact.value_impact, lang, currency)}`;
                            }).join(' · ')}</div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-center font-mono whitespace-nowrap">
                          <div>{text('طلب:', 'Requested:')} {formatDate(order.requested_date)}</div>
                          <div className="text-slate-500">{order.requested_by || 'N/A'}</div>
                          {order.approval_date && <div className="mt-1 text-emerald-700">{text('اعتماد:', 'Approved:')} {order.approval_date}</div>}
                          {order.rejection_date && <div className="mt-1 text-rose-700">{text('رفض:', 'Rejected:')} {order.rejection_date}</div>}
                          {order.withdrawn_date && <div className="mt-1 text-slate-500">{text('سحب:', 'Withdrawn:')} {order.withdrawn_date}</div>}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex max-w-[220px] flex-wrap gap-1">
                            {itemImpacts.map((impact) => {
                              const item = boqById.get(impact.boq_item_id) || baselineItems.find((candidate) => candidate.source_boq_item_id === impact.boq_item_id);
                              const code = item && 'code' in item ? item.code : item?.item_code;
                              return <TraceChip key={impact.id} label={code || 'BOQ'} tone="amber" />;
                            })}
                            {orderWbs.map((link) => {
                              const current = wbsById.get(link.wbs_node_id);
                              const baseline = baselineWbs.find((node) => node.source_wbs_node_id === link.wbs_node_id);
                              return <TraceChip key={link.id} label={current?.code || baseline?.node_code || 'WBS'} tone="violet" />;
                            })}
                            {orderActivities.map((link) => <TraceChip key={link.id} label={activityById.get(link.activity_id)?.code || 'Activity'} tone="blue" />)}
                            {itemImpacts.length === 0 && orderWbs.length === 0 && orderActivities.length === 0 && <span className="text-rose-600">{text('لا توجد مراجع', 'No references')}</span>}
                          </div>
                          <div className="mt-1 text-[9px] text-slate-500">{itemImpacts.length} BOQ · {orderWbs.length} WBS · {orderActivities.length} {text('نشاط', 'activities')}</div>
                        </td>
                        <td className="px-3 py-3">
                          {order.status === 'approved' ? (
                            <div className="space-y-0.5 text-emerald-800">
                              <div>{order.approved_by || 'N/A'} · {order.approval_date || 'N/A'}</div>
                              <div className="break-all">{text('مرجع:', 'Ref:')} {order.approval_reference || 'N/A'}</div>
                              <div className="break-all">{text('دليل:', 'Evidence:')} {order.approval_evidence_reference || 'N/A'}</div>
                            </div>
                          ) : order.status === 'rejected' ? (
                            <div className="space-y-0.5 text-rose-800">
                              <div>{order.rejected_by || 'N/A'} · {order.rejection_date || 'N/A'}</div>
                              <div className="break-all">{order.rejection_reference || 'N/A'}</div>
                              <div>{order.rejection_reason || 'N/A'}</div>
                            </div>
                          ) : order.status === 'withdrawn' ? (
                            <div className="text-slate-500">{order.withdrawn_by || 'N/A'} · {order.withdrawn_date || 'N/A'}<div>{order.withdrawal_reason || 'N/A'}</div></div>
                          ) : <span className="text-amber-700">{text('لم يعتمد — لا يدخل النطاق المعدل', 'Not approved — excluded from revised scope')}</span>}
                        </td>
                        <td className="px-3 py-3">
                          <div>{numericLabel(order.schedule_impact_days, text('يوم', 'd'), lang)}</div>
                          <div className="mt-1 max-w-[180px] break-all text-slate-500">{order.schedule_impact_reference || text('مرجع/دليل غير مسجل', 'reference/evidence N/A')}</div>
                          <div className="mt-1 text-[9px] text-slate-400">{text('دليل فقط؛ لا يحدّث CPM أو TIA/EOT.', 'Evidence only; does not update CPM or TIA/EOT.')}</div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">
                            {order.status === 'draft' && <ActionButton onClick={() => openEditDraft(order)} label={text('تحرير مسودة', 'Edit draft')} icon={<Save size={11} />} />}
                            {order.status === 'draft' && <ActionButton onClick={() => openTransition(order, 'submitted')} label={text('تقديم', 'Submit')} icon={<Check size={11} />} />}
                            {order.status === 'submitted' && <ActionButton onClick={() => openTransition(order, 'under_review')} label={text('بدء المراجعة', 'Review')} icon={<Clock3 size={11} />} />}
                            {(order.status === 'submitted' || order.status === 'under_review') && <ActionButton onClick={() => openTransition(order, 'approved')} label={text('اعتماد', 'Approve')} icon={<CheckCircle2 size={11} />} tone="green" />}
                            {(order.status === 'submitted' || order.status === 'under_review') && <ActionButton onClick={() => openTransition(order, 'rejected')} label={text('رفض', 'Reject')} icon={<XCircle size={11} />} tone="rose" />}
                            {isPendingVariationOrderStatus(order.status) && <ActionButton onClick={() => openTransition(order, 'withdrawn')} label={text('سحب', 'Withdraw')} icon={<X size={11} />} />}
                            {['approved', 'rejected', 'withdrawn'].includes(order.status) && <ActionButton onClick={() => openNewDraft(order)} label={text('إنشاء مراجعة', 'Create revision')} icon={<RotateCcw size={11} />} tone="violet" />}
                            <ActionButton onClick={() => setExpandedHistory(expandedHistory === order.id ? null : order.id)} label={text('السجل', 'History')} icon={<History size={11} />} />
                          </div>
                        </td>
                      </tr>
                      {expandedHistory === order.id && (
                        <tr className="bg-slate-50">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="mb-2 flex items-center gap-2 font-bold text-slate-700"><History size={13} />{text('سجل التدقيق غير القابل للتعديل', 'Append-only audit history')}</div>
                            {orderEvents.length === 0 ? <span className="text-slate-400">N/A</span> : (
                              <div className="grid gap-2 md:grid-cols-2">
                                {orderEvents.map((event) => (
                                  <div key={event.id} className="rounded-lg border border-slate-200 bg-white p-2">
                                    <div className="font-bold text-slate-800">{event.from_status ? `${statusLabel(event.from_status, lang)} → ` : ''}{statusLabel(event.to_status, lang)} · {event.actor}</div>
                                    <div className="text-slate-500">{event.changed_at} {event.reference ? `· ${event.reference}` : ''}</div>
                                    {event.evidence_reference && <div className="break-all text-emerald-700">{event.evidence_reference}</div>}
                                    {event.notes && <div className="text-slate-600">{event.notes}</div>}
                                    {event.details && Object.keys(event.details).length > 0 && (
                                      <details className="mt-1">
                                        <summary className="cursor-pointer text-[9px] font-bold text-blue-700">{text('تفاصيل التغيير المحفوظة', 'Recorded change details')}</summary>
                                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-50 p-2 text-[8px] text-slate-600">{JSON.stringify(event.details, null, 2)}</pre>
                                      </details>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </FragmentRow>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showBaselineModal && (
        <Modal onClose={() => setShowBaselineModal(false)} title={text('اعتماد لقطة BOQ/WBS', 'Approve a BOQ/WBS snapshot')}>
          <p className="text-[11px] leading-5 text-slate-600">{text('سيُنشأ إصدار immutable جديد داخل project_baselines مع مرجع الاعتماد. عند أول اعتماد تُلتقط كميات وقيم BOQ الأصلية؛ الإصدارات اللاحقة تحتفظ بهذا الأساس الأصلي وتلتقط هيكل WBS المعتمد. لا تُعدّل صفوف BOQ أو آثار الأوامر المعتمدة.', 'A new immutable project_baselines revision is created with approval evidence. The first approval snapshots original BOQ quantities/values; later revisions retain that original BOQ basis and capture the approved WBS structure. BOQ source rows and approved VO history are not edited.')}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <LabeledInput label={text('المعتمد', 'Approved by')} value={baselineEvidence.approvedBy} onChange={(value) => setBaselineEvidence({ ...baselineEvidence, approvedBy: value })} />
            <LabeledInput label={text('مرجع / دليل الاعتماد', 'Approval evidence reference')} value={baselineEvidence.approvalReference} onChange={(value) => setBaselineEvidence({ ...baselineEvidence, approvalReference: value })} />
            <label className="space-y-1 text-[11px] font-bold text-slate-700">
              <span>{text('تاريخ الاعتماد', 'Approval date')}</span>
              <input type="date" value={baselineEvidence.approvedAt} onChange={(event) => setBaselineEvidence({ ...baselineEvidence, approvedAt: event.target.value })} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono" />
            </label>
          </div>
          {loadError && <InlineError message={loadError} />}
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <SecondaryButton onClick={() => setShowBaselineModal(false)} label={text('إلغاء', 'Cancel')} />
            <PrimaryButton disabled={busy || !baselineEvidence.approvedBy.trim() || !baselineEvidence.approvalReference.trim() || !baselineEvidence.approvedAt} onClick={handleApproveScopeBaseline} label={text('حفظ واعتماد الإصدار', 'Save & approve revision')} />
          </div>
        </Modal>
      )}

      {showDraftModal && (
        <Modal onClose={() => setShowDraftModal(false)} title={draftForm.id ? text('تحرير مسودة أمر تغييري', 'Edit VO draft') : draftForm.revisionOfId ? text('إنشاء إصدار تصحيحي جديد', 'Create corrective VO revision') : text('تسجيل مسودة أمر تغييري', 'Register VO draft')}>
          <div className="grid gap-3 md:grid-cols-2">
            <LabeledInput label={text('رقم الأمر (فريد للمشروع)', 'VO number (unique per project)')} value={draftForm.voNumber} onChange={(value) => setDraftForm({ ...draftForm, voNumber: value })} />
            <label className="space-y-1 text-[11px] font-bold text-slate-700">
              <span>{text('السبب', 'Cause')}</span>
              <select value={draftForm.cause} onChange={(event) => setDraftForm({ ...draftForm, cause: event.target.value as VoDraftForm['cause'] })} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2">
                {CAUSES.map((cause) => <option key={cause} value={cause}>{causeLabel(cause, lang)}</option>)}
              </select>
            </label>
            <LabeledInput label={text('العنوان', 'Title')} value={draftForm.title} onChange={(value) => setDraftForm({ ...draftForm, title: value })} />
            <LabeledInput label={text('المصدر / الجهة (مطلوب)', 'Source / origin (required)')} value={draftForm.source} onChange={(value) => setDraftForm({ ...draftForm, source: value })} />
            <LabeledInput label={text('مرجع المصدر', 'Source reference')} value={draftForm.sourceReference} onChange={(value) => setDraftForm({ ...draftForm, sourceReference: value })} />
            <LabeledInput label={text('مقدم الطلب', 'Requested by')} value={draftForm.requestedBy} onChange={(value) => setDraftForm({ ...draftForm, requestedBy: value })} />
            <label className="space-y-1 text-[11px] font-bold text-slate-700">
              <span>{text('تاريخ الطلب', 'Requested date')}</span>
              <input type="date" value={draftForm.requestedDate} onChange={(event) => setDraftForm({ ...draftForm, requestedDate: event.target.value })} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono" />
            </label>
            <LabeledInput label={text('أثر المدة بالأيام (فارغ = N/A)', 'Schedule impact days (blank = N/A)')} value={draftForm.scheduleImpactDays} onChange={(value) => setDraftForm({ ...draftForm, scheduleImpactDays: value })} type="number" />
            <LabeledInput label={text('مرجع دليل أثر الجدول', 'Schedule-impact evidence/reference')} value={draftForm.scheduleImpactReference} onChange={(value) => setDraftForm({ ...draftForm, scheduleImpactReference: value })} />
            <label className="space-y-1 text-[11px] font-bold text-slate-700 md:col-span-2">
              <span>{text('الوصف', 'Description')}</span>
              <textarea value={draftForm.description} onChange={(event) => setDraftForm({ ...draftForm, description: event.target.value })} rows={2} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2" />
            </label>

            <div className="space-y-2 rounded-lg border border-slate-200 p-3 md:col-span-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h4 className="text-[11px] font-black text-slate-800">{text('آثار بنود BOQ (الفراغ = N/A، والصفر قيمة مسجلة)', 'BOQ item impacts (blank = N/A; zero is an explicit value)')}</h4>
                  <p className="text-[9px] text-slate-500">{text('تُحفظ كآثار VO فقط ولا تعدّل الكميات/القيم الأصلية أو توزيعات الأنشطة.', 'Stored as VO impacts only; original quantities/values and activity allocations are never edited.')}</p>
                </div>
                <button type="button" onClick={() => setDraftForm({ ...draftForm, boqImpacts: [...draftForm.boqImpacts, { boqItemId: '', quantityImpact: '', valueImpact: '', notes: '' }] })} className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-[10px] font-bold"><Plus size={11} />{text('إضافة بند', 'Add item')}</button>
              </div>
              {draftForm.boqImpacts.length === 0 && <div className="text-[10px] text-slate-400">{text('لا توجد آثار BOQ؛ يمكن ربط WBS أو الأنشطة أدناه.', 'No BOQ lines yet; WBS/activity references can be added below.')}</div>}
              {draftForm.boqImpacts.map((line, index) => (
                <div key={`${index}-${line.boqItemId}`} className="grid items-end gap-2 rounded-lg bg-slate-50 p-2 md:grid-cols-[2fr_1fr_1fr_1.4fr_auto]">
                  <label className="space-y-1 text-[10px] font-bold text-slate-700">
                    <span>{text('بند BOQ', 'BOQ item')}</span>
                    <select value={line.boqItemId} onChange={(event) => updateBoqLine(index, { boqItemId: event.target.value })} className="w-full rounded border border-slate-300 bg-white px-2 py-1.5">
                      <option value="">{text('اختر بنداً', 'Select item')}</option>
                      {currentBoq.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.description}</option>)}
                    </select>
                  </label>
                  <LabeledInput label={text('أثر الكمية', 'Qty impact')} type="number" value={line.quantityImpact} onChange={(value) => updateBoqLine(index, { quantityImpact: value })} compact />
                  <LabeledInput label={text(`أثر القيمة ${currency}`, `Value impact ${currency}`)} type="number" value={line.valueImpact} onChange={(value) => updateBoqLine(index, { valueImpact: value })} compact />
                  <LabeledInput label={text('ملاحظة / دليل', 'Note / evidence')} value={line.notes} onChange={(value) => updateBoqLine(index, { notes: value })} compact />
                  <button type="button" onClick={() => setDraftForm({ ...draftForm, boqImpacts: draftForm.boqImpacts.filter((_, rowIndex) => rowIndex !== index) })} className="rounded border border-rose-200 px-2 py-1.5 text-rose-700"><X size={12} /></button>
                </div>
              ))}
            </div>

            <label className="space-y-1 text-[11px] font-bold text-slate-700">
              <span>{text('مراجع WBS متعددة', 'Multiple WBS references')}</span>
              <select multiple value={draftForm.wbsIds} onChange={(event) => setDraftForm({ ...draftForm, wbsIds: Array.from(event.target.selectedOptions, (option) => option.value) })} className="h-28 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-[10px]">
                {currentWbs.map((node) => <option key={node.id} value={node.id}>{node.code} · {node.name}</option>)}
              </select>
              <span className="block text-[9px] font-normal text-slate-400">{text('استخدم Ctrl/⌘ لتحديد أكثر من مرجع.', 'Use Ctrl/⌘ to select multiple references.')}</span>
            </label>
            <label className="space-y-1 text-[11px] font-bold text-slate-700">
              <span>{text('مراجع أنشطة متعددة', 'Multiple activity references')}</span>
              <select multiple value={draftForm.activityIds} onChange={(event) => setDraftForm({ ...draftForm, activityIds: Array.from(event.target.selectedOptions, (option) => option.value) })} className="h-28 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-[10px]">
                {activities.map((activity) => <option key={activity.id} value={activity.id}>{activity.code} · {activity.name}</option>)}
              </select>
              <span className="block text-[9px] font-normal text-slate-400">{text('المرجع توثيقي فقط في هذه الدفعة؛ لا يغير CPM أو TIA/EOT.', 'References are governance traceability only in this batch; no CPM/TIA/EOT changes.')}</span>
            </label>
            <label className="space-y-1 text-[11px] font-bold text-slate-700 md:col-span-2">
              <span>{text('ملاحظات / مراجع الأدلة', 'Notes / evidence references')}</span>
              <textarea value={draftForm.notes} onChange={(event) => setDraftForm({ ...draftForm, notes: event.target.value })} rows={2} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2" />
            </label>
            {draftForm.revisionOfId && <p className="text-[10px] font-bold text-violet-700 md:col-span-2">{text('هذا إصدار جديد مرتبط بسجل سابق؛ لن يتم تعديل السجل الأصلي.', 'This is a new linked revision; the historical row will not be edited.')}</p>}
          </div>
          {loadError && <InlineError message={loadError} />}
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <SecondaryButton onClick={() => setShowDraftModal(false)} label={text('إغلاق', 'Close')} />
            <PrimaryButton disabled={busy || !draftForm.voNumber.trim() || !draftForm.title.trim() || !draftForm.source.trim() || !draftForm.requestedBy.trim() || !draftForm.requestedDate} onClick={handleSaveDraft} label={text('حفظ كمسودة', 'Save as draft')} />
          </div>
        </Modal>
      )}

      {transition && (
        <Modal onClose={() => setTransition(null)} title={`${text('تغيير الحالة إلى', 'Transition to')} ${statusLabel(transition.nextStatus, lang)}`}>
          <p className="text-[11px] text-slate-600">{text('سيُحفظ انتقال الحالة كسجل تدقيق إضافي. لا يمكن تبديل حالة اعتماد مسجلة.', 'This lifecycle event is appended to the audit history. An approved status cannot be toggled or rewritten.')}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <LabeledInput label={text('المسؤول عن الإجراء', 'Accountable actor')} value={transitionForm.actor} onChange={(value) => setTransitionForm({ ...transitionForm, actor: value })} />
            {['approved', 'rejected', 'withdrawn'].includes(transition.nextStatus) && <label className="space-y-1 text-[11px] font-bold text-slate-700"><span>{text('التاريخ', 'Effective date')}</span><input type="date" value={transitionForm.effectiveDate} onChange={(event) => setTransitionForm({ ...transitionForm, effectiveDate: event.target.value })} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono" /></label>}
            {transition.nextStatus === 'approved' && <>
              <LabeledInput label={text('مرجع الاعتماد (مطلوب)', 'Approval reference (required)')} value={transitionForm.reference} onChange={(value) => setTransitionForm({ ...transitionForm, reference: value })} />
              <LabeledInput label={text('مرجع دليل الاعتماد (مطلوب)', 'Approval evidence reference (required)')} value={transitionForm.evidenceReference} onChange={(value) => setTransitionForm({ ...transitionForm, evidenceReference: value })} />
            </>}
            {transition.nextStatus === 'rejected' && <LabeledInput label={text('مرجع الرفض (اختياري)', 'Rejection reference (optional)')} value={transitionForm.reference} onChange={(value) => setTransitionForm({ ...transitionForm, reference: value })} />}
            {['rejected', 'withdrawn'].includes(transition.nextStatus) && <label className="space-y-1 text-[11px] font-bold text-slate-700 md:col-span-2"><span>{transition.nextStatus === 'rejected' ? text('سبب الرفض (مطلوب)', 'Rejection reason (required)') : text('سبب السحب (مطلوب)', 'Withdrawal reason (required)')}</span><textarea value={transitionForm.notes} onChange={(event) => setTransitionForm({ ...transitionForm, notes: event.target.value })} rows={2} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2" /></label>}
          </div>
          {loadError && <InlineError message={loadError} />}
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <SecondaryButton onClick={() => setTransition(null)} label={text('إلغاء', 'Cancel')} />
            <PrimaryButton disabled={busy || !transitionForm.actor.trim() || (['approved', 'rejected', 'withdrawn'].includes(transition.nextStatus) && !transitionForm.effectiveDate) || (transition.nextStatus === 'approved' && (!transitionForm.reference.trim() || !transitionForm.evidenceReference.trim())) || (['rejected', 'withdrawn'].includes(transition.nextStatus) && !transitionForm.notes.trim())} onClick={handleTransition} label={text('تسجيل الانتقال', 'Record transition')} />
          </div>
        </Modal>
      )}
    </div>
  );

  function updateBoqLine(index: number, patch: Partial<VoBoqImpactDraft>) {
    setDraftForm((current) => ({
      ...current,
      boqImpacts: current.boqImpacts.map((line, rowIndex) => rowIndex === index ? { ...line, ...patch } : line),
    }));
  }
}

function MetricCard({ title, value, detail, tone }: { title: string; value: string; detail: string; tone: 'slate' | 'emerald' | 'blue' | 'amber' }) {
  const tones = {
    slate: 'border-slate-200 bg-white text-slate-900',
    emerald: 'border-emerald-200 bg-emerald-50/60 text-emerald-900',
    blue: 'border-blue-200 bg-blue-50/60 text-blue-900',
    amber: 'border-amber-200 bg-amber-50/60 text-amber-900',
  };
  return <div className={`rounded-xl border p-4 shadow-sm ${tones[tone]}`}><div className="text-[10px] font-bold opacity-65">{title}</div><div className="mt-2 text-lg font-black">{value}</div><div className="mt-1 text-[10px] opacity-70">{detail}</div></div>;
}

function TraceChip({ label, tone }: { label: string; tone: 'amber' | 'violet' | 'blue' | 'green' | 'slate' }) {
  const tones = {
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    violet: 'border-violet-200 bg-violet-50 text-violet-800',
    blue: 'border-blue-200 bg-blue-50 text-blue-800',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    slate: 'border-slate-200 bg-slate-100 text-slate-600',
  };
  return <span className={`rounded border px-1.5 py-0.5 font-mono ${tones[tone]}`}>{label}</span>;
}

function ActionButton({ onClick, label, icon, tone = 'slate' }: { onClick: () => void; label: string; icon: ReactNode; tone?: 'slate' | 'green' | 'rose' | 'violet' }) {
  const tones = {
    slate: 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100',
    rose: 'border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100',
    violet: 'border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100',
  };
  return <button onClick={onClick} className={`inline-flex items-center gap-1 rounded border px-2 py-1 font-bold ${tones[tone]}`}>{icon}{label}</button>;
}

function LabeledInput({ label, value, onChange, type = 'text', compact = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; compact?: boolean }) {
  return <label className={`space-y-1 ${compact ? 'text-[10px]' : 'text-[11px]'} font-bold text-slate-700`}><span>{label}</span><input type={type} step={type === 'number' ? 'any' : undefined} value={value} onChange={(event) => onChange(event.target.value)} className={`w-full rounded-lg border border-slate-300 bg-white ${compact ? 'px-2 py-1.5' : 'px-3 py-2'}`} /></label>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-3 backdrop-blur-sm"><div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl"><div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-100 pb-3"><h3 className="text-sm font-black text-slate-900">{title}</h3><button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><X size={16} /></button></div><div className="space-y-4">{children}</div></div></div>;
}

function InlineError({ message }: { message: string }) {
  return <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-[10px] text-rose-800"><AlertCircle size={13} className="mt-0.5 shrink-0" />{message}</div>;
}

function PrimaryButton({ disabled, onClick, label }: { disabled: boolean; onClick: () => void; label: string }) {
  return <button disabled={disabled} onClick={onClick} className="rounded-lg bg-amber-500 px-4 py-2 text-[11px] font-black text-slate-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50">{label}</button>;
}

function SecondaryButton({ onClick, label }: { onClick: () => void; label: string }) {
  return <button onClick={onClick} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-[11px] font-bold text-slate-700 hover:bg-slate-50">{label}</button>;
}

function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

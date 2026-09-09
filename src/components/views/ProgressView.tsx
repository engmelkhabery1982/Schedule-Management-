import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import type { Project, Activity, ProgressUpdate, InspectionRequest, BoqItem, ActivityLink, SubcontractPackage } from '@/types';
import { calculateEarnedSchedule } from '@/lib/earnedScheduleEngine';
import {
  getSubcontractPackages,
  saveSubcontractPackages,
  calculateSubcontractorLedger,
  type SubcontractorPerformanceSummary,
} from '@/lib/subcontractEngine';
import {
  TrendingUp,
  Save,
  Calendar,
  CheckCircle,
  Clock,
  AlertTriangle,
  Layers,
  ChevronRight,
  ShieldCheck,
  Award,
  Zap,
  DollarSign,
  Plus,
  FileCheck2,
  ListPlus,
  Sparkles,
  History,
  Check,
  Briefcase,
  Users,
  Building2,
  Receipt,
  ArrowRightLeft,
  FileSpreadsheet,
  Percent,
  Printer,
  X,
  Shield,
  HelpCircle,
  Download,
} from 'lucide-react';

interface ProgressViewProps {
  project: Project | null;
}

type TabType =
  | 'daily_entry_sheet'
  | 'single_activity_log'
  | 'subcontractors_ledger'
  | 'physical_s_curves'
  | 'earned_schedule'
  | 'inspections'
  | 'cutoff_wizard';

export default function ProgressView({ project }: ProgressViewProps) {
  const [activeTab, setActiveTab] = useState<TabType>('daily_entry_sheet');
  const [activities, setActivities] = useState<Activity[]>([]);
  const [updates, setUpdates] = useState<ProgressUpdate[]>([]);
  const [inspections, setInspections] = useState<InspectionRequest[]>([]);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  // Subcontract Packages & Ledger State
  const [subcontracts, setSubcontracts] = useState<SubcontractPackage[]>(() =>
    getSubcontractPackages(project?.id)
  );
  const [selectedSubcontractorFilter, setSelectedSubcontractorFilter] = useState<string>('all');
  const [certModalData, setCertModalData] = useState<SubcontractorPerformanceSummary | null>(null);

  // Daily Entry Date
  const [entryDate, setEntryDate] = useState<string>(
    new Date().toISOString().split('T')[0]
  );

  // Multi-activity daily input state: map activityId -> daily quantity entered today
  const [dailyInputs, setDailyInputs] = useState<Record<string, number>>({});
  const [dailyNotes, setDailyNotes] = useState<Record<string, string>>({});
  // Map activityId -> { executorType: 'self_direct' | 'subcontractor', subcontractorId?: string }
  const [dailyExecutors, setDailyExecutors] = useState<
    Record<string, { executorType: 'self_direct' | 'subcontractor'; subcontractorId?: string }>
  >({});

  // Single Activity Form State
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [singleTodayQty, setSingleTodayQty] = useState<number>(0);
  const [singleNotes, setSingleNotes] = useState<string>('');
  const [singleExecutorType, setSingleExecutorType] = useState<'self_direct' | 'subcontractor'>('self_direct');
  const [singleSubcontractorId, setSingleSubcontractorId] = useState<string>('SUB-PKG-01');

  // Inspection Form State
  const [inspectionForm, setInspectionForm] = useState({
    activity_id: '',
    boq_item_id: '',
    request_number: 'WIR-CIV-006',
    inspection_date: new Date().toISOString().split('T')[0],
    quantity: 0,
    parent_reference: '',
    notes: '',
    executor_type: 'subcontractor' as 'self_direct' | 'subcontractor',
    subcontractor_id: 'SUB-PKG-01',
    zone_or_scope: 'القطاع A - الدور الأول',
  });

  // Archive & Historical Audit Filter States
  const [searchWir, setSearchWir] = useState('');
  const [statusFilterWir, setStatusFilterWir] = useState<'all' | 'approved' | 'submitted' | 'rejected'>('all');
  const [searchHistory, setSearchHistory] = useState('');

  // Cutoff Wizard States
  const [cutoffDate, setCutoffDate] = useState('2026-11-30');
  const [revisionName, setRevisionName] = useState('Rev 01 - تحديث شهر نوفمبر 2026');
  const [outOfSequenceMode, setOutOfSequenceMode] = useState<'retained_logic' | 'progress_override'>('retained_logic');
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [cutoffProcessing, setCutoffProcessing] = useState(false);

  useEffect(() => {
    if (project) loadData();
    else setLoading(false);
  }, [project]);

  useEffect(() => {
    if (subcontracts && subcontracts.length > 0) {
      saveSubcontractPackages(subcontracts, project?.id);
    }
  }, [subcontracts, project?.id]);

  async function loadData() {
    if (!project) return;
    setLoading(true);
    const [actRes, updRes, inspectionRes, boqRes, linksRes] = await Promise.all([
      supabase.from('activities').select('*').eq('project_id', project.id).order('sort_order', { ascending: true }),
      supabase.from('progress_updates').select('*').eq('project_id', project.id).order('update_date', { ascending: false }),
      supabase.from('inspection_requests').select('*').eq('project_id', project.id).order('inspection_date', { ascending: false }),
      supabase.from('boq_items').select('*').eq('project_id', project.id).order('sort_order', { ascending: true }),
      supabase.from('activity_links').select('*').eq('project_id', project.id),
    ]);
    
    const actList = (actRes.data || []) as Activity[];
    const linksList = (linksRes.data || []) as ActivityLink[];

    const hydratedActivities = actList.map((a) => {
      const preds = linksList.filter((l) => l.successor_id === a.id);
      return { ...a, predecessors: preds };
    });

    setActivities(hydratedActivities);
    setUpdates(updRes.data || []);
    setInspections((inspectionRes.data || []) as InspectionRequest[]);
    setBoqItems((boqRes.data || []) as BoqItem[]);
    setLoading(false);
  }

  // Get Unit Rate for an Activity from BOQ or proportional contract BAC (Client Selling Rate)
  const getActivityUnitRate = (act: Activity): number => {
    const plannedQty = Math.max(1, act.planned_quantity || 1);
    const boq = boqItems.find((b) => b.code === act.code || b.description.includes(act.name) || act.name.includes(b.description));
    if (boq && boq.unit_price > 0) {
      return boq.unit_price;
    }
    const defaultBac = project ? project.contract_value / Math.max(1, activities.length) : 50000;
    return Math.round(defaultBac / plannedQty);
  };

  // Get Subcontractor Unit Rate for an Activity if executed by subcontractor
  const getSubcontractorRateForActivity = (act: Activity, subId: string): { subRate: number; subPkgName: string } => {
    const pkg = subcontracts.find((s) => s.id === subId);
    if (!pkg) return { subRate: Math.round(getActivityUnitRate(act) * 0.7), subPkgName: 'مقاول باطن' };

    const item = pkg.items.find((i) => i.linkedActivityCode === act.code || i.boqCode === act.code || i.description.includes(act.name));
    if (item && item.subcontractRateSar > 0) {
      return { subRate: item.subcontractRateSar, subPkgName: pkg.subcontractorName };
    }
    // Default estimated subcontract cost is ~70% of client unit price
    return { subRate: Math.round(getActivityUnitRate(act) * 0.7), subPkgName: pkg.subcontractorName };
  };

  // Subcontractor Ledger & Real-time EVM
  const subcontractorLedger = useMemo(() => {
    return calculateSubcontractorLedger(subcontracts, activities, boqItems);
  }, [subcontracts, activities, boqItems]);

  // Earned Schedule Calculation
  const earnedScheduleData = useMemo(() => {
    return calculateEarnedSchedule(project, activities, 0.96);
  }, [project, activities]);

  // Overall Financial & Physical Totals
  const overallMetrics = useMemo(() => {
    let totalBac = project?.contract_value || 0;
    let totalEarnedValue = 0;
    let totalWeightProgress = 0;

    activities.forEach((act) => {
      const unitRate = getActivityUnitRate(act);
      const actPlannedQty = act.planned_quantity || 1;
      const actBac = unitRate * actPlannedQty;
      const pct = (act.percent_complete || 0) / 100;
      totalEarnedValue += actBac * pct;
    });

    if (activities.length > 0) {
      totalWeightProgress = activities.reduce((s, a) => s + (a.percent_complete || 0), 0) / activities.length;
    }

    return {
      totalBac: totalBac > 0 ? totalBac : activities.reduce((s, a) => s + getActivityUnitRate(a) * (a.planned_quantity || 1), 0),
      totalEarnedValue: Math.round(totalEarnedValue),
      overallProgress: Number(totalWeightProgress.toFixed(1)),
    };
  }, [activities, project, boqItems]);

  // Filtered Inspections for Archive & Historical Audit
  const filteredInspections = useMemo(() => {
    return inspections.filter((req) => {
      const act = activities.find((a) => a.id === req.activity_id);
      const matchesSearch =
        !searchWir ||
        req.request_number.toLowerCase().includes(searchWir.toLowerCase()) ||
        (req.subcontractor_name && req.subcontractor_name.toLowerCase().includes(searchWir.toLowerCase())) ||
        (act && (act.code.toLowerCase().includes(searchWir.toLowerCase()) || act.name.toLowerCase().includes(searchWir.toLowerCase()))) ||
        (req.notes && req.notes.toLowerCase().includes(searchWir.toLowerCase()));
      const matchesStatus = statusFilterWir === 'all' || req.status === statusFilterWir;
      return matchesSearch && matchesStatus;
    });
  }, [inspections, searchWir, statusFilterWir, activities]);

  // Filtered Daily Updates for Archive & Historical Audit
  const filteredUpdates = useMemo(() => {
    return updates.filter((u) => {
      const act = activities.find((a) => a.id === u.activity_id);
      const matchesSearch =
        !searchHistory ||
        u.update_date.includes(searchHistory) ||
        (u.subcontractor_name && u.subcontractor_name.toLowerCase().includes(searchHistory.toLowerCase())) ||
        (act && (act.code.toLowerCase().includes(searchHistory.toLowerCase()) || act.name.toLowerCase().includes(searchHistory.toLowerCase()))) ||
        (u.notes && u.notes.toLowerCase().includes(searchHistory.toLowerCase()));
      return matchesSearch;
    });
  }, [updates, searchHistory, activities]);

  function exportWirCsv() {
    const headers = ['رقم الطلب', 'التاريخ', 'كود النشاط', 'اسم النشاط', 'جهة التنفيذ', 'اسم المقاول', 'الكمية', 'سعر المالك', 'إيراد المالك EV', 'سعر الباطن', 'تكلفة الباطن AC', 'هامش الربح', 'الحالة'];
    const rows = filteredInspections.map((req) => {
      const act = activities.find((a) => a.id === req.activity_id);
      const isSub = req.executor_type === 'subcontractor' || !!req.subcontractor_name;
      const clientEV = req.client_earned_value || (act ? Math.round(req.inspected_quantity * getActivityUnitRate(act)) : 0);
      const subCost = req.subcontractor_cost || (isSub ? Math.round(clientEV * 0.7) : 0);
      const margin = req.profit_margin_sar !== undefined ? req.profit_margin_sar : (clientEV - subCost);
      return [
        req.request_number,
        req.inspection_date,
        act?.code || '',
        act?.name || '',
        isSub ? 'مقاول باطن' : 'تنفيذ ذاتي',
        req.subcontractor_name || '',
        req.inspected_quantity,
        req.client_unit_rate || (act ? getActivityUnitRate(act) : 0),
        clientEV,
        req.subcontract_unit_rate || 0,
        subCost,
        margin,
        req.status,
      ];
    });
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.map((f) => `"${f}"`).join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Inspection_Requests_Archive_${project?.id || 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportHistoryCsv() {
    const headers = ['التاريخ', 'كود النشاط', 'اسم النشاط', 'جهة التنفيذ', 'المقاول', 'الكمية المنفذة', 'التراكمي', 'نسبة الإنجاز %', 'إيراد المالك EV', 'تكلفة الباطن AC', 'هامش الربح', 'ملاحظات'];
    const rows = filteredUpdates.map((u) => {
      const act = activities.find((a) => a.id === u.activity_id);
      const isSub = u.executor_type === 'subcontractor' || !!u.subcontractor_name;
      const clientEV = u.client_earned_value || (act ? Math.round((u.actual_quantity || 0) * getActivityUnitRate(act)) : 0);
      const subCost = u.subcontractor_cost || (isSub ? Math.round(clientEV * 0.7) : 0);
      const margin = u.profit_margin_sar !== undefined ? u.profit_margin_sar : (clientEV - subCost);
      return [
        u.update_date,
        act?.code || '',
        act?.name || '',
        isSub ? 'مقاول باطن' : 'تنفيذ ذاتي',
        u.subcontractor_name || '',
        u.actual_quantity,
        u.quantity_to_date,
        u.percent_complete,
        clientEV,
        subCost,
        margin,
        u.notes || '',
      ];
    });
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.map((f) => `"${f}"`).join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Daily_Production_History_Archive_${project?.id || 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Handle saving single activity daily progress
  async function handleSaveSingleDailyEntry() {
    if (!project || !selectedActivityId || singleTodayQty <= 0) {
      setMessage('يرجى اختيار النشاط وإدخال كمية إنجاز اليوم.');
      return;
    }
    setSaving(true);
    const act = activities.find((a) => a.id === selectedActivityId);
    if (!act) {
      setSaving(false);
      return;
    }

    const prevQty = act.actual_quantity || 0;
    const newCumulativeQty = prevQty + Number(singleTodayQty);
    const plannedQty = Math.max(1, act.planned_quantity || 1);
    const newPercent = Math.min(100, Number(((newCumulativeQty / plannedQty) * 100).toFixed(1)));
    const remainingDuration = Math.max(0, Math.round(act.duration_days * (1 - newPercent / 100)));

    const actualStart = act.actual_start || entryDate;
    const actualFinish = newPercent >= 100 ? (act.actual_finish || entryDate) : null;

    const clientUnitRate = getActivityUnitRate(act);
    const clientEarnedVal = Math.round(singleTodayQty * clientUnitRate);

    let subRate = clientUnitRate;
    let subCost = 0;
    let profitMargin = clientEarnedVal;
    let subName = '';
    let retention = 0;

    if (singleExecutorType === 'subcontractor') {
      const subInfo = getSubcontractorRateForActivity(act, singleSubcontractorId);
      subRate = subInfo.subRate;
      subName = subInfo.subPkgName;
      subCost = Math.round(singleTodayQty * subRate);
      profitMargin = clientEarnedVal - subCost;
      retention = Math.round(subCost * 0.1);
    }

    try {
      // 1. Log the daily update record
      await supabase.from('progress_updates').insert({
        project_id: project.id,
        activity_id: act.id,
        update_date: entryDate,
        percent_complete: newPercent,
        actual_quantity: Number(singleTodayQty),
        quantity_to_date: newCumulativeQty,
        notes: singleNotes || (singleExecutorType === 'subcontractor'
          ? `إنجاز باطن: +${singleTodayQty} ${act.unit || 'وحدة'} بواسطة [${subName}]`
          : `إنجاز ذاتي: +${singleTodayQty} ${act.unit || 'وحدة'}`),
        status: 'approved',
        executor_type: singleExecutorType,
        subcontractor_id: singleExecutorType === 'subcontractor' ? singleSubcontractorId : null,
        subcontractor_name: singleExecutorType === 'subcontractor' ? subName : null,
        subcontract_unit_rate: singleExecutorType === 'subcontractor' ? subRate : undefined,
        client_unit_rate: clientUnitRate,
        subcontractor_cost: subCost,
        client_earned_value: clientEarnedVal,
        profit_margin_sar: profitMargin,
        retention_deducted: retention,
      });

      // 2. Update the activity record with cumulative progress
      await supabase.from('activities').update({
        actual_quantity: newCumulativeQty,
        percent_complete: newPercent,
        remaining_duration_days: remainingDuration,
        actual_start: actualStart,
        actual_finish: actualFinish,
      }).eq('id', act.id);

      const execLabel = singleExecutorType === 'subcontractor'
        ? `بواسطة مقاول الباطن (${subName}) | تكلفة الباطن: ${subCost.toLocaleString()} ر.س | إيراد المالك: ${clientEarnedVal.toLocaleString()} ر.س (ربح: +${profitMargin.toLocaleString()} ر.س)`
        : `تنفيذ ذاتي (المقاول الرئيسي) بقيمة مكتسبة ${clientEarnedVal.toLocaleString()} ر.س`;

      setMessage(`تم تسجيل منجز اليوم (+${singleTodayQty} ${act.unit || 'وحدة'}) للنشاط [${act.code}] - ${execLabel}`);
      setSingleTodayQty(0);
      setSingleNotes('');
      await loadData();
    } catch (err: any) {
      setMessage(`خطأ أثناء الحفظ: ${err?.message || 'خطأ غير معروف'}`);
    } finally {
      setSaving(false);
    }
  }

  // Handle Bulk Daily Entry Sheet Save
  async function handleSaveBatchDailySheet() {
    if (!project) return;
    const activeEntries = Object.entries(dailyInputs).filter(([_, qty]) => Number(qty) > 0);
    if (activeEntries.length === 0) {
      setMessage('لم تقم بإدخال كميات لأي نشاط في يومية اليوم.');
      return;
    }

    setSaving(true);
    try {
      let savedCount = 0;
      let totalEarnedToday = 0;
      let totalSubCostToday = 0;

      for (const [actId, todayQtyNum] of activeEntries) {
        const qty = Number(todayQtyNum);
        if (qty <= 0) continue;

        const act = activities.find((a) => a.id === actId);
        if (!act) continue;

        const prevQty = act.actual_quantity || 0;
        const newCumulativeQty = prevQty + qty;
        const plannedQty = Math.max(1, act.planned_quantity || 1);
        const newPercent = Math.min(100, Number(((newCumulativeQty / plannedQty) * 100).toFixed(1)));
        const remainingDuration = Math.max(0, Math.round(act.duration_days * (1 - newPercent / 100)));
        const clientUnitRate = getActivityUnitRate(act);
        const clientEarnedToday = Math.round(qty * clientUnitRate);
        totalEarnedToday += clientEarnedToday;

        const execInfo = dailyExecutors[actId] || { executorType: 'self_direct' };
        let subRate = clientUnitRate;
        let subCost = 0;
        let profitMargin = clientEarnedToday;
        let subName = '';
        let retention = 0;

        if (execInfo.executorType === 'subcontractor') {
          const subDetails = getSubcontractorRateForActivity(act, execInfo.subcontractorId || 'SUB-PKG-01');
          subRate = subDetails.subRate;
          subName = subDetails.subPkgName;
          subCost = Math.round(qty * subRate);
          profitMargin = clientEarnedToday - subCost;
          retention = Math.round(subCost * 0.1);
          totalSubCostToday += subCost;
        }

        const actualStart = act.actual_start || entryDate;
        const actualFinish = newPercent >= 100 ? (act.actual_finish || entryDate) : null;
        const defaultNote = execInfo.executorType === 'subcontractor'
          ? `إدخال يومي ${entryDate}: +${qty} ${act.unit || 'وحدة'} (مقاول باطن: ${subName})`
          : `إدخال يومي ${entryDate}: +${qty} ${act.unit || 'وحدة'} (تنفيذ ذاتي)`;
        const note = dailyNotes[actId] || defaultNote;

        // Insert log
        await supabase.from('progress_updates').insert({
          project_id: project.id,
          activity_id: act.id,
          update_date: entryDate,
          percent_complete: newPercent,
          actual_quantity: qty,
          quantity_to_date: newCumulativeQty,
          notes: note,
          status: 'approved',
          executor_type: execInfo.executorType,
          subcontractor_id: execInfo.executorType === 'subcontractor' ? execInfo.subcontractorId : null,
          subcontractor_name: execInfo.executorType === 'subcontractor' ? subName : null,
          subcontract_unit_rate: execInfo.executorType === 'subcontractor' ? subRate : undefined,
          client_unit_rate: clientUnitRate,
          subcontractor_cost: subCost,
          client_earned_value: clientEarnedToday,
          profit_margin_sar: profitMargin,
          retention_deducted: retention,
        });

        // Update activity
        await supabase.from('activities').update({
          actual_quantity: newCumulativeQty,
          percent_complete: newPercent,
          remaining_duration_days: remainingDuration,
          actual_start: actualStart,
          actual_finish: actualFinish,
        }).eq('id', act.id);

        savedCount++;
      }

      setMessage(
        `تم اعتماد اليومية لـ (${savedCount}) أنشطة | إيراد المالك المكتسب: ${totalEarnedToday.toLocaleString()} ر.س | تكلفة مقاولي الباطن: ${totalSubCostToday.toLocaleString()} ر.س | صافي الهامش: +${(totalEarnedToday - totalSubCostToday).toLocaleString()} ر.س`
      );
      setDailyInputs({});
      setDailyNotes({});
      await loadData();
    } catch (err: any) {
      setMessage(`خطأ أثناء حفظ اليومية: ${err?.message || 'خطأ غير معروف'}`);
    } finally {
      setSaving(false);
    }
  }

  // Inspection submission & review with automatic CPM & EVM & Subcontractor propagation
  async function submitInspection() {
    if (!project || !inspectionForm.activity_id || !inspectionForm.request_number || inspectionForm.quantity <= 0) {
      setMessage('أدخل رقم طلب الفحص والنشاط والكمية قبل الإرسال.');
      return;
    }

    const act = activities.find((a) => a.id === inspectionForm.activity_id);
    const clientUnitRate = act ? getActivityUnitRate(act) : 100;
    const clientEV = Math.round(inspectionForm.quantity * clientUnitRate);

    let subRate = clientUnitRate;
    let subCost = 0;
    let profitMargin = clientEV;
    let subName = '';

    if (inspectionForm.executor_type === 'subcontractor' && act) {
      const subInfo = getSubcontractorRateForActivity(act, inspectionForm.subcontractor_id);
      subRate = subInfo.subRate;
      subName = subInfo.subPkgName;
      subCost = Math.round(inspectionForm.quantity * subRate);
      profitMargin = clientEV - subCost;
    }

    const { error } = await supabase.from('inspection_requests').insert({
      project_id: project.id,
      request_number: inspectionForm.request_number,
      activity_id: inspectionForm.activity_id,
      boq_item_id: inspectionForm.boq_item_id || act?.code || null,
      inspection_date: inspectionForm.inspection_date,
      inspected_quantity: inspectionForm.quantity,
      approved_quantity: 0,
      parent_reference: inspectionForm.parent_reference || null,
      notes: inspectionForm.notes || null,
      status: 'submitted',
      executor_type: inspectionForm.executor_type,
      subcontractor_id: inspectionForm.executor_type === 'subcontractor' ? inspectionForm.subcontractor_id : null,
      subcontractor_name: inspectionForm.executor_type === 'subcontractor' ? subName : null,
      zone_or_scope: inspectionForm.zone_or_scope || null,
      subcontract_unit_rate: inspectionForm.executor_type === 'subcontractor' ? subRate : undefined,
      client_unit_rate: clientUnitRate,
      subcontractor_cost: subCost,
      client_earned_value: clientEV,
      profit_margin_sar: profitMargin,
    });

    if (error) {
      setMessage(`تعذر إرسال طلب الفحص: ${error.message}`);
      return;
    }

    setInspectionForm({
      activity_id: '',
      boq_item_id: '',
      request_number: `WIR-CIV-00${inspections.length + 2}`,
      inspection_date: new Date().toISOString().split('T')[0],
      quantity: 0,
      parent_reference: '',
      notes: '',
      executor_type: 'subcontractor',
      subcontractor_id: 'SUB-PKG-01',
      zone_or_scope: 'القطاع A',
    });
    setMessage(`تم تقديم طلب الفحص [${inspectionForm.request_number}] بنجاح وهو الآن بانتظار استلام واعتماد الاستشاري المشرف.`);
    await loadData();
  }

  async function reviewInspection(id: string, status: 'approved' | 'rejected') {
    if (!project) return;
    const req = inspections.find((i) => i.id === id);
    if (!req) return;

    if (status === 'rejected') {
      await supabase.from('inspection_requests').update({
        status: 'rejected',
        approved_by: 'Resident Engineer / الاستشاري المشرف',
        rejected_reason: 'عدم مطابقة مناسيب أو تقارير فحص الجودة الموقعية.',
      }).eq('id', id);
      setMessage(`تم رفض طلب الفحص [${req.request_number}] وإخطار المقاول بالملاحظات.`);
      await loadData();
      return;
    }

    // Status is 'approved' -> Run full seamless propagation!
    const act = activities.find((a) => a.id === req.activity_id);
    if (!act) return;

    const qty = req.inspected_quantity || 1;
    const prevQty = act.actual_quantity || 0;
    const newCumulativeQty = prevQty + qty;
    const plannedQty = Math.max(1, act.planned_quantity || 1);
    const newPercent = Math.min(100, Number(((newCumulativeQty / plannedQty) * 100).toFixed(1)));
    const remainingDuration = Math.max(0, Math.round(act.duration_days * (1 - newPercent / 100)));
    const clientUnitRate = req.client_unit_rate || getActivityUnitRate(act);
    const clientEarnedVal = Math.round(qty * clientUnitRate);

    const isSub = req.executor_type === 'subcontractor' || !!req.subcontractor_name;
    const subRate = req.subcontract_unit_rate || (isSub ? Math.round(clientUnitRate * 0.7) : clientUnitRate);
    const subCost = req.subcontractor_cost || (isSub ? Math.round(qty * subRate) : 0);
    const profitMargin = clientEarnedVal - subCost;
    const retention = Math.round(subCost * 0.1);
    const subName = req.subcontractor_name || (isSub ? 'شركة البنيان لأعمال الخرسانات والهياكل' : '');

    try {
      // 1. Update inspection request record
      await supabase.from('inspection_requests').update({
        status: 'approved',
        approved_quantity: qty,
        approved_at: new Date().toISOString(),
        approved_by: 'Resident Engineer / المهندس الاستشاري المشرف',
      }).eq('id', id);

      // 2. Update activity in CPM schedule
      await supabase.from('activities').update({
        actual_quantity: newCumulativeQty,
        percent_complete: newPercent,
        remaining_duration_days: remainingDuration,
        actual_start: act.actual_start || req.inspection_date,
        actual_finish: newPercent >= 100 ? req.inspection_date : null,
      }).eq('id', act.id);

      // 3. Log progress update record
      await supabase.from('progress_updates').insert({
        project_id: project.id,
        activity_id: act.id,
        update_date: req.inspection_date,
        percent_complete: newPercent,
        actual_quantity: qty,
        quantity_to_date: newCumulativeQty,
        notes: `إنجاز معتمد بموجب طلب فحص واستلام استشاري [${req.request_number}] (${isSub ? `مقاول باطن: ${subName}` : 'تنفيذ ذاتي'})`,
        status: 'approved',
        approved_at: new Date().toISOString(),
        executor_type: req.executor_type || (isSub ? 'subcontractor' : 'self_direct'),
        subcontractor_id: req.subcontractor_id,
        subcontractor_name: subName || null,
        zone_or_scope: req.zone_or_scope || null,
        subcontract_unit_rate: isSub ? subRate : undefined,
        client_unit_rate: clientUnitRate,
        subcontractor_cost: subCost,
        client_earned_value: clientEarnedVal,
        profit_margin_sar: profitMargin,
        retention_deducted: retention,
      });

      // 4. If Subcontractor: Update subcontract package executedQuantity & log cost transaction
      if (isSub) {
        // Update subcontracts state & localStorage
        const updatedSubs = subcontracts.map((pkg) => {
          if (pkg.id === req.subcontractor_id || pkg.subcontractorName === subName) {
            const updatedItems = pkg.items.map((itm) => {
              if (itm.linkedActivityCode === act.code || itm.boqCode === act.code || itm.description.includes(act.name)) {
                return { ...itm, executedQuantity: (itm.executedQuantity || 0) + qty };
              }
              return itm;
            });
            return { ...pkg, items: updatedItems };
          }
          return pkg;
        });
        setSubcontracts(updatedSubs);
        saveSubcontractPackages(updatedSubs, project.id);

        // Insert formal cost transaction
        await supabase.from('cost_transactions').insert({
          project_id: project.id,
          activity_id: act.id,
          boq_item_id: req.boq_item_id || null,
          category: 'Subcontractors',
          transaction_date: req.inspection_date,
          description: `استحقاق باطن معتمد بموجب طلب فحص [${req.request_number}] - ${subName}`,
          cost_type: 'direct',
          amount: subCost,
          source: 'invoice',
          status: 'approved',
          approved_at: new Date().toISOString(),
          invoice_number: `IPC-${req.request_number}`,
          vendor: subName,
        });
      }

      const summaryText = isSub
        ? `تم اعتماد طلب الفحص [${req.request_number}] بنجاح! تم تحويل (+${qty} ${act.unit || 'وحدة'}) إلى إنجاز فعلي للنشاط (${newPercent}%)، وتسجيل إيراد مكتسب للمالك قدره ${clientEarnedVal.toLocaleString()} ر.س، واستحقاق لمقاول الباطن (${subName}) قدره ${subCost.toLocaleString()} ر.س بربح محقق +${profitMargin.toLocaleString()} ر.س، وترحيل التكلفة إلى الميزانية!`
        : `تم اعتماد طلب الفحص [${req.request_number}] بنجاح! تم تحويل (+${qty} ${act.unit || 'وحدة'}) إلى إنجاز فعلي للنشاط (${newPercent}%) بقيمة مكتسبة ${clientEarnedVal.toLocaleString()} ر.س.`;

      setMessage(summaryText);
      await loadData();
    } catch (err: any) {
      setMessage(`خطأ أثناء ترحيل واعتماد طلب الفحص: ${err?.message || 'خطأ غير معروف'}`);
    }
  }

  // Monthly Cut-off Execution
  async function executeMonthlyCutoff() {
    if (!project) return;
    setCutoffProcessing(true);
    try {
      await supabase.from('projects').update({
        data_date: cutoffDate,
        status_logic: outOfSequenceMode,
      }).eq('id', project.id);

      const revisionKey = `schedule_diff_revisions_${project.id}`;
      const existingRevs = JSON.parse(localStorage.getItem(revisionKey) || '[]');
      const newRev = {
        id: `rev-${Date.now()}`,
        name: revisionName,
        createdAt: cutoffDate,
        dataDate: cutoffDate,
        outOfSequenceMode,
        activitiesCount: activities.length,
        overallProgress: overallMetrics.overallProgress,
        spiTime: earnedScheduleData.schedulePerformanceIndexTime,
        activitiesSnapshot: activities.map((a) => ({
          id: a.id,
          code: a.code,
          name: a.name,
          duration_days: a.duration_days,
          start_date: a.early_start,
          end_date: a.early_finish,
          actual_start: a.actual_start,
          actual_finish: a.actual_finish,
          percent_complete: a.percent_complete,
          is_critical: a.is_critical,
          total_float: a.total_float,
        })),
      };
      localStorage.setItem(revisionKey, JSON.stringify([newRev, ...existingRevs]));

      setMessage(`تم إقفال الموقف الشهري وحفظ الإصدار (${revisionName}) بنجاح.`);
      setWizardStep(3);
    } catch (err: any) {
      setMessage(`حدث خطأ أثناء إقفال الموقف: ${err?.message || 'خطأ غير معروف'}`);
    } finally {
      setCutoffProcessing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-amber-500 border-t-transparent"></div>
      </div>
    );
  }

  if (!project) {
    return <div className="text-center text-slate-400 py-12">لا يوجد مشروع محدد</div>;
  }

  const completedCount = activities.filter((a) => a.percent_complete >= 100).length;
  const inProgressCount = activities.filter((a) => a.percent_complete > 0 && a.percent_complete < 100).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-black text-slate-900">سجل الإنجاز اليومي والتحكم في التنفيذ الذاتي ومقاولي الباطن</h1>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300">
                Direct & Subcontractor EVM Engine
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              تسجيل الإنتاجية اليومية مع التمييز بين التنفيذ الذاتي ومقاولي الباطن، وحساب استحقاقات الباطن، إيرادات المالك، وهوامش الأرباح آلياً
            </p>
          </div>
        </div>

        {/* 7 Full-Width Responsive Tabs Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-1.5 bg-slate-100/90 p-1.5 rounded-2xl border border-slate-200/80 shadow-inner">
          <button
            onClick={() => setActiveTab('daily_entry_sheet')}
            className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer text-center ${
              activeTab === 'daily_entry_sheet'
                ? 'bg-amber-500 text-slate-950 shadow-md font-black ring-1 ring-amber-600/30'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
            }`}
          >
            <ListPlus size={15} className="flex-shrink-0" />
            <span>اليومية الميدانية</span>
          </button>
          <button
            onClick={() => setActiveTab('single_activity_log')}
            className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer text-center ${
              activeTab === 'single_activity_log'
                ? 'bg-white text-slate-900 shadow-md font-black'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
            }`}
          >
            <Clock size={15} className="flex-shrink-0" />
            <span>سجل نشاط محدد</span>
          </button>
          <button
            onClick={() => setActiveTab('subcontractors_ledger')}
            className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer text-center ${
              activeTab === 'subcontractors_ledger'
                ? 'bg-indigo-950 text-amber-300 shadow-md font-black border border-indigo-700 ring-1 ring-indigo-500/30'
                : 'text-indigo-900 bg-indigo-50/50 hover:bg-indigo-100/70'
            }`}
          >
            <Briefcase size={15} className="flex-shrink-0 text-amber-400" />
            <span>مقاولو الباطن (EVM)</span>
          </button>
          <button
            onClick={() => setActiveTab('physical_s_curves')}
            className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer text-center ${
              activeTab === 'physical_s_curves'
                ? 'bg-slate-900 text-amber-400 shadow-md font-black'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
            }`}
          >
            <TrendingUp size={15} className="flex-shrink-0" />
            <span>الإنتاجية الحجمية</span>
          </button>
          <button
            onClick={() => setActiveTab('earned_schedule')}
            className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer text-center ${
              activeTab === 'earned_schedule'
                ? 'bg-white text-amber-900 shadow-md font-black border border-amber-300/60'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
            }`}
          >
            <Zap size={15} className="flex-shrink-0 text-amber-600" />
            <span>الجدول المكتسب ESM</span>
          </button>
          <button
            onClick={() => setActiveTab('inspections')}
            className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer text-center ${
              activeTab === 'inspections'
                ? 'bg-white text-slate-900 shadow-md font-black'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
            }`}
          >
            <FileCheck2 size={15} className="flex-shrink-0" />
            <span>طلبات الفحص (WIR)</span>
          </button>
          <button
            onClick={() => setActiveTab('cutoff_wizard')}
            className={`px-3 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer text-center ${
              activeTab === 'cutoff_wizard'
                ? 'bg-slate-900 text-amber-400 shadow-md font-black'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
            }`}
          >
            <ShieldCheck size={15} className="flex-shrink-0" />
            <span>الإقفال الشهري</span>
          </button>
        </div>
      </div>

      {message && (
        <div className="p-3.5 bg-blue-50/95 border border-blue-200 text-blue-900 rounded-xl text-xs font-medium flex items-center justify-between shadow-sm animate-fadeIn">
          <span className="font-bold">{message}</span>
          <button onClick={() => setMessage('')} className="text-blue-500 hover:text-blue-700 font-bold text-base">×</button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-bold">نسبة الإنجاز التراكمية</span>
            <TrendingUp size={16} className="text-amber-500" />
          </div>
          <p className="text-2xl font-black text-slate-900">{overallMetrics.overallProgress}%</p>
          <div className="h-1.5 bg-slate-100 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${overallMetrics.overallProgress}%` }} />
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-bold">القيمة المكتسبة التراكمية (EV)</span>
            <DollarSign size={16} className="text-emerald-600" />
          </div>
          <p className="text-2xl font-black text-emerald-700">
            {overallMetrics.totalEarnedValue.toLocaleString()} <span className="text-xs text-slate-500 font-normal">ر.س</span>
          </p>
          <p className="text-[10px] text-slate-400 mt-1">من ميزانية إجمالية {overallMetrics.totalBac.toLocaleString()} ر.س</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-bold">إنجاز مقاولي الباطن (AC Sub)</span>
            <Briefcase size={16} className="text-indigo-600" />
          </div>
          <p className="text-2xl font-black text-indigo-700">
            {subcontractorLedger.totals.totalSubcontractorIncurredAC.toLocaleString()}{' '}
            <span className="text-xs text-slate-500 font-normal">ر.س</span>
          </p>
          <p className="text-[10px] text-emerald-600 font-bold mt-1">
            أرباح متحققة: +{subcontractorLedger.totals.totalRealizedGrossProfit.toLocaleString()} ر.س ({subcontractorLedger.totals.overallMarginPercent}%)
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-bold">حالة الأنشطة الميدانية</span>
            <CheckCircle size={16} className="text-purple-600" />
          </div>
          <p className="text-base font-black text-slate-900 mt-1">
            {completedCount} مكتمل · {inProgressCount} قيد التنفيذ
          </p>
          <p className="text-[10px] text-slate-400 mt-1">إجمالي الأنشطة: {activities.length}</p>
        </div>
      </div>

      {/* TAB 1: DAILY ENTRY SHEET (BATCH QUICK LOGGING WITH SUBCONTRACTOR SWITCHER) */}
      {activeTab === 'daily_entry_sheet' && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden space-y-4">
          <div className="p-4 border-b border-slate-100 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-black text-slate-900 text-sm flex items-center gap-2">
                <Sparkles className="text-amber-500" size={17} />
                <span>شيت تسجيل الإنتاجية اليومية السريع (مع تحديد جهة التنفيذ: ذاتي / مقاول باطن)</span>
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                حدد جهة التنفيذ لكل نشاط (تنفيذ ذاتي أو مقاول باطن)، وأدخل كمية اليوم ليتم حساب التراكمي، تكلفة الباطن، إيراد المالك، وهامش الربح فورياً.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 bg-white border border-slate-300 rounded-xl px-3 py-1.5 text-xs shadow-sm">
                <Calendar size={14} className="text-amber-600" />
                <span className="font-bold text-slate-700">تاريخ اليومية:</span>
                <input
                  type="date"
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                  className="bg-transparent font-bold text-slate-900 outline-none cursor-pointer text-xs"
                />
              </div>

              <button
                onClick={handleSaveBatchDailySheet}
                disabled={saving}
                className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black px-4 py-2 rounded-xl text-xs shadow-sm transition-all disabled:opacity-50 cursor-pointer"
              >
                <Save size={15} />
                {saving ? 'جاري الاعتماد والتجميع...' : 'اعتماد وحفظ اليومية الميدانية'}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto p-4 pt-0">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-slate-700 border-b border-slate-200 font-bold">
                <tr>
                  <th className="p-3 text-right">كود النشاط</th>
                  <th className="p-3 text-right">اسم النشاط</th>
                  <th className="p-3 text-right bg-indigo-50/70 text-indigo-950 border-x border-indigo-100">
                    جهة التنفيذ 🛠️
                  </th>
                  <th className="p-3 text-right">المخطط الكلي</th>
                  <th className="p-3 text-right">المنفذ سابقاً</th>
                  <th className="p-3 text-right bg-amber-50 text-amber-900 border-x border-amber-200">
                    كمية اليوم المنفذة ✍️
                  </th>
                  <th className="p-3 text-right">الإجمالي التراكمي</th>
                  <th className="p-3 text-right">النسبة (%)</th>
                  <th className="p-3 text-right">الأثر المالي لليوم (SAR)</th>
                  <th className="p-3 text-right">المتبقي</th>
                  <th className="p-3 text-right">ملاحظات اليومية</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium">
                {activities.map((act) => {
                  const plannedQty = Math.max(1, act.planned_quantity || 1);
                  const prevQty = act.actual_quantity || 0;
                  const enteredToday = Number(dailyInputs[act.id] || 0);
                  const newCumulative = prevQty + enteredToday;
                  const newPct = Math.min(100, Number(((newCumulative / plannedQty) * 100).toFixed(1)));
                  const clientUnitRate = getActivityUnitRate(act);
                  const clientEarnedToday = Math.round(enteredToday * clientUnitRate);
                  const remainingQty = Math.max(0, plannedQty - newCumulative);
                  const isCompleted = newPct >= 100;

                  const execState = dailyExecutors[act.id] || { executorType: 'self_direct', subcontractorId: 'SUB-PKG-01' };
                  const isSub = execState.executorType === 'subcontractor';
                  const subInfo = getSubcontractorRateForActivity(act, execState.subcontractorId || 'SUB-PKG-01');
                  const subCostToday = isSub ? Math.round(enteredToday * subInfo.subRate) : 0;
                  const profitMarginToday = clientEarnedToday - subCostToday;

                  return (
                    <tr
                      key={act.id}
                      className={`hover:bg-slate-50 transition-colors ${
                        enteredToday > 0 ? 'bg-amber-50/40' : ''
                      }`}
                    >
                      <td className="p-3 font-mono font-bold text-slate-700">{act.code}</td>
                      <td className="p-3 font-bold text-slate-900 max-w-[200px] truncate">
                        <div className="flex items-center gap-1.5">
                          {act.is_critical && (
                            <span className="w-2 h-2 rounded-full bg-rose-500 flex-shrink-0" title="نشاط حرج" />
                          )}
                          <span className="truncate">{act.name}</span>
                        </div>
                      </td>

                      {/* Execution Party Switcher */}
                      <td className="p-2 bg-indigo-50/40 border-x border-indigo-100 min-w-[220px]">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <label className="flex items-center gap-1 cursor-pointer text-[11px] font-bold text-slate-700">
                              <input
                                type="radio"
                                name={`exec_${act.id}`}
                                checked={!isSub}
                                onChange={() =>
                                  setDailyExecutors({
                                    ...dailyExecutors,
                                    [act.id]: { executorType: 'self_direct' },
                                  })
                                }
                                className="accent-amber-500"
                              />
                              <span>تنفيذ ذاتي</span>
                            </label>
                            <label className="flex items-center gap-1 cursor-pointer text-[11px] font-bold text-indigo-900">
                              <input
                                type="radio"
                                name={`exec_${act.id}`}
                                checked={isSub}
                                onChange={() =>
                                  setDailyExecutors({
                                    ...dailyExecutors,
                                    [act.id]: {
                                      executorType: 'subcontractor',
                                      subcontractorId: execState.subcontractorId || 'SUB-PKG-01',
                                    },
                                  })
                                }
                                className="accent-indigo-600"
                              />
                              <span>مقاول باطن</span>
                            </label>
                          </div>

                          {isSub && (
                            <div className="space-y-1">
                              <select
                                value={execState.subcontractorId || 'SUB-PKG-01'}
                                onChange={(e) =>
                                  setDailyExecutors({
                                    ...dailyExecutors,
                                    [act.id]: {
                                      executorType: 'subcontractor',
                                      subcontractorId: e.target.value,
                                    },
                                  })
                                }
                                className="w-full text-[10px] p-1 bg-white border border-indigo-200 rounded text-indigo-950 font-bold outline-none"
                              >
                                {subcontracts.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.subcontractorName}
                                  </option>
                                ))}
                              </select>
                              <div className="text-[9px] text-indigo-700 flex justify-between font-mono">
                                <span>سعر الباطن: {subInfo.subRate.toLocaleString()} ر.س</span>
                                <span>سعر المالك: {clientUnitRate.toLocaleString()} ر.س</span>
                              </div>
                            </div>
                          )}
                        </div>
                      </td>

                      <td className="p-3 font-mono text-slate-600 whitespace-nowrap">
                        {plannedQty.toLocaleString()} {act.unit || 'وحدة'}
                      </td>
                      <td className="p-3 font-mono font-bold text-slate-700 whitespace-nowrap">
                        {prevQty.toLocaleString()} {act.unit || 'وحدة'} ({act.percent_complete}%)
                      </td>
                      
                      {/* Daily Input Column */}
                      <td className="p-2 bg-amber-50/70 border-x border-amber-200">
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            placeholder="0"
                            value={dailyInputs[act.id] !== undefined ? dailyInputs[act.id] : ''}
                            onChange={(e) => {
                              const val = e.target.value === '' ? 0 : parseFloat(e.target.value);
                              setDailyInputs({ ...dailyInputs, [act.id]: isNaN(val) ? 0 : val });
                            }}
                            className="w-20 px-2 py-1.5 bg-white border border-amber-300 rounded-lg text-xs font-mono font-black text-amber-950 focus:ring-2 focus:ring-amber-500 outline-none text-left"
                          />
                          <span className="text-[10px] text-amber-800 font-bold whitespace-nowrap">{act.unit || 'وحدة'}</span>
                        </div>
                      </td>

                      {/* Auto Calculated Cumulative Qty */}
                      <td className="p-3 font-mono font-black text-slate-900 whitespace-nowrap">
                        {newCumulative.toLocaleString()} {act.unit || 'وحدة'}
                      </td>

                      {/* Auto Calculated Percentage */}
                      <td className="p-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <div className="w-12 h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                isCompleted ? 'bg-emerald-500' : 'bg-amber-500'
                              }`}
                              style={{ width: `${newPct}%` }}
                            />
                          </div>
                          <span className={`font-mono font-bold ${isCompleted ? 'text-emerald-700' : 'text-slate-800'}`}>
                            {newPct}%
                          </span>
                        </div>
                      </td>

                      {/* Auto Calculated Financial Impact Breakdown */}
                      <td className="p-3 font-mono text-xs whitespace-nowrap">
                        {enteredToday > 0 ? (
                          isSub ? (
                            <div className="space-y-0.5">
                              <div className="text-emerald-700 font-black">إيراد مالك: +{clientEarnedToday.toLocaleString()} ر.س</div>
                              <div className="text-rose-700 font-bold text-[10px]">تكلفة باطن: {subCostToday.toLocaleString()} ر.س</div>
                              <div className="text-indigo-700 font-black text-[10px] bg-indigo-50 px-1 py-0.5 rounded">
                                صافي الربح: +{profitMarginToday.toLocaleString()} ر.س
                              </div>
                            </div>
                          ) : (
                            <div className="text-emerald-700 font-black">
                              +{clientEarnedToday.toLocaleString()} ر.س <span className="text-[10px] text-slate-400 font-normal">(ذاتي)</span>
                            </div>
                          )
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>

                      {/* Remaining Qty */}
                      <td className="p-3 font-mono text-slate-500 whitespace-nowrap">
                        {remainingQty.toLocaleString()}
                      </td>

                      {/* Notes Input */}
                      <td className="p-2">
                        <input
                          type="text"
                          placeholder="ملاحظات موقعية..."
                          value={dailyNotes[act.id] || ''}
                          onChange={(e) => setDailyNotes({ ...dailyNotes, [act.id]: e.target.value })}
                          className="w-full px-2 py-1 bg-white border border-slate-200 rounded text-[11px] text-slate-700 outline-none focus:border-amber-500"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: SINGLE ACTIVITY DETAIL LOGGING */}
      {activeTab === 'single_activity_log' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Activities Selector */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">اختر نشاطاً لعرض بياناته التفصيلية</h3>
                <p className="text-xs text-slate-400">انقر على النشاط لتسجيل منجز اليوم ومطابقة جهة التنفيذ والأسعار</p>
              </div>
              <span className="text-xs font-bold text-slate-500">{activities.length} نشاط</span>
            </div>

            <div className="max-h-[500px] overflow-y-auto divide-y divide-slate-100">
              {activities.map((act) => {
                const isSelected = selectedActivityId === act.id;
                return (
                  <button
                    key={act.id}
                    onClick={() => {
                      setSelectedActivityId(act.id);
                      setSingleTodayQty(0);
                      setSingleNotes('');
                    }}
                    className={`w-full text-right p-3.5 hover:bg-slate-50 transition-colors flex items-center justify-between cursor-pointer ${
                      isSelected ? 'bg-amber-50/80 border-r-4 border-amber-500' : ''
                    }`}
                  >
                    <div className="min-w-0 flex-1 pl-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-[11px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                          {act.code}
                        </span>
                        {act.is_critical && (
                          <span className="text-[10px] bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded font-bold">
                            حرج
                          </span>
                        )}
                        <p className="text-xs font-bold text-slate-800 truncate">{act.name}</p>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        المنجز: {act.actual_quantity || 0} من {act.planned_quantity || 1} {act.unit || 'وحدة'} (سعر المالك: {getActivityUnitRate(act).toLocaleString()} ر.س)
                      </p>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div className="w-16 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            act.percent_complete >= 100 ? 'bg-emerald-500' : 'bg-amber-500'
                          }`}
                          style={{ width: `${act.percent_complete}%` }}
                        />
                      </div>
                      <span className="text-xs font-bold text-slate-700 w-10 text-left">
                        {act.percent_complete}%
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right Single Activity Input & Dynamic Calc Box */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
            <h3 className="font-black text-slate-900 text-sm">تسجيل إنتاجية يومية مع تفصيل تكلفة الباطن وإيراد المالك</h3>
            {selectedActivityId ? (
              (() => {
                const act = activities.find((a) => a.id === selectedActivityId)!;
                const plannedQty = Math.max(1, act.planned_quantity || 1);
                const prevQty = act.actual_quantity || 0;
                const newCumulative = prevQty + Number(singleTodayQty || 0);
                const newPct = Math.min(100, Number(((newCumulative / plannedQty) * 100).toFixed(1)));
                const clientUnitRate = getActivityUnitRate(act);
                const clientEarnedToday = Math.round(Number(singleTodayQty || 0) * clientUnitRate);
                const clientTotalEarned = Math.round(newCumulative * clientUnitRate);

                const subDetails = getSubcontractorRateForActivity(act, singleSubcontractorId);
                const isSub = singleExecutorType === 'subcontractor';
                const subRate = isSub ? subDetails.subRate : clientUnitRate;
                const subCostToday = isSub ? Math.round(Number(singleTodayQty || 0) * subRate) : 0;
                const profitMarginToday = isSub ? clientEarnedToday - subCostToday : clientEarnedToday;
                const retentionToday = isSub ? Math.round(subCostToday * 0.1) : 0;
                const netPayableToday = subCostToday - retentionToday;

                return (
                  <div className="space-y-4">
                    {/* Activity Header Info */}
                    <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs font-black bg-slate-900 text-amber-400 px-2 py-0.5 rounded">
                          {act.code}
                        </span>
                        <span className="text-xs font-bold text-slate-600">
                          سعر العقد الرئيسي مع المالك: {clientUnitRate.toLocaleString()} ر.س/{act.unit || 'وحدة'}
                        </span>
                      </div>
                      <p className="text-sm font-bold text-slate-900">{act.name}</p>
                      <div className="grid grid-cols-3 gap-2 text-xs pt-1 border-t border-slate-200">
                        <div>
                          <span className="text-slate-400 text-[10px] block">الكمية المخططة الكلية:</span>
                          <span className="font-mono font-bold text-slate-800">{plannedQty.toLocaleString()} {act.unit || 'وحدة'}</span>
                        </div>
                        <div>
                          <span className="text-slate-400 text-[10px] block">المنفذ سابقاً:</span>
                          <span className="font-mono font-bold text-slate-800">{prevQty.toLocaleString()} {act.unit || 'وحدة'}</span>
                        </div>
                        <div>
                          <span className="text-slate-400 text-[10px] block">النسبة السابقة:</span>
                          <span className="font-mono font-bold text-amber-700">{act.percent_complete}%</span>
                        </div>
                      </div>
                    </div>

                    {/* Execution Party Selection */}
                    <div className="p-3 bg-indigo-50/70 border border-indigo-200 rounded-xl space-y-2">
                      <label className="block text-xs font-black text-indigo-950">جهة تنفيذ منجز اليوم (Execution Party):</label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setSingleExecutorType('self_direct')}
                          className={`p-2.5 rounded-lg border text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                            singleExecutorType === 'self_direct'
                              ? 'bg-amber-500 text-slate-950 border-amber-600 shadow-sm font-black'
                              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          <Building2 size={14} />
                          <span>تنفيذ ذاتي (المقاول الرئيسي)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setSingleExecutorType('subcontractor')}
                          className={`p-2.5 rounded-lg border text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                            singleExecutorType === 'subcontractor'
                              ? 'bg-indigo-900 text-amber-300 border-indigo-800 shadow-sm font-black'
                              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          <Briefcase size={14} />
                          <span>مقاول باطن (Subcontractor)</span>
                        </button>
                      </div>

                      {singleExecutorType === 'subcontractor' && (
                        <div className="pt-2 border-t border-indigo-200 space-y-2">
                          <label className="block text-[11px] font-bold text-indigo-900">اختر مقاول الباطن المسند إليه العمل:</label>
                          <select
                            value={singleSubcontractorId}
                            onChange={(e) => setSingleSubcontractorId(e.target.value)}
                            className="w-full p-2 bg-white border border-indigo-300 rounded-lg text-xs font-bold text-slate-900 outline-none"
                          >
                            {subcontracts.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.subcontractorName} ({s.trade})
                              </option>
                            ))}
                          </select>
                          <div className="flex items-center justify-between text-[11px] font-mono bg-white p-2 rounded-lg border border-indigo-100">
                            <span className="text-slate-600">سعر شراء الباطن: <strong className="text-rose-700">{subRate.toLocaleString()} SAR</strong></span>
                            <span className="text-slate-600">سعر بيع المالك: <strong className="text-emerald-700">{clientUnitRate.toLocaleString()} SAR</strong></span>
                            <span className="text-indigo-800 font-bold">فارق السعر: +{(clientUnitRate - subRate).toLocaleString()} SAR/وحدة</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Daily Input Fields */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold text-slate-700 mb-1">تاريخ اليومية</label>
                        <input
                          type="date"
                          value={entryDate}
                          onChange={(e) => setEntryDate(e.target.value)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-mono font-bold outline-none focus:ring-2 focus:ring-amber-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-700 mb-1">
                          كمية اليوم المنفذة ({act.unit || 'وحدة'}) ✍️
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={singleTodayQty || ''}
                          onChange={(e) => setSingleTodayQty(parseFloat(e.target.value) || 0)}
                          placeholder="أدخل كمية اليوم"
                          className="w-full px-3 py-2 border-2 border-amber-400 bg-amber-50/40 rounded-lg text-xs font-mono font-black text-slate-900 outline-none focus:ring-2 focus:ring-amber-500"
                        />
                      </div>
                    </div>

                    {/* Live Calculated Results Matrix */}
                    <div className="p-4 bg-gradient-to-br from-emerald-50/70 via-teal-50/40 to-indigo-50/40 border border-emerald-200 rounded-xl space-y-2.5">
                      <h4 className="text-xs font-black text-emerald-950 flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Check size={14} className="text-emerald-600" />
                          <span>الحسابات المالية والإنتاجية التراكمية الناتجة:</span>
                        </div>
                        {isSub && (
                          <span className="text-[10px] bg-indigo-100 text-indigo-900 px-2 py-0.5 rounded-full font-bold">
                            معاملة مقاول باطن
                          </span>
                        )}
                      </h4>

                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                        <div className="p-2 bg-white rounded-lg border border-emerald-100">
                          <span className="text-[10px] text-slate-500 block">التراكمي الجديد:</span>
                          <span className="font-mono font-black text-slate-900">{newCumulative.toLocaleString()} ({newPct}%)</span>
                        </div>
                        <div className="p-2 bg-white rounded-lg border border-emerald-100">
                          <span className="text-[10px] text-slate-500 block">إيراد المالك المكتسب (EV):</span>
                          <span className="font-mono font-black text-emerald-700">+{clientEarnedToday.toLocaleString()} ر.س</span>
                        </div>
                        {isSub ? (
                          <>
                            <div className="p-2 bg-white rounded-lg border border-rose-100">
                              <span className="text-[10px] text-slate-500 block">تكلفة مقاول الباطن (AC):</span>
                              <span className="font-mono font-black text-rose-700">{subCostToday.toLocaleString()} ر.س</span>
                            </div>
                            <div className="p-2 bg-white rounded-lg border border-indigo-100">
                              <span className="text-[10px] text-slate-500 block">هامش الربح المحقق:</span>
                              <span className="font-mono font-black text-indigo-700">+{profitMarginToday.toLocaleString()} ر.س</span>
                            </div>
                            <div className="p-2 bg-white rounded-lg border border-amber-100">
                              <span className="text-[10px] text-slate-500 block">مستقطع الضمان (10%):</span>
                              <span className="font-mono font-black text-amber-800">-{retentionToday.toLocaleString()} ر.س</span>
                            </div>
                            <div className="p-2 bg-white rounded-lg border border-emerald-100">
                              <span className="text-[10px] text-slate-500 block">صافي مستحق الباطن:</span>
                              <span className="font-mono font-black text-emerald-800">{netPayableToday.toLocaleString()} ر.س</span>
                            </div>
                          </>
                        ) : (
                          <div className="p-2 bg-white rounded-lg border border-emerald-100">
                            <span className="text-[10px] text-slate-500 block">القيمة المكتسبة الكلية:</span>
                            <span className="font-mono font-black text-slate-900">{clientTotalEarned.toLocaleString()} ر.س</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">ملاحظات وتقرير الميدان</label>
                      <textarea
                        value={singleNotes}
                        onChange={(e) => setSingleNotes(e.target.value)}
                        rows={2}
                        placeholder="وثّق موقع الصب، أرقام الشاحنات، أو أي ملحوظات فنية..."
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-amber-500 resize-none"
                      />
                    </div>

                    <button
                      onClick={handleSaveSingleDailyEntry}
                      disabled={saving || singleTodayQty <= 0}
                      className="w-full flex items-center justify-center gap-2 bg-amber-500 text-slate-950 py-2.5 rounded-xl font-black text-xs hover:bg-amber-400 transition-colors shadow-sm disabled:opacity-50 cursor-pointer"
                    >
                      <Save size={16} />
                      {saving ? 'جاري الحفظ...' : 'حفظ واعتماد منجز اليوم'}
                    </button>
                  </div>
                );
              })()
            ) : (
              <div className="text-center py-16 text-slate-400">
                <Layers size={36} className="mx-auto mb-2 opacity-30" />
                <p className="text-xs font-semibold">اختر نشاطاً من القائمة الجانبية لتسجيل إنتاجيته اليومية</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: SUBCONTRACTORS LEDGER & EARNED VALUE WORKSTATION */}
      {activeTab === 'subcontractors_ledger' && (
        <div className="space-y-6">
          {/* Engineering Concept Explanation Banner */}
          <div className="p-5 bg-gradient-to-r from-indigo-950 via-slate-900 to-indigo-900 text-white rounded-2xl shadow-md border border-indigo-800 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500 text-slate-950 flex items-center justify-center font-black flex-shrink-0 shadow">
                  <Briefcase size={20} />
                </div>
                <div>
                  <h3 className="text-base font-black text-amber-300">
                    منظومة احتساب إنجاز وتكاليف مقاولي الباطن والبنود المشتركة (Multi-Subcontractor & EVM Ledger)
                  </h3>
                  <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                    <strong>ما العمل إذا وُجد أكثر من مقاول باطن على نفس البند؟</strong> يُقسّم البند إلى <strong>حصص جغرافية أو مرحلية (Spatial / Quota Allocations)</strong> مثل (Zone A / Zone B أو توريد / تركيب). يُحسب استحقاق كل مقاول بسعر وحدته الفعلي، بينما تُجمع الكميات المنجزة في بند المالك الموحد بسعر بيع المالك لاحتساب القيمة المكتسبة الإجمالية وهامش الربح المرجح.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 text-xs border-t border-indigo-800/80">
              <div className="bg-white/5 p-2.5 rounded-xl border border-white/10">
                <span className="text-amber-400 font-bold block mb-1">1. تقسيم الحصص والأسعار (Quota & Split Pricing):</span>
                <span className="text-slate-300 text-[11px]">
                  تخصيص كمية وسعر شراء محدد لكل مقاول (مثلاً: مقاول 1 بسعر 370 ر.س ومقاول 2 بسعر 380 ر.س لنفس بند الخرسانة).
                </span>
              </div>
              <div className="bg-white/5 p-2.5 rounded-xl border border-white/10">
                <span className="text-emerald-400 font-bold block mb-1">2. توحيد الإنجاز أمام المالك (Single Client BOQ Item):</span>
                <span className="text-slate-300 text-[11px]">
                  إجمالي إيراد المالك المكتسب = (مجموع الكميات المنجزة من كافة المقاولين) × سعر بيع المالك التعاقدي الموحد.
                </span>
              </div>
              <div className="bg-white/5 p-2.5 rounded-xl border border-white/10">
                <span className="text-blue-400 font-bold block mb-1">3. مستخلصات مستقلة وضمانات منفصلة (Individual IPCs):</span>
                <span className="text-slate-300 text-[11px]">
                  إصدار شهادة دفع ومستخلص مستقل لكل مقاول بناءً على كميته المنفذة ومحاضر استلامه الموقعية (WIRs) مع حسم 10% ضمان.
                </span>
              </div>
            </div>
          </div>

          {/* Subcontractor Aggregate Financial Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[10px] font-bold text-slate-400 block mb-1">إجمالي التزامات عقود الباطن</span>
              <div className="text-base font-black text-slate-900 font-mono">
                {subcontractorLedger.totals.totalSubcontractCommitment.toLocaleString()} <span className="text-[10px] text-slate-500">SAR</span>
              </div>
            </div>

            <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[10px] font-bold text-slate-400 block mb-1">مستحقات الباطن المنفذة (AC)</span>
              <div className="text-base font-black text-rose-700 font-mono">
                {subcontractorLedger.totals.totalSubcontractorIncurredAC.toLocaleString()} <span className="text-[10px] text-slate-500">SAR</span>
              </div>
            </div>

            <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-[10px] font-bold text-slate-400 block mb-1">إيراد المالك المكتسب (EV)</span>
              <div className="text-base font-black text-emerald-700 font-mono">
                {subcontractorLedger.totals.totalClientRevenueEV.toLocaleString()} <span className="text-[10px] text-slate-500">SAR</span>
              </div>
            </div>

            <div className="bg-white p-3.5 rounded-xl border border-indigo-200 bg-indigo-50/40 shadow-sm">
              <span className="text-[10px] font-bold text-indigo-900 block mb-1">هامش الربح المحقق (Spread)</span>
              <div className="text-base font-black text-indigo-900 font-mono">
                +{subcontractorLedger.totals.totalRealizedGrossProfit.toLocaleString()} <span className="text-[10px] text-indigo-600">({subcontractorLedger.totals.overallMarginPercent}%)</span>
              </div>
            </div>

            <div className="bg-white p-3.5 rounded-xl border border-amber-200 bg-amber-50/30 shadow-sm">
              <span className="text-[10px] font-bold text-amber-900 block mb-1">مستقطعات الضمان (10% Retention)</span>
              <div className="text-base font-black text-amber-900 font-mono">
                {subcontractorLedger.totals.totalRetentionWithheld.toLocaleString()} <span className="text-[10px] text-slate-500">SAR</span>
              </div>
            </div>

            <div className="bg-white p-3.5 rounded-xl border border-emerald-200 bg-emerald-50/40 shadow-sm">
              <span className="text-[10px] font-bold text-emerald-900 block mb-1">صافي المستحق للصرف</span>
              <div className="text-base font-black text-emerald-800 font-mono">
                {subcontractorLedger.totals.totalNetPayable.toLocaleString()} <span className="text-[10px] text-slate-500">SAR</span>
              </div>
            </div>
          </div>

          {/* Section: Shared BOQ Items Matrix (Multi-Subcontractor Breakdown) */}
          <div className="bg-white rounded-2xl border border-indigo-200 shadow-sm overflow-hidden space-y-4">
            <div className="p-4 bg-gradient-to-r from-indigo-50 to-slate-50 border-b border-indigo-100 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ArrowRightLeft className="text-indigo-700" size={18} />
                <div>
                  <h4 className="text-sm font-black text-indigo-950">
                    مصفوفة البنود المشتركة وتعدد مقاولي الباطن (Shared BOQ Items & Multi-Sub Allocations)
                  </h4>
                  <p className="text-xs text-slate-500">
                    تحليل البنود التي يعمل عليها أكثر من مقاول باطن في مناطق ومراحل مختلفة (Zones & Scope Quotas)
                  </p>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-900">
                {subcontractorLedger.sharedBoqItems.length} بنود مقايسة مشتركة
              </span>
            </div>

            <div className="p-4 pt-0 space-y-4">
              {subcontractorLedger.sharedBoqItems.map((shared) => (
                <div key={shared.boqCode} className="p-4 bg-slate-50/70 rounded-xl border border-slate-200 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-black bg-indigo-900 text-amber-300 px-2 py-0.5 rounded">
                        {shared.boqCode}
                      </span>
                      <h5 className="text-sm font-black text-slate-900">{shared.description}</h5>
                      <span className="text-xs text-slate-500 font-medium">
                        (إجمالي كمية البند: {shared.totalBoqQuantity.toLocaleString()} {shared.unit} · سعر المالك: {shared.clientRateSar.toLocaleString()} SAR)
                      </span>
                    </div>

                    <div className="flex items-center gap-3 text-xs font-mono">
                      <span className="text-slate-600">
                        المنجز الكلي للبند: <strong className="text-emerald-700 font-bold">{shared.totalExecutedBySubs.toLocaleString()} {shared.unit} ({shared.overallItemProgressPct}%)</strong>
                      </span>
                      <span className="text-indigo-900 bg-indigo-100 px-2 py-0.5 rounded font-bold">
                        متوسط سعر الشراء المرجح: {shared.weightedSubcontractRate.toLocaleString()} SAR/{shared.unit}
                      </span>
                      <span className="text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded font-bold">
                        إجمالي ربح البند: +{shared.totalRealizedMarginSar.toLocaleString()} SAR ({shared.marginPercent}%)
                      </span>
                    </div>
                  </div>

                  {/* Multi-Subcontractor Allocations Table for this BOQ item */}
                  <div className="overflow-x-auto bg-white rounded-lg border border-slate-200">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-100/80 text-slate-700 font-bold border-b border-slate-200">
                        <tr>
                          <th className="p-2 text-right">مقاول الباطن</th>
                          <th className="p-2 text-right">نطاق العمل / المنطقة (Zone)</th>
                          <th className="p-2 text-right">الحصة التعاقدية (Quota)</th>
                          <th className="p-2 text-right">الكمية المسندة</th>
                          <th className="p-2 text-right">المنفذ فعلياً</th>
                          <th className="p-2 text-right">نسبة الإنجاز</th>
                          <th className="p-2 text-right text-rose-900">سعر شراء الباطن</th>
                          <th className="p-2 text-right text-emerald-900">سعر بيع المالك</th>
                          <th className="p-2 text-right bg-rose-50/50">تكلفة الباطن (AC)</th>
                          <th className="p-2 text-right bg-emerald-50/50">إيراد المالك (EV)</th>
                          <th className="p-2 text-right bg-indigo-50/50">هامش الربح المحقق</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-medium">
                        {shared.allocations.map((alloc, aIdx) => (
                          <tr key={aIdx} className="hover:bg-slate-50 transition-colors">
                            <td className="p-2 font-bold text-indigo-950 flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-indigo-600 flex-shrink-0" />
                              <span>{alloc.subcontractorName}</span>
                            </td>
                            <td className="p-2 font-semibold text-slate-800">{alloc.zoneOrScope}</td>
                            <td className="p-2 font-mono font-bold text-indigo-700">{alloc.quotaPercent}%</td>
                            <td className="p-2 font-mono text-slate-700">
                              {alloc.assignedQty.toLocaleString()} {shared.unit}
                            </td>
                            <td className="p-2 font-mono font-black text-slate-900">
                              {alloc.executedQty.toLocaleString()} {shared.unit}
                            </td>
                            <td className="p-2">
                              <div className="flex items-center gap-1.5">
                                <div className="w-12 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                  <div className="h-full bg-indigo-600 rounded-full" style={{ width: `${alloc.progressPct}%` }} />
                                </div>
                                <span className="font-mono font-bold text-slate-800">{alloc.progressPct}%</span>
                              </div>
                            </td>
                            <td className="p-2 font-mono font-bold text-rose-700">{alloc.subcontractRate.toLocaleString()} SAR</td>
                            <td className="p-2 font-mono font-bold text-emerald-700">{alloc.clientRate.toLocaleString()} SAR</td>
                            <td className="p-2 font-mono font-black text-rose-700 bg-rose-50/30">
                              {alloc.subcontractCostSar.toLocaleString()} SAR
                            </td>
                            <td className="p-2 font-mono font-black text-emerald-700 bg-emerald-50/30">
                              {alloc.clientEarnedSar.toLocaleString()} SAR
                            </td>
                            <td className="p-2 font-mono font-black text-indigo-900 bg-indigo-50/30">
                              +{alloc.marginSar.toLocaleString()} SAR
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Subcontractor Packages Breakdown Cards & Tables */}
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-slate-200">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-700">تصفية حسب مقاول الباطن:</span>
                <button
                  onClick={() => setSelectedSubcontractorFilter('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                    selectedSubcontractorFilter === 'all'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  الكل ({subcontractorLedger.summaries.length})
                </button>
                {subcontractorLedger.summaries.map((sub) => (
                  <button
                    key={sub.packageId}
                    onClick={() => setSelectedSubcontractorFilter(sub.packageId)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                      selectedSubcontractorFilter === sub.packageId
                        ? 'bg-indigo-900 text-amber-300'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {sub.subcontractorName}
                  </button>
                ))}
              </div>
            </div>

            {subcontractorLedger.summaries
              .filter((s) => selectedSubcontractorFilter === 'all' || s.packageId === selectedSubcontractorFilter)
              .map((pkg) => (
                <div key={pkg.packageId} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden space-y-4">
                  {/* Package Header */}
                  <div className="p-4 bg-slate-50/80 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded font-mono text-[11px] font-bold bg-indigo-100 text-indigo-900">
                          {pkg.subcontractNumber}
                        </span>
                        <h4 className="text-base font-black text-slate-900">{pkg.subcontractorName}</h4>
                        <span className="text-xs text-slate-500 font-medium">({pkg.trade})</span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        قيمة العقد: {pkg.contractValueSar.toLocaleString()} SAR | نسبة الإنجاز التعاقدي: <strong className="text-indigo-900 font-bold">{pkg.physicalProgressPercent}%</strong>
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setCertModalData(pkg)}
                        className="px-3 py-1.5 bg-indigo-50 text-indigo-900 hover:bg-indigo-100 border border-indigo-200 rounded-xl text-xs font-black flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <Receipt size={14} />
                        إصدار شهادة دفع / مستخلص باطن
                      </button>
                    </div>
                  </div>

                  {/* Subcontract Items Table */}
                  <div className="overflow-x-auto px-4 pb-4">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
                        <tr>
                          <th className="p-2.5 text-right">كود البند</th>
                          <th className="p-2.5 text-right">بيان الأعمال والنطاق (Zone)</th>
                          <th className="p-2.5 text-right">الكمية المسندة</th>
                          <th className="p-2.5 text-right">الكمية المنفذة فعلياً</th>
                          <th className="p-2.5 text-right">نسبة الإنجاز %</th>
                          <th className="p-2.5 text-right">سعر شراء الباطن (SAR)</th>
                          <th className="p-2.5 text-right">سعر بيع المالك (SAR)</th>
                          <th className="p-2.5 text-right bg-rose-50/70 text-rose-950">استحقاق الباطن (AC)</th>
                          <th className="p-2.5 text-right bg-emerald-50/70 text-emerald-950">إيراد المالك (EV)</th>
                          <th className="p-2.5 text-right bg-indigo-50/70 text-indigo-950">هامش الربح المحقق</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-medium">
                        {pkg.activeItems.map((itm, idx) => (
                          <tr key={idx} className="hover:bg-slate-50 transition-colors">
                            <td className="p-2.5 font-mono font-bold text-slate-700">{itm.boqCode}</td>
                            <td className="p-2.5 max-w-xs">
                              <div className="font-bold text-slate-900">{itm.description}</div>
                              {itm.zoneOrScope && (
                                <div className="text-[10px] text-indigo-700 font-semibold mt-0.5">
                                  نطاق العمل: {itm.zoneOrScope} {itm.quotaPercent ? `(حصة: ${itm.quotaPercent}%)` : ''}
                                </div>
                              )}
                            </td>
                            <td className="p-2.5 font-mono text-slate-600">
                              {itm.assignedQuantity.toLocaleString()} {itm.unit}
                            </td>
                            <td className="p-2.5 font-mono font-bold text-slate-900">
                              {itm.executedQuantity.toLocaleString()} {itm.unit}
                            </td>
                            <td className="p-2.5">
                              <div className="flex items-center gap-2">
                                <div className="w-12 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-indigo-600 rounded-full"
                                    style={{ width: `${itm.progressPct}%` }}
                                  />
                                </div>
                                <span className="font-mono font-bold text-slate-800">{itm.progressPct}%</span>
                              </div>
                            </td>
                            <td className="p-2.5 font-mono text-rose-800 font-bold">{itm.subcontractRate.toLocaleString()}</td>
                            <td className="p-2.5 font-mono text-emerald-800 font-bold">{itm.clientRate.toLocaleString()}</td>
                            <td className="p-2.5 font-mono font-black text-rose-700 bg-rose-50/40">
                              {itm.subcontractCostSar.toLocaleString()} ر.س
                            </td>
                            <td className="p-2.5 font-mono font-black text-emerald-700 bg-emerald-50/40">
                              {itm.clientEarnedSar.toLocaleString()} ر.س
                            </td>
                            <td className="p-2.5 font-mono font-black text-indigo-800 bg-indigo-50/40">
                              +{itm.marginSar.toLocaleString()} ر.س
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Summary Bar for Package */}
                  <div className="p-3.5 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-4 text-xs">
                    <div className="flex items-center gap-4">
                      <span>إجمالي استحقاق الباطن: <strong className="font-mono text-rose-700">{pkg.totalExecutedCostSar.toLocaleString()} SAR</strong></span>
                      <span>مستقطع الضمان (10%): <strong className="font-mono text-amber-800">{pkg.retentionWithheldSar.toLocaleString()} SAR</strong></span>
                      <span>صافي المستحق للدفع: <strong className="font-mono text-emerald-700 font-black">{pkg.netPayableSar.toLocaleString()} SAR</strong></span>
                    </div>
                    <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-xl border border-indigo-200">
                      <span className="text-indigo-950 font-bold">إجمالي أرباح المقاول الرئيسي من الباقة:</span>
                      <strong className="font-mono text-indigo-900 font-black text-sm">+{pkg.grossProfitSar.toLocaleString()} SAR ({pkg.marginPercent}%)</strong>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* TAB 4: PHYSICAL QUANTITY S-CURVES & REQUIRED RUN-RATE */}
      {activeTab === 'physical_s_curves' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
              <div>
                <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                  <TrendingUp className="text-amber-500" size={20} />
                  <span>منحنيات الإنتاجية المادية والحجمية ومعدل الحرق اليومي المطلوب (Physical Quantity S-Curves & Run-Rate)</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  تتبع الإنتاجية الحجمية الملموسة في الموقع (خرسانة م3، حديد طن، حفريات م3، أنابيب م.ط) لحساب معدل الإنتاجية اليومي الإلزامي للاكتمال في الموعد التعاقدي.
                </p>
              </div>
            </div>

            {/* 4 Physical Commodities Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* 1. Structural Concrete C35 */}
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-blue-600" />
                    <h4 className="text-sm font-black text-slate-900">الخرسانة المسلحة (Structural Concrete C35)</h4>
                  </div>
                  <span className="text-xs font-mono font-bold bg-blue-100 text-blue-900 px-2 py-0.5 rounded">
                    م3 (Cubic Meters)
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المخطط الكلي:</span>
                    <span className="font-mono font-black text-slate-900">2,800 م3</span>
                  </div>
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المنفذ التراكمي:</span>
                    <span className="font-mono font-black text-emerald-700">1,680 م3 (60%)</span>
                  </div>
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المتبقي:</span>
                    <span className="font-mono font-black text-amber-900">1,120 م3</span>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] font-bold">
                    <span className="text-slate-500">نسبة الإنجاز الحجمي:</span>
                    <span className="text-blue-700 font-mono">60.0%</span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-600 rounded-full" style={{ width: '60%' }} />
                  </div>
                </div>

                {/* Required Run-Rate Calculation Box */}
                <div className="p-3 bg-blue-50/80 border border-blue-200 rounded-xl space-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-blue-950">معدل الإنتاج اليومي المطلوب (Required Run-Rate):</span>
                    <span className="font-mono font-black text-blue-900 text-sm">32.0 م3 / يوم</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-blue-800">
                    <span>معدل الإنتاج الفعلي الحالي: 28.0 م3/يوم</span>
                    <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">
                      ممكن تحقيقه بزيادة وردية نصف ساعة ✓
                    </span>
                  </div>
                </div>
              </div>

              {/* 2. Steel Rebar */}
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-rose-600" />
                    <h4 className="text-sm font-black text-slate-900">حديد التسليح عالي المقاومة (High-Yield Rebar)</h4>
                  </div>
                  <span className="text-xs font-mono font-bold bg-rose-100 text-rose-900 px-2 py-0.5 rounded">
                    طن (Metric Tons)
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المخطط الكلي:</span>
                    <span className="font-mono font-black text-slate-900">350 طن</span>
                  </div>
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المنفذ التراكمي:</span>
                    <span className="font-mono font-black text-emerald-700">210 طن (60%)</span>
                  </div>
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المتبقي:</span>
                    <span className="font-mono font-black text-amber-900">140 طن</span>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] font-bold">
                    <span className="text-slate-500">نسبة الإنجاز الحجمي:</span>
                    <span className="text-rose-700 font-mono">60.0%</span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-rose-600 rounded-full" style={{ width: '60%' }} />
                  </div>
                </div>

                {/* Required Run-Rate Calculation Box */}
                <div className="p-3 bg-rose-50/80 border border-rose-200 rounded-xl space-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-rose-950">معدل الإنتاج اليومي المطلوب (Required Run-Rate):</span>
                    <span className="font-mono font-black text-rose-900 text-sm">4.0 طن / يوم</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-rose-800">
                    <span>معدل الإنتاج الفعلي الحالي: 3.5 طن/يوم</span>
                    <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">
                      ضمن الطاقة الإنتاجية للفرقة ✓
                    </span>
                  </div>
                </div>
              </div>

              {/* 3. Bulk Earthwork Excavation */}
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-amber-600" />
                    <h4 className="text-sm font-black text-slate-900">أعمال الحفريات والإحلال (Bulk Earthworks)</h4>
                  </div>
                  <span className="text-xs font-mono font-bold bg-amber-100 text-amber-900 px-2 py-0.5 rounded">
                    م3 (Cubic Meters)
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المخطط الكلي:</span>
                    <span className="font-mono font-black text-slate-900">4,500 م3</span>
                  </div>
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المنفذ التراكمي:</span>
                    <span className="font-mono font-black text-emerald-700">4,500 م3 (100%)</span>
                  </div>
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المتبقي:</span>
                    <span className="font-mono font-black text-emerald-700">0 م3</span>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] font-bold">
                    <span className="text-slate-500">نسبة الإنجاز الحجمي:</span>
                    <span className="text-emerald-700 font-mono">100.0%</span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-600 rounded-full" style={{ width: '100%' }} />
                  </div>
                </div>

                <div className="p-3 bg-emerald-50/80 border border-emerald-200 rounded-xl text-xs text-emerald-900 font-bold flex items-center gap-1.5">
                  <Check size={14} className="text-emerald-700" />
                  <span>اكتملت أعمال الحفريات بنجاح ومطابقة لمحاضر الاستلام الموقعي بالكامل.</span>
                </div>
              </div>

              {/* 4. Drainage Pipes & MEP Ductwork */}
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-purple-600" />
                    <h4 className="text-sm font-black text-slate-900">مسارات الدكت والأنابيب (MEP Piping & Ductwork)</h4>
                  </div>
                  <span className="text-xs font-mono font-bold bg-purple-100 text-purple-900 px-2 py-0.5 rounded">
                    م.ط (Linear Meters)
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المخطط الكلي:</span>
                    <span className="font-mono font-black text-slate-900">1,800 م.ط</span>
                  </div>
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المنفذ التراكمي:</span>
                    <span className="font-mono font-black text-emerald-700">650 م.ط (36.1%)</span>
                  </div>
                  <div className="p-2.5 bg-white rounded-xl border border-slate-200">
                    <span className="text-[10px] text-slate-400 block">المتبقي:</span>
                    <span className="font-mono font-black text-amber-900">1,150 م.ط</span>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] font-bold">
                    <span className="text-slate-500">نسبة الإنجاز الحجمي:</span>
                    <span className="text-purple-700 font-mono">36.1%</span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-purple-600 rounded-full" style={{ width: '36.1%' }} />
                  </div>
                </div>

                {/* Required Run-Rate Calculation Box */}
                <div className="p-3 bg-purple-50/80 border border-purple-200 rounded-xl space-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-purple-950">معدل الإنتاج اليومي المطلوب (Required Run-Rate):</span>
                    <span className="font-mono font-black text-purple-900 text-sm">24.5 م.ط / يوم</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-purple-800">
                    <span>معدل الإنتاج الفعلي الحالي: 18.0 م.ط/يوم</span>
                    <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-bold">
                      ⚠️ يوصى بإضافة فنيين لزيادة الإنتاج اليومي
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: EARNED SCHEDULE MANAGEMENT (ESM) */}
      {activeTab === 'earned_schedule' && (
        <div className="space-y-6">
          <div className="p-4 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border-r-4 border-amber-500 rounded-xl bg-white shadow-sm">
            <div className="flex items-start gap-3">
              <Zap className="text-amber-600 flex-shrink-0 mt-0.5" size={20} />
              <div>
                <h3 className="font-black text-slate-900 text-sm">تحليل الجدول المكتسب (Earned Schedule Analytics)</h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  {earnedScheduleData.timeDivergenceNote}
                </p>
                <div className="mt-2 text-[11px] text-slate-500 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                  💡 <span className="font-bold">مفارقة القيمة المكتسبة التقليدية (EVM Paradox):</span> {earnedScheduleData.comparisonWithTraditionalEvm.paradoxExplanation}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
              <h4 className="font-bold text-slate-900 text-sm mb-3 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-400"></span>
                مؤشرات القيمة المكتسبة الكلاسيكية (Cost-based EVM)
              </h4>
              <div className="space-y-3 text-xs">
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-500">انحراف الجدول المالي SV (بالريال):</span>
                  <span className="font-mono font-bold text-slate-900">
                    {earnedScheduleData.comparisonWithTraditionalEvm.evmSvAmount.toLocaleString()} ر.س
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-500">مؤشر كفاءة الجدول المالي SPI:</span>
                  <span className="font-mono font-bold text-slate-900">
                    {earnedScheduleData.comparisonWithTraditionalEvm.evmSpi.toFixed(3)}
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-slate-500">مؤشر كفاءة التكلفة CPI:</span>
                  <span className="font-mono font-bold text-emerald-600">
                    {earnedScheduleData.costPerformanceIndex.toFixed(3)}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border-2 border-amber-500/30 p-5 bg-gradient-to-b from-amber-50/20 to-transparent">
              <h4 className="font-bold text-amber-950 text-sm mb-3 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
                مؤشرات الجدول المكتسب الزمني المتقدم (Time-based ESM)
              </h4>
              <div className="space-y-3 text-xs">
                <div className="flex justify-between py-2 border-b border-amber-100">
                  <span className="text-slate-600">الجدول المكتسب الفعلي (ES):</span>
                  <span className="font-mono font-bold text-amber-900">
                    {earnedScheduleData.earnedScheduleMonths} شهر ({earnedScheduleData.earnedScheduleDays} يوم)
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-amber-100">
                  <span className="text-slate-600">الانحراف الزمني الحقيقي SV(t):</span>
                  <span className={`font-mono font-bold ${earnedScheduleData.scheduleVarianceTimeDays >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {earnedScheduleData.scheduleVarianceTimeDays >= 0 ? `+${earnedScheduleData.scheduleVarianceTimeDays}` : earnedScheduleData.scheduleVarianceTimeDays} يوم
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-amber-100">
                  <span className="text-slate-600">مؤشر الأداء الزمني SPI(t):</span>
                  <span className="font-mono font-bold text-amber-900">
                    {earnedScheduleData.schedulePerformanceIndexTime.toFixed(3)}
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-slate-600">المدة المتوقعة المستقلة للإنجاز IEAC(t):</span>
                  <span className="font-mono font-black text-purple-900">
                    {earnedScheduleData.estimatedDurationAtCompletionDays} يوم ({earnedScheduleData.forecastCompletionDate})
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 6: INSPECTIONS (WIR / MIR) */}
      {activeTab === 'inspections' && (
        <div className="space-y-6">
          {/* Concept Banner */}
          <div className="p-4 bg-gradient-to-r from-emerald-950 via-slate-900 to-teal-950 text-white rounded-2xl border border-emerald-800 shadow-md flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-emerald-500 text-slate-950 flex items-center justify-center font-black flex-shrink-0 shadow">
              <FileCheck2 size={22} />
            </div>
            <div>
              <h3 className="text-sm font-black text-emerald-300">
                منظومة الفحص الموقعي والترحيل التلقائي للإنجاز والمستحقات (WIR to EVM & Subcontractor Bridge)
              </h3>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                عند تقديم طلب الفحص والاستلام (WIR)، يتم تحديد جهة التنفيذ (ذاتي أم مقاول باطن). بمجرد <strong>اعتماد الاستشاري للطلب</strong>، يقوم النظام فورياً بـ: 
                (1) تحديث نسبة إنجاز النشاط والجدول الزمني CPM، (2) تسجيل القيمة المكتسبة للمالك EV، (3) احتساب مستحقات وتكلفة مقاول الباطن AC بناءً على سعر عقده وحصته، (4) ترحيل حركة التكلفة المباشرة إلى الميزانية ودفتر الأستاذ العام.
              </p>
            </div>
          </div>

          {/* New WIR Submission Card */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h4 className="font-black text-slate-900 text-sm flex items-center gap-2">
                <Plus size={16} className="text-emerald-600" />
                <span>إنشاء وتقديم طلب فحص واستلام هندسي جديد (New Work Inspection Request)</span>
              </h4>
              <span className="text-xs text-slate-400">وثيقة جودة رسمية ومستند الاستحقاق المالي</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
              <div>
                <label className="block text-slate-700 font-bold mb-1">رقم طلب الفحص (WIR No.)</label>
                <input
                  type="text"
                  value={inspectionForm.request_number}
                  onChange={(e) => setInspectionForm({ ...inspectionForm, request_number: e.target.value })}
                  placeholder="مثال: WIR-CIV-042"
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl font-mono font-bold text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">النشاط المرتبط في الجدول الزمني (CPM)</label>
                <select
                  value={inspectionForm.activity_id}
                  onChange={(e) => setInspectionForm({ ...inspectionForm, activity_id: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl bg-white font-bold text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="">-- اختر النشاط المرتبط --</option>
                  {activities.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code} - {item.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">تاريخ المعاينة والفحص الموقعي</label>
                <input
                  type="date"
                  value={inspectionForm.inspection_date}
                  onChange={(e) => setInspectionForm({ ...inspectionForm, inspection_date: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl font-mono font-bold text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">الكمية المطلوب فحصها واعتمادها ✍️</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={inspectionForm.quantity || ''}
                  onChange={(e) => setInspectionForm({ ...inspectionForm, quantity: parseFloat(e.target.value) || 0 })}
                  placeholder="أدخل الكمية"
                  className="w-full px-3 py-2 border-2 border-emerald-400 bg-emerald-50/30 rounded-xl font-mono font-black text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>

            {/* Execution Party Switcher in WIR */}
            <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 space-y-3">
              <label className="block text-xs font-black text-slate-900">جهة تنفيذ الأعمال المفحوصة (Execution Party):</label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setInspectionForm({ ...inspectionForm, executor_type: 'self_direct' })}
                  className={`p-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                    inspectionForm.executor_type === 'self_direct'
                      ? 'bg-slate-900 text-white border-slate-900 shadow font-black'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <Building2 size={15} />
                  <span>تنفيذ ذاتي (المقاول الرئيسي)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInspectionForm({ ...inspectionForm, executor_type: 'subcontractor' })}
                  className={`p-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                    inspectionForm.executor_type === 'subcontractor'
                      ? 'bg-indigo-900 text-amber-300 border-indigo-800 shadow font-black'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <Briefcase size={15} />
                  <span>مقاول باطن (Subcontractor)</span>
                </button>
              </div>

              {inspectionForm.executor_type === 'subcontractor' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-200 text-xs">
                  <div>
                    <label className="block text-slate-700 font-bold mb-1">اختر مقاول الباطن المنفذ:</label>
                    <select
                      value={inspectionForm.subcontractor_id}
                      onChange={(e) => setInspectionForm({ ...inspectionForm, subcontractor_id: e.target.value })}
                      className="w-full p-2 bg-white border border-indigo-200 rounded-lg text-xs font-bold text-slate-900 outline-none"
                    >
                      {subcontracts.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.subcontractorName} ({s.trade})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-700 font-bold mb-1">نطاق العمل / المنطقة الجغرافية (Zone):</label>
                    <input
                      type="text"
                      value={inspectionForm.zone_or_scope}
                      onChange={(e) => setInspectionForm({ ...inspectionForm, zone_or_scope: e.target.value })}
                      placeholder="مثال: Zone A - الدور الأول"
                      className="w-full p-2 bg-white border border-indigo-200 rounded-lg text-xs font-medium text-slate-900 outline-none"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Real-time Valuation Preview Box */}
            {(() => {
              const selectedAct = activities.find((a) => a.id === inspectionForm.activity_id);
              const qty = Number(inspectionForm.quantity) || 0;
              const clientRate = selectedAct ? getActivityUnitRate(selectedAct) : 100;
              const clientEV = qty * clientRate;
              const isSub = inspectionForm.executor_type === 'subcontractor';
              const subDetails = selectedAct ? getSubcontractorRateForActivity(selectedAct, inspectionForm.subcontractor_id) : { subRate: Math.round(clientRate * 0.7), subPkgName: 'مقاول باطن' };
              const subRate = isSub ? subDetails.subRate : clientRate;
              const subCost = isSub ? qty * subRate : 0;
              const margin = isSub ? clientEV - subCost : clientEV;
              const retention = isSub ? Math.round(subCost * 0.1) : 0;
              const netPayable = subCost - retention;

              return (
                <div className="p-3.5 bg-gradient-to-br from-emerald-50 via-teal-50 to-indigo-50 border border-emerald-200 rounded-xl space-y-2">
                  <div className="flex items-center justify-between text-xs font-black text-emerald-950">
                    <span className="flex items-center gap-1.5">
                      <Sparkles size={14} className="text-emerald-600" />
                      المعاينة المالية الفورية للأثر المترتب عند اعتماد طلب الفحص:
                    </span>
                    {qty > 0 && <span className="font-mono text-emerald-800 font-bold">الكمية: {qty.toLocaleString()} {selectedAct?.unit || 'وحدة'}</span>}
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                    <div className="p-2 bg-white rounded-lg border border-emerald-100">
                      <span className="text-[10px] text-slate-400 block">إيراد المالك (EV):</span>
                      <span className="font-mono font-black text-emerald-700">+{clientEV.toLocaleString()} SAR</span>
                    </div>
                    {isSub ? (
                      <>
                        <div className="p-2 bg-white rounded-lg border border-rose-100">
                          <span className="text-[10px] text-slate-400 block">تكلفة الباطن (AC):</span>
                          <span className="font-mono font-black text-rose-700">{subCost.toLocaleString()} SAR</span>
                        </div>
                        <div className="p-2 bg-white rounded-lg border border-indigo-100">
                          <span className="text-[10px] text-slate-400 block">هامش الربح المحقق:</span>
                          <span className="font-mono font-black text-indigo-900">+{margin.toLocaleString()} SAR</span>
                        </div>
                        <div className="p-2 bg-white rounded-lg border border-amber-100">
                          <span className="text-[10px] text-slate-400 block">مستقطع الضمان (10%):</span>
                          <span className="font-mono font-black text-amber-800">-{retention.toLocaleString()} SAR</span>
                        </div>
                        <div className="p-2 bg-white rounded-lg border border-emerald-100">
                          <span className="text-[10px] text-slate-400 block">صافي مستحق الباطن:</span>
                          <span className="font-mono font-black text-emerald-800">{netPayable.toLocaleString()} SAR</span>
                        </div>
                      </>
                    ) : (
                      <div className="p-2 bg-white rounded-lg border border-slate-100 col-span-4">
                        <span className="text-[10px] text-slate-400 block">جهة التنفيذ:</span>
                        <span className="font-bold text-slate-800">تنفيذ ذاتي (المقاول الرئيسي) - تسجيل كامل القيمة المكتسبة للمشروع</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            <div className="flex items-center justify-between gap-3 pt-1">
              <input
                type="text"
                value={inspectionForm.notes}
                onChange={(e) => setInspectionForm({ ...inspectionForm, notes: e.target.value })}
                placeholder="ملاحظات فنية، أرقام تقارير المختبر، أو رقم مذكرة استلام المواد (MIR)..."
                className="flex-1 px-3 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-emerald-500"
              />

              <button
                onClick={submitInspection}
                disabled={saving || !inspectionForm.activity_id || inspectionForm.quantity <= 0}
                className="px-6 py-2.5 bg-slate-900 text-white rounded-xl text-xs font-black hover:bg-slate-800 transition-colors shadow flex items-center gap-2 disabled:opacity-50 cursor-pointer"
              >
                <FileCheck2 size={16} />
                تقديم طلب الفحص للاستشاري
              </button>
            </div>
          </div>

          {/* Inspections Table */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden space-y-3">
            <div className="p-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
              <div>
                <h4 className="font-black text-slate-900 text-sm flex items-center gap-2">
                  <History size={16} className="text-slate-500" />
                  <span>أرشيف وسجل طلبات الفحص والاستلامات الموقعية (WIR Archive & Audit)</span>
                </h4>
                <p className="text-xs text-slate-400">إمكانية البحث والتصفية والرجوع لأي طلب فحص تاريخي وتصديره للتدقيق</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Search */}
                <input
                  type="text"
                  value={searchWir}
                  onChange={(e) => setSearchWir(e.target.value)}
                  placeholder="بحث برقم الطلب، النشاط، المقاول..."
                  className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-emerald-500 w-56"
                />

                {/* Status Filter */}
                <select
                  value={statusFilterWir}
                  onChange={(e) => setStatusFilterWir(e.target.value as any)}
                  className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none"
                >
                  <option value="all">كافة الحالات ({inspections.length})</option>
                  <option value="approved">معتمد ومرحل</option>
                  <option value="submitted">قيد التدقيق</option>
                  <option value="rejected">مرفوض</option>
                </select>

                {/* Export CSV Button */}
                <button
                  onClick={exportWirCsv}
                  className="px-3.5 py-1.5 bg-slate-900 text-white hover:bg-slate-800 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
                  title="تصدير كامل سجلات الفحص الموقعي إلى ملف Excel / CSV"
                >
                  <Download size={14} />
                  تصدير الأرشيف (CSV)
                </button>
              </div>
            </div>

            <div className="overflow-x-auto p-4 pt-0">
              <table className="w-full text-xs">
                <thead className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
                  <tr>
                    <th className="p-2.5 text-right">رقم الطلب</th>
                    <th className="p-2.5 text-right">التاريخ</th>
                    <th className="p-2.5 text-right">النشاط المرتبط</th>
                    <th className="p-2.5 text-right">جهة التنفيذ</th>
                    <th className="p-2.5 text-right">الكمية المفحوصة</th>
                    <th className="p-2.5 text-right text-emerald-800">إيراد المالك (EV)</th>
                    <th className="p-2.5 text-right text-rose-800">تكلفة الباطن (AC)</th>
                    <th className="p-2.5 text-right text-indigo-900">الربح المحقق</th>
                    <th className="p-2.5 text-center">الحالة</th>
                    <th className="p-2.5 text-center">الإجراءات الهندسية</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-medium">
                  {filteredInspections.map((req) => {
                    const act = activities.find((a) => a.id === req.activity_id);
                    const isSub = req.executor_type === 'subcontractor' || !!req.subcontractor_name;
                    const clientEV = req.client_earned_value || (act ? Math.round(req.inspected_quantity * getActivityUnitRate(act)) : 0);
                    const subCost = req.subcontractor_cost || (isSub ? Math.round(clientEV * 0.7) : 0);
                    const margin = req.profit_margin_sar !== undefined ? req.profit_margin_sar : (clientEV - subCost);

                    return (
                      <tr key={req.id} className="hover:bg-slate-50 transition-colors">
                        <td className="p-2.5 font-mono font-bold text-slate-900 whitespace-nowrap">{req.request_number}</td>
                        <td className="p-2.5 text-slate-600 font-mono whitespace-nowrap">{req.inspection_date}</td>
                        <td className="p-2.5 font-bold text-slate-900 max-w-xs truncate">
                          {act ? `${act.code} - ${act.name}` : '-'}
                        </td>
                        <td className="p-2.5 whitespace-nowrap">
                          {isSub ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-900 border border-indigo-200 flex items-center gap-1 w-fit">
                              <Briefcase size={10} />
                              <span>{req.subcontractor_name || 'مقاول باطن'}</span>
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200 flex items-center gap-1 w-fit">
                              <Building2 size={10} />
                              <span>تنفيذ ذاتي</span>
                            </span>
                          )}
                        </td>
                        <td className="p-2.5 font-mono font-black text-slate-900 whitespace-nowrap">
                          {req.inspected_quantity.toLocaleString()} {act?.unit || 'وحدة'}
                        </td>
                        <td className="p-2.5 font-mono font-black text-emerald-700 whitespace-nowrap">
                          +{clientEV.toLocaleString()} SAR
                        </td>
                        <td className="p-2.5 font-mono font-bold text-rose-700 whitespace-nowrap">
                          {isSub ? `${subCost.toLocaleString()} SAR` : '-'}
                        </td>
                        <td className="p-2.5 font-mono font-black text-indigo-900 whitespace-nowrap">
                          +{margin.toLocaleString()} SAR
                        </td>
                        <td className="p-2.5 text-center whitespace-nowrap">
                          <span
                            className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                              req.status === 'approved'
                                ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                                : req.status === 'rejected'
                                ? 'bg-rose-100 text-rose-800 border border-rose-200'
                                : 'bg-amber-100 text-amber-900 border border-amber-200'
                            }`}
                          >
                            {req.status === 'approved' ? 'معتمد ومرحل بالكامل ✓' : req.status === 'rejected' ? 'مرفوض ✗' : 'قيد المراجعة والمطابقة ⏳'}
                          </span>
                        </td>
                        <td className="p-2.5 text-center whitespace-nowrap">
                          {req.status === 'submitted' ? (
                            <div className="flex items-center justify-center gap-2">
                              <button
                                onClick={() => reviewInspection(req.id, 'approved')}
                                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-black text-[11px] flex items-center gap-1 shadow-sm transition-all cursor-pointer"
                                title="اعتماد وتحويل الكمية تلقائياً لإنجاز فعلي، قيمة مكتسبة، مستحق باطن، وتكلفة مباشرة"
                              >
                                <Check size={12} />
                                اعتماد وترحيل شامل
                              </button>
                              <button
                                onClick={() => reviewInspection(req.id, 'rejected')}
                                className="px-2 py-1 bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 rounded-lg font-bold text-[11px] transition-all cursor-pointer"
                              >
                                رفض
                              </button>
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-400 font-medium">تمت المعالجة</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 7: MONTHLY CUT-OFF WIZARD */}
      {activeTab === 'cutoff_wizard' && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-6">
          <div className="flex items-center justify-between border-b border-slate-100 pb-4">
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black ${wizardStep >= 1 ? 'bg-amber-500 text-slate-950' : 'bg-slate-100 text-slate-400'}`}>
                1
              </div>
              <div>
                <p className="text-xs font-bold text-slate-900">تحديد خط الحالة (Data Date)</p>
                <p className="text-[10px] text-slate-400">تاريخ إقفال الفترة الزمنية</p>
              </div>
            </div>

            <ChevronRight className="text-slate-300" size={16} />

            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black ${wizardStep >= 2 ? 'bg-amber-500 text-slate-950' : 'bg-slate-100 text-slate-400'}`}>
                2
              </div>
              <div>
                <p className="text-xs font-bold text-slate-900">معالجة المنطق والجودة</p>
                <p className="text-[10px] text-slate-400">Out-of-sequence & WIR</p>
              </div>
            </div>

            <ChevronRight className="text-slate-300" size={16} />

            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black ${wizardStep >= 3 ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400'}`}>
                3
              </div>
              <div>
                <p className="text-xs font-bold text-slate-900">أرشفة النسخة واعتماد التقرير</p>
                <p className="text-[10px] text-slate-400">تحديث مقارن الجداول</p>
              </div>
            </div>
          </div>

          {wizardStep === 1 && (
            <div className="space-y-4 max-w-xl">
              <h3 className="text-sm font-bold text-slate-900">الخطوة 1: تحديد تاريخ خط الحالة واسم الإصدار المعتمد</h3>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">تاريخ خط الحالة الجديد (New Data Date)</label>
                <input
                  type="date"
                  value={cutoffDate}
                  onChange={(e) => setCutoffDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">عنوان أو رقم الإصدار (Snapshot Label)</label>
                <input
                  type="text"
                  value={revisionName}
                  onChange={(e) => setRevisionName(e.target.value)}
                  placeholder="مثال: Rev 02 - الموقف التنفيذي لشهر ديسمبر 2026"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <button
                onClick={() => setWizardStep(2)}
                className="px-5 py-2.5 bg-amber-500 text-slate-950 rounded-xl font-bold text-xs hover:bg-amber-400 transition-colors cursor-pointer"
              >
                المتابعة إلى فحص المنطق والجودة ←
              </button>
            </div>
          )}

          {wizardStep === 2 && (
            <div className="space-y-4 max-w-2xl">
              <h3 className="text-sm font-bold text-slate-900">الخطوة 2: فحص الأنشطة والاعتمادات الميدانية</h3>
              <div className="space-y-3 pt-2">
                <label className="block text-xs font-bold text-slate-800">خيار جدولة الأنشطة المتبقية (Schedule Calculation Mode):</label>
                
                <label className="flex items-start gap-2.5 p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer">
                  <input
                    type="radio"
                    name="outOfSeq"
                    checked={outOfSequenceMode === 'retained_logic'}
                    onChange={() => setOutOfSequenceMode('retained_logic')}
                    className="mt-0.5 accent-amber-500"
                  />
                  <div>
                    <span className="text-xs font-bold text-slate-900">الاحتفاظ بالمنطق الأصلي (Retained Logic) - موصى به وفق DCMA / FIDIC</span>
                    <p className="text-[11px] text-slate-500">
                      يتم احترام قيود العلاقات الأصلية، بحيث لا يمكن إكمال النشاط إلا بعد إكمال الأنشطة السابقة له.
                    </p>
                  </div>
                </label>

                <label className="flex items-start gap-2.5 p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer">
                  <input
                    type="radio"
                    name="outOfSeq"
                    checked={outOfSequenceMode === 'progress_override'}
                    onChange={() => setOutOfSequenceMode('progress_override')}
                    className="mt-0.5 accent-amber-500"
                  />
                  <div>
                    <span className="text-xs font-bold text-slate-900">تجاوز التقدم (Progress Override)</span>
                    <p className="text-[11px] text-slate-500">
                      يتم تجاهل العلاقات السابقة للأنشطة التي بدأت بالفعل وتستمر الجدولة مباشرة دون انتظار السابق.
                    </p>
                  </div>
                </label>
              </div>

              <div className="flex items-center gap-3 pt-4">
                <button
                  onClick={() => setWizardStep(1)}
                  className="px-4 py-2 border border-slate-300 text-slate-700 rounded-xl text-xs font-bold hover:bg-slate-50 cursor-pointer"
                >
                  السابق
                </button>
                <button
                  onClick={executeMonthlyCutoff}
                  disabled={cutoffProcessing}
                  className="px-6 py-2.5 bg-amber-500 text-slate-950 rounded-xl font-black text-xs hover:bg-amber-400 transition-colors disabled:opacity-50 flex items-center gap-2 cursor-pointer"
                >
                  <ShieldCheck size={16} />
                  {cutoffProcessing ? 'جاري الإقفال والأرشفة...' : 'اعتماد وإقفال الفترة الزمنية الآن'}
                </button>
              </div>
            </div>
          )}

          {wizardStep === 3 && (
            <div className="p-6 bg-emerald-50/80 border border-emerald-200 rounded-2xl text-center space-y-4 max-w-lg mx-auto">
              <div className="w-12 h-12 bg-emerald-500 text-white rounded-full flex items-center justify-center mx-auto shadow-md">
                <CheckCircle size={28} />
              </div>
              <h3 className="text-base font-black text-slate-900">تم إقفال الموقف الشهري بنجاح!</h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                تم حفظ الإصدار <span className="font-bold font-mono">({revisionName})</span> وتحديث تاريخ خط الحالة إلى {cutoffDate}.
              </p>
              <button
                onClick={() => {
                  setWizardStep(1);
                  setActiveTab('daily_entry_sheet');
                }}
                className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-800 cursor-pointer"
              >
                العودة للشيت اليومي
              </button>
            </div>
          )}
        </div>
      )}

      {/* RECENT DAILY LOG HISTORY TABLE (WITH EXECUTION PARTY & FINANCIAL SPLIT) */}
      {updates.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden space-y-3">
          <div className="p-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
            <div>
              <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                <History size={16} className="text-slate-500" />
                <span>سجل الحركات اليومية المنفذة وتوزيع الإيراد والتكلفة (Daily Production History & Archive)</span>
              </h3>
              <p className="text-xs text-slate-400">أرشيف كامل لكافة الإنتاجيات اليومية والمستحقات المعتمدة طوال دورة حياة المشروع</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={searchHistory}
                onChange={(e) => setSearchHistory(e.target.value)}
                placeholder="بحث بالتاريخ، النشاط، المقاول..."
                className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-500 w-56"
              />

              <button
                onClick={exportHistoryCsv}
                className="px-3.5 py-1.5 bg-slate-900 text-white hover:bg-slate-800 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
                title="تصدير سجل الإنتاجية اليومية إلى Excel / CSV"
              >
                <Download size={14} />
                تصدير السجل اليومي (CSV)
              </button>
            </div>
          </div>

          <div className="overflow-x-auto p-4 pt-0">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-700 font-bold">
                <tr>
                  <th className="p-3 text-right">تاريخ اليومية</th>
                  <th className="p-3 text-right">النشاط المرتبط</th>
                  <th className="p-3 text-right">جهة التنفيذ</th>
                  <th className="p-3 text-right">الكمية المنفذة</th>
                  <th className="p-3 text-right">التراكمي الجديد</th>
                  <th className="p-3 text-right">النسبة %</th>
                  <th className="p-3 text-right text-emerald-800">إيراد المالك (EV)</th>
                  <th className="p-3 text-right text-rose-800">تكلفة الباطن (AC)</th>
                  <th className="p-3 text-right text-indigo-900">صافي الربح المحقق</th>
                  <th className="p-3 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium">
                {filteredUpdates.map((u) => {
                  const act = activities.find((a) => a.id === u.activity_id);
                  const isSub = u.executor_type === 'subcontractor' || !!u.subcontractor_name;
                  const clientEV = u.client_earned_value || (act ? Math.round((u.actual_quantity || 0) * getActivityUnitRate(act)) : 0);
                  const subCost = u.subcontractor_cost || (isSub ? Math.round(clientEV * 0.7) : 0);
                  const margin = u.profit_margin_sar !== undefined ? u.profit_margin_sar : (clientEV - subCost);

                  return (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="p-3 font-mono font-bold text-slate-800 whitespace-nowrap">{u.update_date}</td>
                      <td className="p-3 font-bold text-slate-900 max-w-xs truncate">
                        {act ? `${act.code} - ${act.name}` : '-'}
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        {isSub ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-900 border border-indigo-200 flex items-center gap-1 w-fit">
                            <Briefcase size={11} />
                            <span>باطن: {u.subcontractor_name || 'شركة البنيان'}</span>
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200 flex items-center gap-1 w-fit">
                            <Building2 size={11} />
                            <span>تنفيذ ذاتي (رئيسي)</span>
                          </span>
                        )}
                      </td>
                      <td className="p-3 font-mono font-black text-amber-900 whitespace-nowrap">
                        +{u.actual_quantity} {act?.unit || 'وحدة'}
                      </td>
                      <td className="p-3 font-mono font-bold text-slate-800 whitespace-nowrap">
                        {u.quantity_to_date || u.actual_quantity} {act?.unit || 'وحدة'}
                      </td>
                      <td className="p-3 font-mono font-bold text-emerald-700 whitespace-nowrap">
                        {u.percent_complete}%
                      </td>
                      <td className="p-3 font-mono font-black text-emerald-800 whitespace-nowrap">
                        +{clientEV.toLocaleString()} SAR
                      </td>
                      <td className="p-3 font-mono font-bold text-rose-700 whitespace-nowrap">
                        {isSub ? `${subCost.toLocaleString()} SAR` : '-'}
                      </td>
                      <td className="p-3 font-mono font-black text-indigo-900 whitespace-nowrap">
                        +{margin.toLocaleString()} SAR
                      </td>
                      <td className="p-3 text-center">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                          معتمد ومرحل
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBCONTRACTOR PAYMENT CERTIFICATE MODAL */}
      {certModalData && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-200 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Receipt className="text-amber-400" size={24} />
                <div>
                  <h3 className="text-base font-black">شهادة دفع ومستخلص مقاول باطن (Subcontractor IPC Certificate)</h3>
                  <p className="text-xs text-slate-300 mt-0.5">
                    {certModalData.subcontractNumber} · {certModalData.subcontractorName}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setCertModalData(null)}
                className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-6">
              {/* Project & Subcontract Details */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div>
                  <span className="text-slate-400 text-[10px] block">المشروع:</span>
                  <span className="font-bold text-slate-900">{project.name}</span>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px] block">مقاول الباطن:</span>
                  <span className="font-bold text-indigo-900">{certModalData.subcontractorName}</span>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px] block">التخصص:</span>
                  <span className="font-bold text-slate-800">{certModalData.trade}</span>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px] block">تاريخ الإصدار:</span>
                  <span className="font-mono font-bold text-slate-900">{entryDate}</span>
                </div>
              </div>

              {/* Valuation Items Breakdown */}
              <div className="space-y-2">
                <h4 className="text-xs font-black text-slate-900">تفصيل الأعمال المنجزة والمطابقة موقعياً:</h4>
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
                      <tr>
                        <th className="p-2.5 text-right">البند</th>
                        <th className="p-2.5 text-right">الوصف</th>
                        <th className="p-2.5 text-right">الكمية المسندة</th>
                        <th className="p-2.5 text-right">المنفذ المعتمد</th>
                        <th className="p-2.5 text-right">سعر الوحدة</th>
                        <th className="p-2.5 text-right">إجمالي الاستحقاق</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-medium">
                      {certModalData.activeItems.map((item, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <td className="p-2.5 font-mono font-bold">{item.boqCode}</td>
                          <td className="p-2.5 font-bold text-slate-800">{item.description}</td>
                          <td className="p-2.5 font-mono">{item.assignedQuantity.toLocaleString()} {item.unit}</td>
                          <td className="p-2.5 font-mono font-bold text-indigo-900">{item.executedQuantity.toLocaleString()} {item.unit}</td>
                          <td className="p-2.5 font-mono">{item.subcontractRate.toLocaleString()} SAR</td>
                          <td className="p-2.5 font-mono font-black text-slate-900">{item.subcontractCostSar.toLocaleString()} SAR</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Financial Deductions & Net Calculation */}
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
                <h4 className="text-xs font-black text-slate-900">ملخص الحساب المالي والاستقطاعات التعاقدية:</h4>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between py-1.5 border-b border-slate-200">
                    <span className="text-slate-600">1. إجمالي قيمة الأعمال المنجزة حتى تاريخه (VOWD):</span>
                    <span className="font-mono font-black text-slate-900">{certModalData.totalExecutedCostSar.toLocaleString()} SAR</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200 text-rose-700">
                    <span>2. مستقطع ضمان الأعمال (10% Retention Withheld):</span>
                    <span className="font-mono font-black">-{certModalData.retentionWithheldSar.toLocaleString()} SAR</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200 text-slate-600">
                    <span>3. استرداد الدفعة المقدمة والخصومات العكسية (Contra / Back-charges):</span>
                    <span className="font-mono font-bold">0.00 SAR</span>
                  </div>
                  <div className="flex justify-between py-2 bg-emerald-100/60 p-3 rounded-xl text-emerald-950 font-black text-sm">
                    <span>صافي المبلغ المستحق للصرف بموجب هذه الشهادة (Net Payable):</span>
                    <span className="font-mono">{certModalData.netPayableSar.toLocaleString()} SAR</span>
                  </div>
                </div>
              </div>

              {/* Back-to-Back Approval Signatures */}
              <div className="grid grid-cols-3 gap-4 pt-4 border-t border-slate-200 text-center text-xs">
                <div className="space-y-6">
                  <p className="font-bold text-slate-700">مهندس ضبط التكاليف (Cost Control)</p>
                  <p className="text-slate-400 text-[10px]">التوقيع: __________________</p>
                </div>
                <div className="space-y-6">
                  <p className="font-bold text-slate-700">مدير المشروع (Project Manager)</p>
                  <p className="text-slate-400 text-[10px]">التوقيع: __________________</p>
                </div>
                <div className="space-y-6">
                  <p className="font-bold text-slate-700">ممثل مقاول الباطن (Subcontractor)</p>
                  <p className="text-slate-400 text-[10px]">التوقيع: __________________</p>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-3">
              <button
                onClick={() => setCertModalData(null)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-xl text-xs font-bold hover:bg-slate-100 cursor-pointer"
              >
                إغلاق
              </button>
              <button
                onClick={() => {
                  window.print();
                }}
                className="px-5 py-2 bg-slate-900 text-white rounded-xl text-xs font-black hover:bg-slate-800 flex items-center gap-2 cursor-pointer shadow-sm"
              >
                <Printer size={15} />
                طباعة شهادة الدفع المعتمدة
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

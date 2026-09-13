/**
 * Subcontract commercial layer — persistence (GAP-019), contractual retention/cost (GAP-020) and
 * commercial chronology (GAP-021).
 *
 * SOURCE OF TRUTH (GAP-019)
 *   The database. `subcontract_packages` / `subcontract_items` (migration
 *   20260913130000_add_subcontract_commercial_tables.sql) are the only writable store:
 *     loadSubcontractPackages(projectId)  -> async, DB-first, populates an in-memory cache
 *     saveSubcontractPackages(pkgs, id)   -> async, upserts packages then items by business code
 *   localStorage (`construction_subcontracts_data_<projectId>`) is a LEGACY source only: it is read
 *   once when the database holds no rows for the project, imported into the database, and then
 *   dropped. It is never written by this module again, so the two stores can never be
 *   equal-priority writable sources.
 *   The synchronous `getSubcontractPackages()` is kept because two consumers are synchronous by
 *   design (dataGovernanceEngine's governance sweep and the first paint of ProgressView/BoqView).
 *   Its precedence is: database cache -> legacy localStorage -> project-scoped defaults, and
 *   `getSubcontractSource()` reports which one answered, so a stale read is never silent.
 *
 * IDENTITY (GAP-019, compatibility strategy A)
 *   Business codes stay the application-facing identity: `SubcontractPackage.id === 'SUB-PKG-01'`
 *   and `SubcontractBoqItem.id === 'SUB-ITM-01'`, which is what progress_updates.subcontractor_id,
 *   inspection payloads and the executor selectors already store. The relational uuids ride along
 *   as `packageId` / `itemId` and are never parsed out of a code.
 *
 * COMMERCIAL MATH (GAP-020 / GAP-021)
 *   Delegated to `@/lib/commercialControlsEngine`: retention comes from the package's contractual
 *   percent (null = unspecified = N/A, never 10%), cost comes from subcontract rate x approved
 *   executed quantity (never 70% of the client rate), margin exists only when both sides are
 *   priced, and a quantity counts as an actual only when its execution status AND date place it on
 *   or before the governed Data Date.
 */
import { supabase } from '@/lib/supabase';
import type { Activity, BoqItem, SubcontractBoqItem, SubcontractPackage } from '@/types';
import { DEFAULT_DATA_DATE } from '@/lib/projectControlsConstants';
import {
  assessCommercialChronology,
  calculatePackageCommercials,
  getContractRetentionPercent,
  type SubcontractPackageCommercials,
} from '@/lib/commercialControlsEngine';

/** Seed project the demo packages belong to (see src/lib/mockSeed.ts). */
const SEED_PROJECT_ID = 'proj-seed-001';

/**
 * Demo/seed packages, project-scoped and chronologically consistent with DEFAULT_DATA_DATE
 * (GAP-021): every package that carries an approved executed quantity is contracted on or before
 * the Data Date, and every future-dated package is `planned` with no executed quantity, so it
 * cannot enter actual or certified totals.
 *
 * Retention is per package and contractual (GAP-020): 10%, 5%, 0% and 5% — there is no default.
 * BOQ / activity references are the real seeded business codes of project 1, so the ledger links to
 * the contract BOQ instead of floating next to it.
 */
export const DEFAULT_SUBCONTRACTS: SubcontractPackage[] = [
  {
    id: 'SUB-PKG-01',
    code: 'SUB-PKG-01',
    projectId: SEED_PROJECT_ID,
    subcontractNumber: 'SUB-CON-001',
    subcontractorName: 'شركة البنيان لأعمال الخرسانات والهياكل',
    contactPerson: 'م. أحمد الشمري',
    phone: '+966 50 123 4567',
    trade: 'مقاول باطن رئيسي - أعمال الهيكل الإنشائي والخرسانات (القطاع A)',
    contractDate: '2026-07-05',
    scopeDescription: 'تنفيذ أعمال النجارة والحدادة والصب ومعالجة الخرسانة للقواعد والأعمدة والأسقف بالقطاع A والمبنى الرئيسي.',
    status: 'active',
    totalSubcontractValueSar: 374400,
    totalClientEquivalentValueSar: 611150,
    totalExpectedProfitSar: 236750,
    profitMarginPercent: 38.7,
    valueBasis: 'itemized',
    retentionPercent: 10,
    items: [
      {
        id: 'SUB-ITM-01',
        code: 'SUB-ITM-01',
        subcontractId: 'SUB-PKG-01',
        project_id: SEED_PROJECT_ID,
        boqItemId: 'boq-04',
        boqCode: 'CW-002',
        linkedActivityId: 'act-03',
        linkedActivityCode: 'ACT-003',
        description: 'خرسانة مسلحة عيار C35 للقواعد والميد الأرضية (مصنعيات وصب ومعالجة)',
        unit: 'م3',
        assignedQuantity: 280,
        subcontractRateSar: 380,
        subcontractTotalSar: 106400,
        clientRateSar: 680,
        clientTotalSar: 190400,
        expectedMarginSar: 84000,
        expectedMarginPercent: 44.1,
        executedQuantity: 280,
        executionStatus: 'approved',
        executionDate: '2026-08-14',
        zoneOrScope: 'القواعد والميد الأرضية',
        quotaPercent: 100,
      },
      {
        id: 'SUB-ITM-02',
        code: 'SUB-ITM-02',
        subcontractId: 'SUB-PKG-01',
        project_id: SEED_PROJECT_ID,
        boqItemId: 'boq-06',
        boqCode: 'CW-003',
        linkedActivityId: 'act-05',
        linkedActivityCode: 'ACT-005',
        description: 'خرسانة مسلحة للأعمدة والأسقف - حصة القطاع A (الدور الأرضي)',
        unit: 'م3',
        assignedQuantity: 400,
        subcontractRateSar: 400,
        subcontractTotalSar: 160000,
        clientRateSar: 720,
        clientTotalSar: 288000,
        expectedMarginSar: 128000,
        expectedMarginPercent: 44.4,
        executedQuantity: 64,
        executionStatus: 'approved',
        executionDate: '2026-09-10',
        zoneOrScope: 'القطاع A - أعمدة وسقف الدور الأرضي',
        quotaPercent: 61.5,
      },
      {
        id: 'SUB-ITM-03',
        code: 'SUB-ITM-03',
        subcontractId: 'SUB-PKG-01',
        project_id: SEED_PROJECT_ID,
        boqItemId: 'boq-05',
        boqCode: 'RS-001',
        linkedActivityId: 'act-03',
        linkedActivityCode: 'ACT-003',
        description: 'حديد تسليح عالي المقاومة للقواعد والأعمدة (توريد وتركيب)',
        unit: 'طن',
        assignedQuantity: 45,
        subcontractRateSar: 2400,
        subcontractTotalSar: 108000,
        clientRateSar: 2950,
        clientTotalSar: 132750,
        expectedMarginSar: 24750,
        expectedMarginPercent: 18.6,
        executedQuantity: 45,
        executionStatus: 'approved',
        executionDate: '2026-08-14',
        zoneOrScope: 'حديد تسليح القواعد والميد',
        quotaPercent: 100,
      },
    ],
  },
  {
    id: 'SUB-PKG-02',
    code: 'SUB-PKG-02',
    projectId: SEED_PROJECT_ID,
    subcontractNumber: 'SUB-CON-002',
    subcontractorName: 'شركة الإعمار والمساندة الخرسانية المحدودة',
    contactPerson: 'م. خالد الدوسري',
    phone: '+966 50 987 1122',
    trade: 'مقاول باطن مساند - أعمال خرسانات القطاع B والمباني',
    contractDate: '2026-08-01',
    scopeDescription: 'تنفيذ أعمال الخرسانة المسلحة للقطاع B ومبنى الخدمات وأعمال المباني البلكية للأدوار المتكررة.',
    status: 'active',
    totalSubcontractValueSar: 194250,
    totalClientEquivalentValueSar: 322500,
    totalExpectedProfitSar: 128250,
    profitMarginPercent: 39.8,
    valueBasis: 'itemized',
    // Contractual retention of THIS package is 5% — the ledger must deduct 5%, not 10% (GAP-020).
    retentionPercent: 5,
    items: [
      {
        id: 'SUB-ITM-04',
        code: 'SUB-ITM-04',
        subcontractId: 'SUB-PKG-02',
        project_id: SEED_PROJECT_ID,
        boqItemId: 'boq-06',
        boqCode: 'CW-003',
        linkedActivityId: 'act-05',
        linkedActivityCode: 'ACT-005',
        description: 'خرسانة مسلحة للأعمدة والأسقف - حصة القطاع B ومبنى الخدمات',
        unit: 'م3',
        assignedQuantity: 250,
        subcontractRateSar: 405,
        subcontractTotalSar: 101250,
        clientRateSar: 720,
        clientTotalSar: 180000,
        expectedMarginSar: 78750,
        expectedMarginPercent: 43.8,
        executedQuantity: 48,
        executionStatus: 'approved',
        executionDate: '2026-09-10',
        zoneOrScope: 'القطاع B - مبنى الخدمات',
        quotaPercent: 38.5,
      },
      {
        id: 'SUB-ITM-05',
        code: 'SUB-ITM-05',
        subcontractId: 'SUB-PKG-02',
        project_id: SEED_PROJECT_ID,
        boqItemId: 'boq-07',
        boqCode: 'MS-001',
        linkedActivityId: 'act-07',
        linkedActivityCode: 'ACT-007',
        description: 'مباني بلك إسمنتي معزول وخفيف للجدران الداخلية والخارجية',
        unit: 'م2',
        assignedQuantity: 1500,
        subcontractRateSar: 62,
        subcontractTotalSar: 93000,
        clientRateSar: 95,
        clientTotalSar: 142500,
        expectedMarginSar: 49500,
        expectedMarginPercent: 34.7,
        // Planned work: the linked activity starts after the Data Date, so no executed quantity and
        // no execution date. It must not contribute to actual or certified totals (GAP-021).
        executedQuantity: 0,
        executionStatus: 'planned',
        executionDate: null,
        zoneOrScope: 'جدران الأدوار المتكررة',
        quotaPercent: 46.9,
      },
    ],
  },
  {
    id: 'SUB-PKG-03',
    code: 'SUB-PKG-03',
    projectId: SEED_PROJECT_ID,
    subcontractNumber: 'SUB-CON-003',
    subcontractorName: 'مؤسسة الدقة لأعمال التكييف ومجاري الهواء (HVAC)',
    contactPerson: 'م. فهد القحطاني',
    phone: '+966 55 987 6543',
    trade: 'مقاول باطن كهروميكانيك - تصنيع وتركيب HVAC والكهرباء الأولية',
    // Future package: `planned` status with a contract date after the Data Date is allowed precisely
    // because it carries no executed quantity and stays out of every actual total (GAP-021).
    contractDate: '2026-10-01',
    scopeDescription: 'توريد وتركيب وحدات التكييف المركزي VRF وأعمال التمديدات الكهربائية الأولية والإنارة.',
    status: 'planned',
    totalSubcontractValueSar: 232300,
    totalClientEquivalentValueSar: 299050,
    totalExpectedProfitSar: 66750,
    profitMarginPercent: 22.3,
    valueBasis: 'itemized',
    // Contractual retention of 0%: a legitimate retention-free term. It must produce a 0 deduction,
    // never a hardcoded 10% (GAP-020).
    retentionPercent: 0,
    items: [
      {
        id: 'SUB-ITM-06',
        code: 'SUB-ITM-06',
        subcontractId: 'SUB-PKG-03',
        project_id: SEED_PROJECT_ID,
        boqItemId: 'boq-12',
        boqCode: 'HV-001',
        linkedActivityId: 'act-10',
        linkedActivityCode: 'ACT-010',
        description: 'توريد وتركيب وحدات التكييف المركزي VRF مع الاختبارات',
        unit: 'وحدة',
        assignedQuantity: 50,
        subcontractRateSar: 2350,
        subcontractTotalSar: 117500,
        clientRateSar: 2947,
        clientTotalSar: 147350,
        expectedMarginSar: 29850,
        expectedMarginPercent: 20.3,
        executedQuantity: 0,
        executionStatus: 'planned',
        executionDate: null,
        zoneOrScope: 'كامل المبنى (الأدوار 1-4)',
        quotaPercent: 100,
      },
      {
        id: 'SUB-ITM-07',
        code: 'SUB-ITM-07',
        subcontractId: 'SUB-PKG-03',
        project_id: SEED_PROJECT_ID,
        boqItemId: 'boq-11',
        boqCode: 'EL-001',
        linkedActivityId: 'act-08',
        linkedActivityCode: 'ACT-008',
        description: 'أعمال التمديدات الكهربائية واللوحات والإنارة (Rough-in)',
        unit: 'نقطة',
        assignedQuantity: 820,
        subcontractRateSar: 140,
        subcontractTotalSar: 114800,
        clientRateSar: 185,
        clientTotalSar: 151700,
        expectedMarginSar: 36900,
        expectedMarginPercent: 24.3,
        executedQuantity: 0,
        executionStatus: 'planned',
        executionDate: null,
        zoneOrScope: 'الأدوار من الأرضي إلى الرابع',
        quotaPercent: 100,
      },
    ],
  },
  {
    id: 'SUB-PKG-04',
    code: 'SUB-PKG-04',
    projectId: SEED_PROJECT_ID,
    subcontractNumber: 'SUB-CON-004',
    subcontractorName: 'شركة البلاط والتشطيبات الفاخرة',
    contactPerson: 'م. سليم منصور',
    phone: '+966 54 321 0987',
    trade: 'مقاول باطن - أعمال البورسلان والرخام والتشطيبات',
    contractDate: '2026-10-15',
    scopeDescription: 'أعمال تركيب أرضيات وجدران البورسلان والجرانيت مع الغراء والترويبة.',
    status: 'planned',
    // Documented lump sum: the package amount intentionally differs from the itemised sum, which is
    // the only case where a header may stand on its own (GAP-018 applied to subcontracts).
    totalSubcontractValueSar: 305000,
    totalClientEquivalentValueSar: 444000,
    totalExpectedProfitSar: 139000,
    profitMarginPercent: 31.3,
    valueBasis: 'lump_sum',
    retentionPercent: 5,
    items: [
      {
        id: 'SUB-ITM-08',
        code: 'SUB-ITM-08',
        subcontractId: 'SUB-PKG-04',
        project_id: SEED_PROJECT_ID,
        boqItemId: 'boq-10',
        boqCode: 'TL-001',
        linkedActivityId: 'act-09',
        linkedActivityCode: 'ACT-009',
        description: 'توريد وتركيب بلاط بورسلان للأرضيات والجدران مع الغراء والترويبة',
        unit: 'م2',
        assignedQuantity: 2400,
        subcontractRateSar: 130,
        subcontractTotalSar: 312000,
        clientRateSar: 185,
        clientTotalSar: 444000,
        expectedMarginSar: 132000,
        expectedMarginPercent: 29.7,
        executedQuantity: 0,
        executionStatus: 'planned',
        executionDate: null,
        zoneOrScope: 'صالات الاستقبال والممرات والمكاتب',
        quotaPercent: 100,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Persistence (GAP-019) — database is the source of truth
// ---------------------------------------------------------------------------

/** Row shape of `subcontract_packages`. */
export interface SubcontractPackageRow {
  id?: string;
  project_id: string;
  code: string;
  subcontract_number?: string | null;
  subcontractor_name: string;
  contact_person?: string | null;
  phone?: string | null;
  trade?: string | null;
  scope_description?: string | null;
  contract_date?: string | null;
  status?: string | null;
  total_subcontract_value_sar?: number | null;
  total_client_equivalent_value_sar?: number | null;
  value_basis?: 'itemized' | 'lump_sum' | null;
  retention_percent?: number | null;
  created_at?: string;
}

/** Row shape of `subcontract_items`. */
export interface SubcontractItemRow {
  id?: string;
  package_id: string;
  project_id: string;
  code: string;
  boq_item_id?: string | null;
  boq_code?: string | null;
  linked_activity_id?: string | null;
  linked_activity_code?: string | null;
  description: string;
  unit?: string | null;
  assigned_quantity?: number | null;
  subcontract_rate_sar?: number | null;
  client_rate_sar?: number | null;
  executed_quantity?: number | null;
  execution_status?: 'planned' | 'submitted' | 'approved' | 'certified' | null;
  execution_date?: string | null;
  zone_or_scope?: string | null;
  quota_percent?: number | null;
  created_at?: string;
}

/** Where the packages returned by `getSubcontractPackages()` came from. */
export type SubcontractSource =
  | 'database' // read from subcontract_packages / subcontract_items
  | 'legacy_localstorage_imported' // legacy localStorage rows imported into the database
  | 'seed_defaults_imported' // demo defaults imported into the database
  | 'legacy_localstorage' // database unavailable: legacy rows used, NOT persisted
  | 'defaults' // database unavailable: demo defaults used, NOT persisted
  | 'not_loaded';

const LEGACY_STORAGE_KEY = 'construction_subcontracts_data';
const LEGACY_IMPORT_FLAG_KEY = 'construction_subcontracts_db_import';

const packageCache = new Map<string, SubcontractPackage[]>();
const sourceLog = new Map<string, SubcontractSource>();

function cacheKey(projectId?: string | null): string {
  return projectId || 'default';
}

function readLegacyStorage(projectId?: string | null): SubcontractPackage[] | null {
  try {
    const raw = localStorage.getItem(`${LEGACY_STORAGE_KEY}_${projectId || 'default'}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as SubcontractPackage[];
    return null;
  } catch {
    return null;
  }
}

/**
 * Drop the legacy localStorage store for a project. Called after its contents have been imported
 * into the database, so localStorage can never compete with the database as a writable source.
 */
export function clearLegacySubcontractStorage(projectId?: string | null): void {
  try {
    localStorage.removeItem(`${LEGACY_STORAGE_KEY}_${projectId || 'default'}`);
  } catch {
    // A browser without localStorage simply has no legacy store to clear.
  }
}

function scopeDefaults(projectId?: string | null): SubcontractPackage[] {
  // Project isolation (CASE L): the demo packages belong to one seeded project, so they are never
  // handed to another project the way the unscoped fallback used to.
  if (!projectId) return DEFAULT_SUBCONTRACTS;
  return DEFAULT_SUBCONTRACTS.filter((pkg) => (pkg.projectId || SEED_PROJECT_ID) === projectId);
}

function numberOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Map relational rows to the application-facing package shape (business code as `id`). */
export function mapRowsToPackages(
  packageRows: SubcontractPackageRow[],
  itemRows: SubcontractItemRow[],
): SubcontractPackage[] {
  return (Array.isArray(packageRows) ? packageRows : []).map((row) => {
    const items = (Array.isArray(itemRows) ? itemRows : [])
      .filter((item) => item.package_id === row.id)
      .map((item) => {
        const assignedQuantity = numberOf(item.assigned_quantity);
        const subcontractRate = item.subcontract_rate_sar === null || item.subcontract_rate_sar === undefined ? null : numberOf(item.subcontract_rate_sar);
        const clientRate = item.client_rate_sar === null || item.client_rate_sar === undefined ? null : numberOf(item.client_rate_sar);
        const subcontractTotal = subcontractRate === null ? 0 : Math.round(assignedQuantity * subcontractRate);
        const clientTotal = clientRate === null ? 0 : Math.round(assignedQuantity * clientRate);
        const mapped: SubcontractBoqItem = {
          id: item.code,
          code: item.code,
          itemId: item.id || null,
          packageId: item.package_id,
          project_id: item.project_id,
          subcontractId: row.code,
          boqItemId: item.boq_item_id || undefined,
          boqCode: item.boq_code || '',
          linkedActivityId: item.linked_activity_id || null,
          linkedActivityCode: item.linked_activity_code || undefined,
          description: item.description,
          unit: item.unit || '',
          assignedQuantity,
          // A NULL rate stays null in the mapped shape: unpriced is a state, not a zero (GAP-020).
          subcontractRateSar: subcontractRate,
          subcontractTotalSar: subcontractTotal,
          clientRateSar: clientRate,
          clientTotalSar: clientTotal,
          expectedMarginSar: subcontractTotal > 0 && clientTotal > 0 ? clientTotal - subcontractTotal : 0,
          expectedMarginPercent: clientTotal > 0 && subcontractTotal > 0 ? Number((((clientTotal - subcontractTotal) / clientTotal) * 100).toFixed(1)) : 0,
          executedQuantity: numberOf(item.executed_quantity),
          executionStatus: (item.execution_status as SubcontractBoqItem['executionStatus']) || 'planned',
          executionDate: item.execution_date || null,
          zoneOrScope: item.zone_or_scope || undefined,
          quotaPercent: item.quota_percent === null || item.quota_percent === undefined ? null : numberOf(item.quota_percent),
        };
        return mapped;
      });

    const subcontractValue = numberOf(row.total_subcontract_value_sar);
    const clientEquivalent = row.total_client_equivalent_value_sar === null || row.total_client_equivalent_value_sar === undefined
      ? items.reduce((sum, item) => sum + numberOf(item.clientTotalSar), 0)
      : numberOf(row.total_client_equivalent_value_sar);
    const expectedProfit = clientEquivalent - subcontractValue;

    return {
      id: row.code,
      code: row.code,
      packageId: row.id || null,
      projectId: row.project_id,
      subcontractNumber: row.subcontract_number || '',
      subcontractorName: row.subcontractor_name,
      contactPerson: row.contact_person || '',
      phone: row.phone || '',
      trade: row.trade || '',
      contractDate: row.contract_date || '',
      scopeDescription: row.scope_description || '',
      status: (row.status as SubcontractPackage['status']) || 'active',
      totalSubcontractValueSar: subcontractValue,
      totalClientEquivalentValueSar: clientEquivalent,
      totalExpectedProfitSar: expectedProfit,
      profitMarginPercent: clientEquivalent > 0 ? Number(((expectedProfit / clientEquivalent) * 100).toFixed(1)) : 0,
      valueBasis: row.value_basis === 'lump_sum' ? 'lump_sum' : 'itemized',
      // NULL retention stays null: unspecified contractual retention is reported as N/A (GAP-020).
      retentionPercent:
        row.retention_percent === null || row.retention_percent === undefined ? null : numberOf(row.retention_percent),
      items,
    };
  });
}

/** Map application packages to relational rows (business code preserved, uuids kept when known). */
export function mapPackagesToRows(
  packages: SubcontractPackage[],
  projectId: string,
): { packageRows: SubcontractPackageRow[]; itemsByCode: Map<string, SubcontractItemRow[]> } {
  const packageRows: SubcontractPackageRow[] = [];
  const itemsByCode = new Map<string, SubcontractItemRow[]>();

  (Array.isArray(packages) ? packages : []).forEach((pkg) => {
    const code = pkg.code || pkg.id;
    packageRows.push({
      ...(pkg.packageId ? { id: pkg.packageId } : {}),
      project_id: pkg.projectId || projectId,
      code,
      subcontract_number: pkg.subcontractNumber || null,
      subcontractor_name: pkg.subcontractorName,
      contact_person: pkg.contactPerson || null,
      phone: pkg.phone || null,
      trade: pkg.trade || null,
      scope_description: pkg.scopeDescription || null,
      contract_date: pkg.contractDate || null,
      status: pkg.status || 'active',
      total_subcontract_value_sar: numberOf(pkg.totalSubcontractValueSar),
      total_client_equivalent_value_sar: numberOf(pkg.totalClientEquivalentValueSar),
      value_basis: pkg.valueBasis === 'lump_sum' ? 'lump_sum' : 'itemized',
      retention_percent: getContractRetentionPercent(pkg),
    });

    itemsByCode.set(
      code,
      (Array.isArray(pkg.items) ? pkg.items : []).map((item) => ({
        ...(item.itemId ? { id: item.itemId } : {}),
        // package_id is filled in by the caller once the package row's uuid is known.
        package_id: item.packageId || '',
        project_id: item.project_id || pkg.projectId || projectId,
        code: item.code || item.id,
        boq_item_id: item.boqItemId || null,
        boq_code: item.boqCode || null,
        linked_activity_id: item.linkedActivityId || null,
        linked_activity_code: item.linkedActivityCode || null,
        description: item.description,
        unit: item.unit || null,
        assigned_quantity: numberOf(item.assignedQuantity),
        // An unpriced item persists as NULL rather than as a fabricated rate (GAP-020).
        subcontract_rate_sar: Number.isFinite(Number(item.subcontractRateSar)) && Number(item.subcontractRateSar) > 0 ? Number(item.subcontractRateSar) : null,
        client_rate_sar: Number.isFinite(Number(item.clientRateSar)) && Number(item.clientRateSar) > 0 ? Number(item.clientRateSar) : null,
        executed_quantity: numberOf(item.executedQuantity),
        execution_status: item.executionStatus || (numberOf(item.executedQuantity) > 0 ? 'approved' : 'planned'),
        execution_date: item.executionDate || null,
        zone_or_scope: item.zoneOrScope || null,
        quota_percent: item.quotaPercent === undefined || item.quotaPercent === null ? null : numberOf(item.quotaPercent),
      })),
    );
  });

  return { packageRows, itemsByCode };
}

/**
 * Load a project's subcontract packages from the database (DB-first).
 *
 * When the database holds no rows for the project, the legacy localStorage store is imported once
 * (or the project-scoped demo defaults are, if there is no legacy store), written to the database
 * and the legacy key is dropped. If the database is unreachable or the tables do not exist yet, the
 * legacy/default values are still returned — but the source is reported as non-database so the
 * caller knows the SSOT was not available.
 */
export async function loadSubcontractPackages(projectId?: string | null): Promise<SubcontractPackage[]> {
  const key = cacheKey(projectId);
  if (!projectId) {
    const fallback = scopeDefaults(projectId);
    packageCache.set(key, fallback);
    sourceLog.set(key, 'defaults');
    return fallback;
  }

  try {
    const [pkgRes, itemRes] = await Promise.all([
      supabase.from('subcontract_packages').select('*').eq('project_id', projectId).order('code', { ascending: true }),
      supabase.from('subcontract_items').select('*').eq('project_id', projectId).order('code', { ascending: true }),
    ]);
    const packageRows = (pkgRes?.data || []) as SubcontractPackageRow[];
    const itemRows = (itemRes?.data || []) as SubcontractItemRow[];

    if (packageRows.length > 0) {
      const packages = mapRowsToPackages(packageRows, itemRows);
      packageCache.set(key, packages);
      sourceLog.set(key, 'database');
      // The database is authoritative; a stale legacy copy must not survive beside it.
      clearLegacySubcontractStorage(projectId);
      return packages;
    }

    // Nothing in the database yet: one-time import of the legacy store, else the demo defaults.
    const legacy = readLegacyStorage(projectId);
    const imported = legacy && legacy.length > 0 ? legacy : scopeDefaults(projectId);
    const source: SubcontractSource = legacy && legacy.length > 0 ? 'legacy_localstorage_imported' : 'seed_defaults_imported';
    const persisted = await persistPackages(imported, projectId);
    if (persisted) {
      packageCache.set(key, persisted.packages);
      sourceLog.set(key, source);
      clearLegacySubcontractStorage(projectId);
      return persisted.packages;
    }
    packageCache.set(key, imported);
    sourceLog.set(key, legacy && legacy.length > 0 ? 'legacy_localstorage' : 'defaults');
    return imported;
  } catch (error) {
    console.warn('Subcontract packages could not be loaded from the database', error);
    const legacy = readLegacyStorage(projectId);
    const fallback = legacy && legacy.length > 0 ? legacy : scopeDefaults(projectId);
    packageCache.set(key, fallback);
    sourceLog.set(key, legacy && legacy.length > 0 ? 'legacy_localstorage' : 'defaults');
    return fallback;
  }
}

/** Which store answered the last read for a project — the DB, a legacy import, or the defaults. */
export function getSubcontractSource(projectId?: string | null): SubcontractSource {
  return sourceLog.get(cacheKey(projectId)) || 'not_loaded';
}

/**
 * Upsert packages then items, keyed by their business codes. Returns the re-read database state so
 * the caller's cache holds rows with real uuids. `false` means the database was not writable.
 */
async function persistPackages(
  packages: SubcontractPackage[],
  projectId: string,
): Promise<{ packages: SubcontractPackage[] } | false> {
  try {
    const { packageRows, itemsByCode } = mapPackagesToRows(packages, projectId);
    if (packageRows.length === 0) return { packages: [] };

    const upserted = await supabase
      .from('subcontract_packages')
      .upsert(packageRows, { onConflict: 'project_id,code' });
    if (upserted?.error) throw upserted.error;

    // Re-read to obtain authoritative uuids (the mock store generates ids on write, and Supabase
    // only returns them when explicitly selected), then attach the items to their package.
    const pkgRes = await supabase.from('subcontract_packages').select('*').eq('project_id', projectId);
    const storedPackages = (pkgRes?.data || []) as SubcontractPackageRow[];
    const idByCode = new Map(storedPackages.map((row) => [row.code, row.id as string]));

    const itemRows: SubcontractItemRow[] = [];
    itemsByCode.forEach((rows, code) => {
      const packageId = idByCode.get(code);
      if (!packageId) return;
      rows.forEach((row) => itemRows.push({ ...row, package_id: packageId }));
    });

    if (itemRows.length > 0) {
      const itemsUpsert = await supabase.from('subcontract_items').upsert(itemRows, { onConflict: 'package_id,code' });
      if (itemsUpsert?.error) throw itemsUpsert.error;
    } else {
      // A package whose items were all removed: keep the database consistent with the payload.
      const existingItems = await supabase.from('subcontract_items').select('*').eq('project_id', projectId);
      const keepCodes = new Set(itemRows.map((row) => `${row.package_id}:${row.code}`));
      const stale = ((existingItems?.data || []) as SubcontractItemRow[]).filter(
        (row) => !keepCodes.has(`${row.package_id}:${row.code}`),
      );
      for (const row of stale) {
        await supabase.from('subcontract_items').delete().eq('id', row.id);
      }
    }

    const [finalPkgRes, finalItemRes] = await Promise.all([
      supabase.from('subcontract_packages').select('*').eq('project_id', projectId).order('code', { ascending: true }),
      supabase.from('subcontract_items').select('*').eq('project_id', projectId).order('code', { ascending: true }),
    ]);
    return {
      packages: mapRowsToPackages((finalPkgRes?.data || []) as SubcontractPackageRow[], (finalItemRes?.data || []) as SubcontractItemRow[]),
    };
  } catch (error) {
    console.warn('Subcontract packages could not be persisted to the database', error);
    return false;
  }
}

/**
 * Persist packages to the database (the only writable store) and refresh the cache.
 *
 * Signature-compatible with the former synchronous localStorage writer, so existing callers keep
 * working; they simply no longer have to await it. The legacy localStorage key is removed once the
 * database write succeeds, which is what makes the database the single source of truth.
 */
export function saveSubcontractPackages(packages: SubcontractPackage[], projectId?: string | null): Promise<void> {
  const key = cacheKey(projectId);
  packageCache.set(key, packages);
  if (!projectId) {
    // Without a project there is nothing to scope rows to; the in-memory cache is all that can be
    // updated, and the legacy store is deliberately NOT written (no second writable source).
    return Promise.resolve();
  }
  return persistPackages(packages, projectId).then((result) => {
    if (result) {
      packageCache.set(key, result.packages);
      sourceLog.set(key, 'database');
      clearLegacySubcontractStorage(projectId);
    } else {
      sourceLog.set(key, readLegacyStorage(projectId) ? 'legacy_localstorage' : 'defaults');
    }
  });
}

/**
 * Synchronous read for the consumers that cannot await (the governance sweep and first paint).
 * Precedence: database cache -> legacy localStorage -> project-scoped defaults. Use
 * `getSubcontractSource()` to know which answered, and `loadSubcontractPackages()` to make the
 * database authoritative.
 */
export function getSubcontractPackages(projectId?: string | null): SubcontractPackage[] {
  const key = cacheKey(projectId);
  const cached = packageCache.get(key);
  if (cached && cached.length > 0) return cached;

  const legacy = readLegacyStorage(projectId);
  if (legacy && legacy.length > 0) {
    packageCache.set(key, legacy);
    sourceLog.set(key, 'legacy_localstorage');
    return legacy;
  }

  const fallback = scopeDefaults(projectId);
  packageCache.set(key, fallback);
  sourceLog.set(key, 'defaults');
  return fallback;
}

/** Mark the legacy store as imported for a project (used by the one-time import path). */
export function markLegacyImportDone(projectId?: string | null, at: string = new Date().toISOString()): void {
  try {
    localStorage.setItem(`${LEGACY_IMPORT_FLAG_KEY}_${projectId || 'default'}`, at);
  } catch {
    // Not fatal: the flag only records when the one-time import happened.
  }
}

// ---------------------------------------------------------------------------
// Ledger (GAP-020 / GAP-021) — thin presentation layer over the commercial engine
// ---------------------------------------------------------------------------

export interface SubcontractorPerformanceSummary {
  packageId: string;
  code: string;
  subcontractNumber: string;
  subcontractorName: string;
  trade: string;
  contractValueSar: number;
  clientEquivalentValueSar: number;
  /** Executed subcontract cost at the Data Date (AC of the subcontractor). */
  totalExecutedCostSar: number;
  /** Client earned value of the same executed quantities (EV with the client). */
  totalClientEarnedValueSar: number;
  /** Null when either side is unpriced: no fabricated margin (GAP-020). */
  grossProfitSar: number | null;
  marginPercent: number | null;
  marginStatus: 'valid' | 'unpriced_subcontract' | 'unpriced_client' | 'no_actual_quantity';
  /** Contractual retention percent of the package, or null when the contract does not specify one. */
  retentionPercent: number | null;
  retentionSource: 'contract' | 'not_specified';
  retentionWithheldSar: number | null;
  netPayableSar: number | null;
  physicalProgressPercent: number;
  itemsCount: number;
  unpricedItemCount: number;
  unpricedExecutedQuantity: number;
  plannedItemCount: number;
  futureDatedItemCount: number;
  valueStatus: 'balanced' | 'mismatch' | 'lump_sum' | 'not_priced';
  itemizedContractSum: number | null;
  valueDelta: number | null;
  flagsAr: string[];
  flagsEn: string[];
  /** Full commercial detail, for screens that show the reconciliation itself. */
  commercial: SubcontractPackageCommercials;
  activeItems: {
    itemId: string;
    boqCode: string;
    description: string;
    unit: string;
    assignedQuantity: number;
    executedQuantity: number;
    approvedExecutedQuantity: number;
    subcontractRate: number | null;
    subcontractRateStatus: 'priced' | 'unpriced';
    clientRate: number | null;
    subcontractCostSar: number | null;
    clientEarnedSar: number | null;
    marginSar: number | null;
    progressPct: number;
    zoneOrScope?: string;
    quotaPercent?: number | null;
    executionStatus: string;
    executionDate: string | null;
  }[];
}

export interface SharedBoqItemSplit {
  boqCode: string;
  description: string;
  unit: string;
  totalBoqQuantity: number;
  clientRateSar: number;
  clientTotalBudgetSar: number;
  subcontractorsCount: number;
  totalAssignedToSubs: number;
  totalExecutedBySubs: number;
  overallItemProgressPct: number;
  /** Weighted purchase rate of the executed quantities; null while nothing is priced/executed. */
  weightedSubcontractRate: number | null;
  totalSubcontractCostSar: number;
  totalClientEarnedSar: number;
  /** Null when either side is unpriced (GAP-020). */
  totalRealizedMarginSar: number | null;
  marginPercent: number | null;
  allocations: {
    packageId: string;
    subcontractNumber: string;
    subcontractorName: string;
    zoneOrScope: string;
    assignedQty: number;
    executedQty: number;
    approvedExecutedQty: number;
    remainingQty: number;
    quotaPercent: number;
    quotaSource: 'item' | 'derived' | 'unknown';
    subcontractRate: number | null;
    clientRate: number | null;
    subcontractCostSar: number | null;
    clientEarnedSar: number | null;
    marginSar: number | null;
    progressPct: number;
    executionStatus: string;
  }[];
}

export interface SubcontractLedgerTotals {
  totalSubcontractCommitment: number;
  totalItemizedContractSum: number;
  totalClientEquivalent: number;
  totalSubcontractorIncurredAC: number;
  totalClientRevenueEV: number;
  /** Null when any executed side is unpriced. */
  totalRealizedGrossProfit: number | null;
  overallMarginPercent: number | null;
  /** Null when at least one package has no contractual retention percent. */
  totalRetentionWithheld: number | null;
  totalNetPayable: number | null;
  packagesWithUnknownRetention: number;
  packagesWithValueMismatch: number;
  unpricedItemCount: number;
  futureDatedItemCount: number;
}

/**
 * The subcontract ledger, computed by the commercial engine.
 *
 * `activities` is accepted for signature compatibility with the existing callers; the ledger's
 * quantities come from the subcontract items themselves (approved executed quantities), never from
 * an activity-derived estimate.
 */
export function calculateSubcontractorLedger(
  packages: SubcontractPackage[],
  _activities: Activity[],
  boqItems: BoqItem[],
  options: { dataDate?: string | null } = {},
): {
  summaries: SubcontractorPerformanceSummary[];
  sharedBoqItems: SharedBoqItemSplit[];
  totals: SubcontractLedgerTotals;
} {
  const dataDate = options.dataDate || DEFAULT_DATA_DATE;
  const list = Array.isArray(packages) ? packages : [];

  const summaries: SubcontractorPerformanceSummary[] = list.map((pkg) => {
    const commercial = calculatePackageCommercials(pkg, { dataDate, boqItems });
    return {
      packageId: pkg.id,
      code: commercial.code,
      subcontractNumber: pkg.subcontractNumber,
      subcontractorName: pkg.subcontractorName,
      trade: pkg.trade,
      contractValueSar: commercial.contractValue || 0,
      clientEquivalentValueSar: commercial.clientEquivalentValue || 0,
      totalExecutedCostSar: commercial.grossCertified,
      totalClientEarnedValueSar: commercial.clientEarnedValueToDate,
      grossProfitSar: commercial.marginToDate,
      marginPercent: commercial.marginPercent,
      marginStatus: commercial.marginStatus,
      retentionPercent: commercial.retentionPercent,
      retentionSource: commercial.retentionSource,
      retentionWithheldSar: commercial.retentionAmount,
      netPayableSar: commercial.netPayable,
      physicalProgressPercent: commercial.physicalProgressPercent,
      itemsCount: commercial.itemsCount,
      unpricedItemCount: commercial.unpricedItemCount,
      unpricedExecutedQuantity: commercial.unpricedExecutedQuantity,
      plannedItemCount: commercial.plannedItemCount,
      futureDatedItemCount: commercial.futureDatedItemCount,
      valueStatus: commercial.valueStatus,
      itemizedContractSum: commercial.itemizedContractSum,
      valueDelta: commercial.valueDelta,
      flagsAr: commercial.flagsAr,
      flagsEn: commercial.flagsEn,
      commercial,
      activeItems: commercial.items.map((item) => ({
        itemId: item.itemId,
        boqCode: item.boqCode || '',
        description: item.description,
        unit: item.unit,
        assignedQuantity: item.assignedQuantity,
        executedQuantity: item.executedQuantity,
        approvedExecutedQuantity: item.approvedExecutedQuantity,
        subcontractRate: item.subcontractRate,
        subcontractRateStatus: item.subcontractRateStatus,
        clientRate: item.clientRate,
        subcontractCostSar: item.subcontractCost,
        clientEarnedSar: item.clientEarnedValue,
        marginSar: item.margin,
        progressPct: item.progressPercent,
        zoneOrScope: item.zoneOrScope || undefined,
        quotaPercent: item.quotaPercent,
        executionStatus: item.executionStatus,
        executionDate: item.executionDate,
      })),
    };
  });

  const sharedBoqItems = calculateSharedBoqItemsMatrix(list, boqItems, { dataDate });

  const totalSubcontractCommitment = summaries.reduce((sum, s) => sum + s.contractValueSar, 0);
  const totalItemizedContractSum = summaries.reduce((sum, s) => sum + (s.itemizedContractSum || 0), 0);
  const totalClientEquivalent = summaries.reduce((sum, s) => sum + s.clientEquivalentValueSar, 0);
  const totalSubcontractorIncurredAC = summaries.reduce((sum, s) => sum + s.totalExecutedCostSar, 0);
  const totalClientRevenueEV = summaries.reduce((sum, s) => sum + s.totalClientEarnedValueSar, 0);
  const packagesWithUnknownRetention = summaries.filter((s) => s.retentionPercent === null);
  const unpricedExecuted = summaries.some(
    (s) => s.totalExecutedCostSar <= 0 && s.totalClientEarnedValueSar <= 0 && s.unpricedItemCount > 0,
  );
  const totalRealizedGrossProfit =
    totalSubcontractorIncurredAC > 0 && totalClientRevenueEV > 0 && !unpricedExecuted
      ? totalClientRevenueEV - totalSubcontractorIncurredAC
      : null;

  return {
    summaries,
    sharedBoqItems,
    totals: {
      totalSubcontractCommitment,
      totalItemizedContractSum,
      totalClientEquivalent,
      totalSubcontractorIncurredAC,
      totalClientRevenueEV,
      totalRealizedGrossProfit,
      overallMarginPercent:
        totalRealizedGrossProfit !== null && totalClientRevenueEV > 0
          ? Number(((totalRealizedGrossProfit / totalClientRevenueEV) * 100).toFixed(1))
          : null,
      totalRetentionWithheld:
        packagesWithUnknownRetention.length > 0
          ? null
          : summaries.reduce((sum, s) => sum + (s.retentionWithheldSar || 0), 0),
      totalNetPayable:
        packagesWithUnknownRetention.length > 0 ? null : summaries.reduce((sum, s) => sum + (s.netPayableSar || 0), 0),
      packagesWithUnknownRetention: packagesWithUnknownRetention.length,
      packagesWithValueMismatch: summaries.filter((s) => s.valueStatus === 'mismatch').length,
      unpricedItemCount: summaries.reduce((sum, s) => sum + s.unpricedItemCount, 0),
      futureDatedItemCount: summaries.reduce((sum, s) => sum + s.futureDatedItemCount, 0),
    },
  };
}

/**
 * The shared-BOQ matrix: how one contract BOQ item is split across subcontract packages.
 * Executed quantities are the approved ones at the Data Date, and rates that do not exist stay
 * unpriced instead of being estimated.
 */
export function calculateSharedBoqItemsMatrix(
  packages: SubcontractPackage[],
  boqItems: BoqItem[],
  options: { dataDate?: string | null } = {},
): SharedBoqItemSplit[] {
  const dataDate = options.dataDate || DEFAULT_DATA_DATE;
  const list = Array.isArray(packages) ? packages : [];
  const mapByBoq = new Map<string, { pkg: SubcontractPackage; item: SubcontractBoqItem }[]>();

  list.forEach((pkg) => {
    (Array.isArray(pkg.items) ? pkg.items : []).forEach((item) => {
      const code = item.boqCode;
      if (!code) return;
      if (!mapByBoq.has(code)) mapByBoq.set(code, []);
      mapByBoq.get(code)!.push({ pkg, item });
    });
  });

  const results: SharedBoqItemSplit[] = [];

  mapByBoq.forEach((allocationsList, boqCode) => {
    const mainBoq = (Array.isArray(boqItems) ? boqItems : []).find((b) => b.code === boqCode);
    const firstItem = allocationsList[0].item;
    const description = mainBoq?.description || firstItem.description;
    const unit = mainBoq?.unit || firstItem.unit;
    const totalBoqQuantity = numberOf(mainBoq?.quantity) || allocationsList.reduce((sum, x) => sum + numberOf(x.item.assignedQuantity), 0);
    const clientRateSar = numberOf(mainBoq?.unit_price) || numberOf(firstItem.clientRateSar);
    const clientTotalBudgetSar = Math.round(totalBoqQuantity * clientRateSar);

    let totalAssigned = 0;
    let totalExecuted = 0;
    let totalSubCost = 0;
    let totalClientEv = 0;
    let subCostPriced = true;
    let clientEvPriced = true;

    const allocations = allocationsList.map(({ pkg, item }) => {
      const assigned = numberOf(item.assignedQuantity);
      const executed = numberOf(item.executedQuantity);
      const executionStatus = item.executionStatus || (executed > 0 ? 'approved' : 'planned');
      const chronology = assessCommercialChronology({
        recordDate: item.executionDate || null,
        status: executionStatus,
        dataDate,
      });
      const approvedExecuted = chronology.countsAsActual ? executed : 0;
      const remaining = Math.max(0, assigned - approvedExecuted);

      const subRate = Number.isFinite(Number(item.subcontractRateSar)) && Number(item.subcontractRateSar) > 0 ? Number(item.subcontractRateSar) : null;
      const clientRate = numberOf(mainBoq?.unit_price) > 0 ? Number(mainBoq!.unit_price) : (Number(item.clientRateSar) > 0 ? Number(item.clientRateSar) : null);
      const subCost = subRate === null ? null : Math.round(approvedExecuted * subRate);
      const clientEv = clientRate === null ? null : Math.round(approvedExecuted * clientRate);
      if (subCost === null && approvedExecuted > 0) subCostPriced = false;
      if (clientEv === null && approvedExecuted > 0) clientEvPriced = false;

      totalAssigned += assigned;
      totalExecuted += approvedExecuted;
      totalSubCost += subCost || 0;
      totalClientEv += clientEv || 0;

      const derivedQuota = totalBoqQuantity > 0 ? Number(((assigned / totalBoqQuantity) * 100).toFixed(1)) : null;
      const quotaSource: 'item' | 'derived' | 'unknown' =
        item.quotaPercent !== undefined && item.quotaPercent !== null ? 'item' : derivedQuota !== null ? 'derived' : 'unknown';

      return {
        packageId: pkg.id,
        subcontractNumber: pkg.subcontractNumber,
        subcontractorName: pkg.subcontractorName,
        zoneOrScope: item.zoneOrScope || 'نطاق تعاقدي محدد',
        assignedQty: assigned,
        executedQty: executed,
        approvedExecutedQty: approvedExecuted,
        remainingQty: remaining,
        // No fabricated 50% share: an unknown quota is reported as unknown (GAP-020 discipline).
        quotaPercent: quotaSource === 'item' ? Number(item.quotaPercent) : quotaSource === 'derived' ? (derivedQuota as number) : 0,
        quotaSource,
        subcontractRate: subRate,
        clientRate,
        subcontractCostSar: subCost,
        clientEarnedSar: clientEv,
        marginSar: subCost !== null && clientEv !== null ? clientEv - subCost : null,
        progressPct: assigned > 0 ? Math.min(100, Number(((approvedExecuted / assigned) * 100).toFixed(1))) : 0,
        executionStatus,
      };
    });

    const overallItemProgressPct = totalBoqQuantity > 0 ? Math.min(100, Number(((totalExecuted / totalBoqQuantity) * 100).toFixed(1))) : 0;
    const realizedMargin = subCostPriced && clientEvPriced && totalExecuted > 0 ? totalClientEv - totalSubCost : null;

    results.push({
      boqCode,
      description,
      unit,
      totalBoqQuantity,
      clientRateSar,
      clientTotalBudgetSar,
      subcontractorsCount: allocations.length,
      totalAssignedToSubs: totalAssigned,
      totalExecutedBySubs: totalExecuted,
      overallItemProgressPct,
      weightedSubcontractRate: totalExecuted > 0 && subCostPriced ? Math.round(totalSubCost / totalExecuted) : null,
      totalSubcontractCostSar: totalSubCost,
      totalClientEarnedSar: totalClientEv,
      totalRealizedMarginSar: realizedMargin,
      marginPercent: realizedMargin !== null && totalClientEv > 0 ? Number(((realizedMargin / totalClientEv) * 100).toFixed(1)) : null,
      allocations,
    });
  });

  return results.sort((a, b) => b.subcontractorsCount - a.subcontractorsCount);
}

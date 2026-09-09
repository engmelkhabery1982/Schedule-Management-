import * as XLSX from 'xlsx';
import type { ParsedBoqRow } from '@/types';

// Arabic and English column name normalization
function normalizeHeader(header: string): string {
  const h = header.toLowerCase().trim();
  const map: Record<string, string> = {
    'code': 'code', 'item code': 'code', 'رقم': 'code', 'رقم البند': 'code', 'كود': 'code', 'ref': 'code', 'item no': 'code', 'item no.': 'code', 'no': 'code', 'no.': 'code', 'بند': 'code',
    'description': 'description', 'item description': 'description', 'description of work': 'description', 'وصف': 'description', 'البيان': 'description', 'البند': 'description', 'details': 'description', 'description of item': 'description',
    'unit': 'unit', 'وحدة': 'unit', 'وحدة القياس': 'unit', 'uom': 'unit', 'unit of measure': 'unit', 'unit of measurement': 'unit',
    'quantity': 'quantity', 'qty': 'quantity', 'الكمية': 'quantity', 'كمية': 'quantity', 'الكميه': 'quantity',
    'unit price': 'unit_price', 'unit_rate': 'unit_price', 'rate': 'unit_price', 'سعر الوحدة': 'unit_price', 'سعر': 'unit_price', 'السعر': 'unit_price', 'price': 'unit_price',
    'total': 'total_price', 'total price': 'total_price', 'amount': 'total_price', 'الإجمالي': 'total_price', 'الاجمالي': 'total_price', 'الإجمالى': 'total_price', 'total amount': 'total_price', 'قيمة': 'total_price',
    'category': 'category', 'section': 'section', 'القسم': 'section', 'الفئة': 'category',
  };
  return map[h] || h;
}

function parseNumber(val: unknown): number {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/[,\s]/g, '').replace(/[^\d.-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

export async function parseBoqFile(file: File): Promise<ParsedBoqRow[]> {
  const buf = await file.arrayBuffer();
  const ext = file.name.split('.').pop()?.toLowerCase();

  let rows: Record<string, unknown>[] = [];

  if (ext === 'csv' || ext === 'txt') {
    const text = new TextDecoder('utf-8').decode(buf);
    const wb = XLSX.read(text, { type: 'string' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } else {
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  }

  return rows
    .map((row) => {
      const normalized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        normalized[normalizeHeader(k)] = v;
      }
      const code = String(normalized['code'] || '').trim();
      const description = String(normalized['description'] || '').trim();
      if (!code && !description) return null;

      const quantity = parseNumber(normalized['quantity']);
      const unitPrice = parseNumber(normalized['unit_price']);
      const total = parseNumber(normalized['total_price']);
      const computedTotal = quantity * unitPrice;
      const finalTotal = total > 0 ? total : computedTotal;

      return {
        code: code || `ITEM-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        description,
        unit: String(normalized['unit'] || 'قطعة').trim(),
        quantity,
        unit_price: unitPrice,
        total_price: finalTotal,
        category: String(normalized['category'] || '').trim(),
        section: String(normalized['section'] || '').trim(),
      } as ParsedBoqRow;
    })
    .filter((r): r is ParsedBoqRow => r !== null);
}

// Auto-categorize BOQ items based on description keywords
export function categorizeBoqItem(description: string): string {
  const d = description.toLowerCase();
  if (d.includes('excav') || d.includes('حفر') || d.includes('ردم') || d.includes('fill') || d.includes('soil') || d.includes('تربة')) return 'Earthworks';
  if (d.includes('concrete') || d.includes('خرسان') || d.includes('اسمنت') || d.includes('cement')) return 'Concrete Works';
  if (d.includes('rebar') || d.includes('steel') || d.includes('حديد') || d.includes('تسليح')) return 'Reinforcement Steel';
  if (d.includes('block') || d.includes('brick') || d.includes('بلوك') || d.includes('طوب')) return 'Masonry';
  if (d.includes('plaster') || d.includes('بياض') || d.includes('لياسة')) return 'Plastering';
  if (d.includes('paint') || d.includes('دهان') || d.includes('صبغ')) return 'Painting';
  if (d.includes('tile') || d.includes('بلاط') || d.includes('سيراميك') || d.includes('marble') || d.includes('رخام')) return 'Tiling & Flooring';
  if (d.includes('door') || d.includes('window') || d.includes('باب') || d.includes('نافذة') || d.includes('شباك') || d.includes('joinery') || d.includes('carpentry')) return 'Doors & Windows';
  if (d.includes('electrical') || d.includes('كهرب') || d.includes('lighting') || d.includes('إنارة')) return 'Electrical';
  if (d.includes('plumb') || d.includes('plumbing') || d.includes('صحي') || d.includes('مياه') || d.includes('water') || d.includes('drainage') || d.includes('صرف')) return 'Plumbing & Drainage';
  if (d.includes('hvac') || d.includes('تكييف') || d.includes('air condition') || d.includes('ventilation')) return 'HVAC';
  if (d.includes('roof') || d.includes('سقف') || d.includes('عزل') || d.includes('insulat') || d.includes('waterproof')) return 'Roofing & Insulation';
  if (d.includes('foundation') || d.includes('أساس') || d.includes('قاعدة')) return 'Foundations';
  return 'General';
}

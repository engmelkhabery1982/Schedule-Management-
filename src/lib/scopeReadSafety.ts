/** Required collection reads must distinguish unavailable data from a genuinely empty array. */
export function requireScopeRows<T extends { project_id: string }>(
  response: unknown, projectId: string, label: string, baselineId?: string,
): T[] {
  if (!response || typeof response !== 'object') throw new Error(`${label}: invalid response`);
  const result = response as { data?: unknown; error?: { message?: string } | null };
  if (result.error) throw new Error(result.error.message || `${label}: read failed`);
  if (!Array.isArray(result.data)) throw new Error(`${label}: required rows unavailable`);
  if (result.data.some(row => !row || typeof row !== 'object' || row.project_id !== projectId ||
    (baselineId !== undefined && row.baseline_id !== baselineId))) {
    throw new Error(`${label}: foreign or stale scope evidence refused`);
  }
  return result.data as T[];
}

/** Only the optional current-pointer query may legitimately return data:null. */
export function requireScopePointer(response: unknown, projectId: string): { baseline_id: string } | null {
  if (!response || typeof response !== 'object') throw new Error('Scope pointer: invalid response');
  const result = response as { data?: unknown; error?: { message?: string } | null };
  if (result.error) throw new Error(result.error.message || 'Scope pointer: read failed');
  if (result.data === null) return null;
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Scope pointer: unavailable');
  const row = result.data as { project_id?: string; baseline_id?: string };
  if (row.project_id !== projectId || typeof row.baseline_id !== 'string' || !row.baseline_id.trim()) throw new Error('Scope pointer: foreign or invalid baseline');
  return { baseline_id: row.baseline_id };
}

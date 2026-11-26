/** A report is publishable only when every required read completed successfully. */
export function requireReportReads(results: readonly { data: unknown; error?: unknown }[]): void {
  if (results.some((result) => result.error || !Array.isArray(result.data))) {
    throw new Error('Incomplete report reads');
  }
}

/** Cleanup invalidates callbacks, including late errors and finally handlers from an old project. */
export async function runReportRead<T>(
  read: () => Promise<T>,
  isCurrent: () => boolean,
  success: (value: T) => void,
  failure: () => void,
  finish: () => void,
): Promise<void> {
  try {
    const value = await read();
    if (isCurrent()) success(value);
  } catch {
    if (isCurrent()) failure();
  } finally {
    if (isCurrent()) finish();
  }
}

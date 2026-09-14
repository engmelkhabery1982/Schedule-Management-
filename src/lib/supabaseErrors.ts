/**
 * F9 hardening (item 5, error handling): supabase-js reports ordinary query failures through the
 * resolved `{ error }` object rather than by throwing — awaiting a write alone cannot detect an RLS
 * rejection, a constraint violation, or a schema mismatch, so a failed save would be reported to
 * the user as a success and the flow would continue past it.
 *
 * Critical write paths gate on this helper: the first failed statement throws with a meaningful,
 * named context, the surrounding handler catch surfaces it, and no success message is produced.
 * Multi-step flows stay sequential (no transaction redesign — that would expand scope), but a
 * failure now stops the chain and tells the user which step failed, so partial state is never
 * presented as a completed save.
 */
export function assertDbWriteOk<T extends { error?: { message?: string } | null }>(
  result: T,
  context: string,
): T {
  const err = result?.error;
  if (err) {
    throw new Error(`${context}: ${err.message || 'unknown database error'}`);
  }
  return result;
}

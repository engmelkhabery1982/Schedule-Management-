/**
 * Governed project-controls constants — the single source of truth for policy values that must
 * never be re-hardcoded inside an engine or a view.
 *
 * Wave 2 (GAP-004) establishes the governed default Data Date here so the central EVM path has
 * exactly one fallback instead of a hardcoded literal. Other modules still carry their own local
 * copies of this date (`src/lib/mockSeed.ts` and a number of views); those are tracked as separate
 * consumer-migration GAPs and must import from here when they are addressed.
 *
 * Do not add a second copy of any constant defined in this file.
 */

/**
 * Governed default Data Date (status date) for project-controls calculations.
 *
 * Resolution order inside the canonical EVM engine is:
 *
 *   explicit `overrideDataDate`  ->  `project.data_date`  ->  `DEFAULT_DATA_DATE`
 *
 * The value matches the reconciled seed baseline (`defaultDataDate` in `src/lib/mockSeed.ts`) and
 * the chronological-validity invariant documented in AGENTS.md §7: no actual or progress record
 * may be dated after the data date.
 */
export const DEFAULT_DATA_DATE = '2026-09-13';

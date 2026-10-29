/**
 * Scry's judgement now lives in `src/shared/scry-report.ts`, because the mobile
 * build runs the same report over what a page can see about itself. Desktop
 * callers keep this path: it is the capture pipeline's own import, and the
 * desktop is still the only place response headers can be read.
 */
export { buildReport, isTrackerHost, type ReconInput } from '../../shared/scry-report'

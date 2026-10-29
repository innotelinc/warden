/**
 * Scry on a phone: what the page says about itself, judged by the same rules the
 * desktop uses.
 *
 * The capture arrives as JSON text from the native surface and goes through
 * `@shared/scry-report`, so a tracker host, a framework signature or a missing
 * security header means exactly what it means in the desktop report. Two notes
 * are added here because they are properties of *this* capture:
 *
 * - a request the blocker refused never reached the page, so it cannot appear in
 *   the report; the counts are a lower bound, not a measurement of the site;
 * - response headers are not visible from inside a page, which the report says
 *   rather than reporting every security header as missing.
 */
import { buildReport, type ReconInput } from '@shared/scry-report'
import type { ScryReport } from '@shared/types'
import type { MobileCapture } from './capture'

export interface ScryOutcome {
  report: ScryReport | null
  error: string | null
}

const MINIMUM_FIELDS = ['finalUrl', 'requests', 'resources', 'forms'] as const

export function reportFromCapture(captureJson: string): ScryOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(captureJson)
  } catch {
    return { report: null, error: 'The page returned something that is not a capture.' }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { report: null, error: 'The page returned nothing to read.' }
  }

  const candidate = parsed as Partial<MobileCapture> & { error?: string }
  if (typeof candidate.error === 'string') {
    return { report: null, error: candidate.error }
  }
  for (const field of MINIMUM_FIELDS) {
    if (!(field in candidate)) {
      return { report: null, error: 'The capture is missing what a report needs.' }
    }
  }

  const capture = candidate as MobileCapture
  const report = buildReport(capture as unknown as ReconInput)
  report.notes.unshift(
    'Read inside the page, so a request the blocker refused never appears here: these are the third parties that got through, not every one the site calls.'
  )
  if (capture.htmlTruncated) {
    report.notes.push(
      'The markup was cut at 120 KB before analysis, so a signature near the end of a very large document may be missing.'
    )
  }
  return { report, error: null }
}

/** The one line a report should be reducible to, for a card that is not open. */
export function summarise(report: ScryReport): string {
  const parts = [
    `${report.requests} request${report.requests === 1 ? '' : 's'}`,
    `${report.thirdParties.length} third part${report.thirdParties.length === 1 ? 'y' : 'ies'}`,
    `${report.trackers.length} tracker${report.trackers.length === 1 ? '' : 's'}`
  ]
  return parts.join(' · ')
}

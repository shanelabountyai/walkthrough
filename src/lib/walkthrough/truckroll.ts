// The Truckroll link-out (Phase 4). Truckroll (#24) is the dispatch side; this builds a link from data Walkthrough
// already holds — the org slug and the inspection's day — to the same day in Truckroll. Truckroll's routes
// (shanelabountyai/truckroll, read only): `/o/<slug>/dispatch?date=YYYY-MM-DD` is the dispatcher board, and it sends a
// technician on to `/o/<slug>/dispatch/my-day?date=…`; days are America/Chicago calendar days (Truckroll D-27). Pure.

/**
 * Where Truckroll runs. Its local port is 7800 (Truckroll PRD). The env schema is template-owned, so a deployed
 * base URL is a constant here until the template grows a clone env hook (D-33).
 */
export const TRUCKROLL_URL = 'http://localhost:7800';
export const TRUCKROLL_TIME_ZONE = 'America/Chicago';

/** The calendar day of `at` in Truckroll's time zone, as YYYY-MM-DD. */
export function truckrollDay(at: Date, timeZone = TRUCKROLL_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** The Truckroll day board for the inspection's org and day (the day the inspection was created, D-33). */
export function truckrollLink(slug: string, at: Date, base = TRUCKROLL_URL): string {
  return `${base.replace(/\/+$/, '')}/o/${encodeURIComponent(slug)}/dispatch?date=${truckrollDay(at)}`;
}

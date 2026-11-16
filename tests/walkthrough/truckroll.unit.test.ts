import { describe, expect, it } from 'vitest';
import { TRUCKROLL_URL, truckrollDay, truckrollLink } from '@/lib/walkthrough/truckroll';

// C10: the link-out matches Truckroll's routes (/o/<slug>/dispatch?date=YYYY-MM-DD, America/Chicago days, D-27 there).
describe('Truckroll link-out', () => {
  it('points at the org day board on Truckroll', () => {
    expect(truckrollLink('acme', new Date('2026-11-16T15:00:00Z'))).toBe(`${TRUCKROLL_URL}/o/acme/dispatch?date=2026-11-16`);
    expect(truckrollLink('a b', new Date('2026-11-16T15:00:00Z'), 'https://truckroll.example/')).toBe('https://truckroll.example/o/a%20b/dispatch?date=2026-11-16');
  });

  it('uses the Chicago calendar day, not UTC', () => {
    expect(truckrollDay(new Date('2026-11-17T03:30:00Z'))).toBe('2026-11-16'); // 21:30 CST the day before
    expect(truckrollDay(new Date('2026-07-01T04:59:00Z'))).toBe('2026-06-30'); // 23:59 CDT
    expect(truckrollDay(new Date('2026-07-01T05:00:00Z'))).toBe('2026-07-01');
  });
});

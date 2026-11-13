import { describe, expect, it } from 'vitest';
import { reportDates } from './report-dates';

describe('shop report periods', () => {
  const now = new Date('2026-10-21T22:30:00Z');
  it('uses the Nairobi calendar date across UTC midnight', () => {
    expect(reportDates('today', 'Africa/Nairobi', now)).toEqual({ from: '2026-10-22', to: '2026-10-22' });
  });
  it('includes today in seven calendar days across a month boundary', () => {
    expect(reportDates('week', 'Africa/Nairobi', new Date('2026-03-02T10:00:00Z'))).toEqual({ from: '2026-02-24', to: '2026-03-02' });
  });
  it('starts this month on the first in the business timezone', () => {
    expect(reportDates('month', 'Africa/Nairobi', now)).toEqual({ from: '2026-10-01', to: '2026-10-22' });
  });
  it('keeps all-time reporting unbounded', () => {
    expect(reportDates('all', 'Africa/Nairobi', now)).toEqual({ from: '', to: '' });
  });
});

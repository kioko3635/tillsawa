export type ReportPeriod = 'today' | 'week' | 'month' | 'all';

export function reportDates(period: ReportPeriod, timezone: string, now = new Date()) {
  if (period === 'all') return { from: '', to: '' };
  const to = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const date = new Date(`${to}T12:00:00Z`);
  if (period === 'week') date.setUTCDate(date.getUTCDate() - 6);
  if (period === 'month') date.setUTCDate(1);
  return { from: date.toISOString().slice(0, 10), to };
}

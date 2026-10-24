/**
 * Event calendar: school holidays and festivals (fictional) that shape crowd profiles and campaign triggers.
 */

export interface CalendarDay {
  date: string;
  schoolHoliday: boolean;
  /** Festival name when the date is a festival day. */
  festival: string | null;
}

interface Period {
  from: string;
  to: string;
  name: string;
}

export const SCHOOL_HOLIDAYS: readonly Period[] = [
  { from: '2026-07-01', to: '2026-08-31', name: 'Summer break' },
  { from: '2026-10-16', to: '2026-10-25', name: 'Autumn mid-term break' },
  { from: '2026-12-19', to: '2027-01-04', name: 'Winter break' },
];

export const FESTIVALS: readonly Period[] = [
  { from: '2026-10-16', to: '2026-10-18', name: 'Meridian Lantern Festival' },
  { from: '2026-12-24', to: '2026-12-26', name: 'Winter Lights' },
];

const within = (date: string, p: Period) => date >= p.from && date <= p.to;

export function calendarDay(date: string): CalendarDay {
  return {
    date,
    schoolHoliday: SCHOOL_HOLIDAYS.some((p) => within(date, p)),
    festival: FESTIVALS.find((p) => within(date, p))?.name ?? null,
  };
}

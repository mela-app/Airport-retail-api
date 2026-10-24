/**
 * Airport time. Instants are stored and exchanged in UTC; the UI and schedule rules use the airport's
 * local time, a fixed UTC offset (the airport is fictional, so it has no IANA zone).
 */

/** Default airport UTC offset in minutes (+04:00). Overridable with AIRPORT_UTC_OFFSET_MINUTES. */
export const DEFAULT_UTC_OFFSET_MINUTES = 240;

export interface LocalParts {
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  isoWeekday: number;
  hour: number;
  minute: number;
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
}

export function toLocal(instant: Date | string, offsetMinutes = DEFAULT_UTC_OFFSET_MINUTES): LocalParts {
  const ms = (typeof instant === 'string' ? Date.parse(instant) : instant.getTime()) + offsetMinutes * 60_000;
  const d = new Date(ms);
  const day = d.getUTCDay();
  return {
    isoWeekday: day === 0 ? 7 : day,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    date: d.toISOString().slice(0, 10),
  };
}

/** The UTC instant of a local wall-clock time on a local date. */
export function localToUtc(
  date: string,
  hour: number,
  minute: number,
  offsetMinutes = DEFAULT_UTC_OFFSET_MINUTES,
): Date {
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + (hour * 60 + minute - offsetMinutes) * 60_000);
}

/** Format an offset as `+04:00`. */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** ISO string without milliseconds, as the AODB writes it: `2026-10-14T00:10:00Z`. */
export function isoMinute(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

/** Floor an instant to the start of its window of `minutes` (5-minute presence windows, hourly slots…). */
export function floorTo(d: Date, minutes: number): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

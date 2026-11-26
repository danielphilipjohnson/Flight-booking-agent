export interface ParsedDate {
  date: Date;
  iso: string;
}

export function parseIsoDate(value: string): ParsedDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return { date, iso: value };
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dayStartUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function dayEndUtc(iso: string): Date {
  return new Date(dayStartUtc(iso).getTime() + 86_400_000);
}

export function addDays(iso: string, days: number): string {
  return isoDay(new Date(dayStartUtc(iso).getTime() + days * 86_400_000));
}

export function hhmmUtc(date: Date): string {
  return date.toISOString().slice(11, 16);
}

export function parseHhmm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

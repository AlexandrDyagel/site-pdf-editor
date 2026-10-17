/**
 * Утилиты форматирования даты и времени (локаль ru-RU).
 */

const DATE_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat('ru-RU', { numeric: 'auto' });

/** Текущая дата-время в ISO-8601 (UTC). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Безопасный разбор даты. */
export function parseDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Дата в формате 31.12.2025. */
export function formatDate(value: string | number | Date | null | undefined): string {
  const date = parseDate(value);
  return date ? DATE_FORMATTER.format(date) : '—';
}

/** Дата и время в формате 31.12.2025, 23:59. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = parseDate(value);
  return date ? DATE_TIME_FORMATTER.format(date) : '—';
}

/** Время в формате 23:59:59. */
export function formatTime(value: string | number | Date | null | undefined): string {
  const date = parseDate(value);
  return date ? TIME_FORMATTER.format(date) : '—';
}

/** Относительное время: «5 минут назад». */
export function formatRelative(value: string | number | Date | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '—';
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 60) return RELATIVE_FORMATTER.format(diffSeconds, 'second');
  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) return RELATIVE_FORMATTER.format(diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return RELATIVE_FORMATTER.format(diffHours, 'hour');
  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 30) return RELATIVE_FORMATTER.format(diffDays, 'day');
  const diffMonths = Math.round(diffDays / 30);
  if (Math.abs(diffMonths) < 12) return RELATIVE_FORMATTER.format(diffMonths, 'month');
  return RELATIVE_FORMATTER.format(Math.round(diffMonths / 12), 'year');
}

/** Метка времени для имени файла: 2025-12-31_2359. */
export function fileTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`;
}

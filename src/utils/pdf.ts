/**
 * Утилиты для PDF: цвета, ошибки, размеры, служебные проверки.
 */

import { normalizePdfRotation } from '@/utils/coordinates';
import { clamp } from '@/utils/geometry';

/** RGB в диапазоне 0..1 (формат pdf-lib). */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** HEX (#rgb / #rrggbb / #rrggbbaa) → RGB 0..1. */
export function hexToRgb(hex: string): RgbColor {
  let value = (hex || '#000000').trim().replace(/^#/, '');
  if (value.length === 3) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (value.length === 8) value = value.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(value)) value = '000000';
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255,
  };
}

/** RGB 0..1 → HEX. */
export function rgbToHex(color: RgbColor): string {
  const toHex = (v: number): string =>
    Math.round(clamp(v, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

/** Яркость цвета 0..1 (для выбора контрастного текста). */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Контрастный цвет (чёрный/белый) для фона. */
export function contrastColor(hex: string): '#000000' | '#ffffff' {
  return luminance(hex) > 0.55 ? '#000000' : '#ffffff';
}

/** Цвет с прозрачностью → rgba(). */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${clamp(
    alpha,
    0,
    1,
  )})`;
}

/** Признак «светлого» цвета. */
export function isLightColor(hex: string): boolean {
  return luminance(hex) > 0.6;
}

/* ==========================================================================
 *  Размеры
 * ========================================================================== */

/** Размер страницы для отображения с учётом /Rotate. */
export function displayPageSize(
  width: number,
  height: number,
  rotation: number,
): { width: number; height: number } {
  const angle = normalizePdfRotation(rotation);
  return angle === 90 || angle === 270 ? { width: height, height: width } : { width, height };
}

/** Форматирование размера в мм (для панели свойств страницы). */
export function ptToMm(pt: number): number {
  return (pt / 72) * 25.4;
}

/** мм → pt. */
export function mmToPt(mm: number): number {
  return (mm / 25.4) * 72;
}

/** Человекочитаемый размер страницы: «210 × 297 мм (A4)». */
export function describePageSize(width: number, height: number): string {
  const w = Math.round(ptToMm(width));
  const h = Math.round(ptToMm(height));
  return `${w} × ${h} мм`;
}

/* ==========================================================================
 *  Ошибки pdf.js / pdf-lib
 * ========================================================================== */

/** Признак ошибки «требуется пароль». */
export function isPasswordError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    name === 'PasswordException' ||
    /password/i.test(message) ||
    /пароль/i.test(message)
  );
}

/** Признак повреждённого/некорректного PDF. */
export function isInvalidPdfError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    name === 'InvalidPDFException' ||
    name === 'FormatError' ||
    /invalid pdf/i.test(message) ||
    /InvalidPDF/i.test(message)
  );
}

/** Человекочитаемое описание ошибки загрузки PDF. */
export function describePdfError(error: unknown): string {
  if (isPasswordError(error)) {
    return 'Документ защищён паролем. Введите пароль, чтобы открыть его.';
  }
  if (isInvalidPdfError(error)) {
    return 'Файл повреждён или не является PDF-документом.';
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/worker/i.test(message)) {
    return 'Не удалось запустить модуль отрисовки PDF (worker). Перезагрузите страницу.';
  }
  if (/out of memory|allocation/i.test(message)) {
    return 'Недостаточно памяти для обработки документа. Попробуйте файл меньшего размера.';
  }
  return message || 'Не удалось открыть документ.';
}

/* ==========================================================================
 *  Прочее
 * ========================================================================== */

/** MIME-тип PDF. */
export const PDF_MIME = 'application/pdf';

/** Проверка сигнатуры PDF (%PDF-). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  return (
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
  );
}

/** Проверка, что файл похож на PDF (по расширению/mime/сигнатуре). */
export async function isPdfFile(file: File): Promise<boolean> {
  if (file.type === PDF_MIME) return true;
  if (/\.pdf$/i.test(file.name)) return true;
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return looksLikePdf(head);
}

/** Ключевые слова из строки, разделённой запятыми/точками с запятой. */
export function parseKeywords(value: string): string[] {
  return value
    .split(/[,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Обрезка имени файла для отображения. */
export function shortenFileName(name: string, max = 42): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const base = dot > 0 ? name.slice(0, dot) : name;
  const keep = Math.max(4, max - ext.length - 1);
  return `${base.slice(0, keep)}…${ext}`;
}

/**
 * Эвристическое определение шифрования PDF: поиск ключа /Encrypt
 * в хвосте файла, где расположен trailer. Используется только для
 * предупреждения пользователя (встроенный JS не выполняется).
 */
export function detectPdfEncryption(bytes: Uint8Array): boolean {
  const tailLength = Math.min(bytes.length, 4096);
  if (tailLength <= 0) return false;
  const decoder = new TextDecoder('latin1');
  const tail = decoder.decode(bytes.subarray(bytes.length - tailLength));
  return /\/Encrypt\b/.test(tail);
}

/**
 * ============================================================================
 *  Кодировки. Критически важный модуль: кириллица не должна превращаться
 *  в «кракозябры» ни в интерфейсе, ни при импорте, ни при экспорте.
 * ============================================================================
 *
 *  Поддерживается чтение текстовых файлов в кодировках:
 *    - UTF-8 (с BOM и без);
 *    - windows-1251 (cp1251);
 *    - koi8-r;
 *    - windows-1252 / iso-8859-1 (fallback).
 */

/** Поддерживаемые кодировки ввода. */
export const INPUT_ENCODINGS = ['utf-8', 'windows-1251', 'koi8-r', 'windows-1252'] as const;
export type InputEncoding = (typeof INPUT_ENCODINGS)[number];

/** UTF-8 BOM. */
export const UTF8_BOM = '\uFEFF';

/** Текстовая кодировка → метка для TextDecoder. */
const DECODER_LABELS: Record<InputEncoding, string> = {
  'utf-8': 'utf-8',
  'windows-1251': 'windows-1251',
  'koi8-r': 'koi8-r',
  'windows-1252': 'windows-1252',
};

/** Проверка наличия BOM UTF-8 в начале буфера. */
export function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/** Кодирование строки в UTF-8 байты. */
export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Декодирование UTF-8 байтов (никогда не бросает исключение). */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Декодирование байтов в указанной кодировке. */
export function decodeWithEncoding(bytes: Uint8Array, encoding: InputEncoding): string {
  const label = DECODER_LABELS[encoding] ?? 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return decodeUtf8(bytes);
  }
}

/**
 * Эвристическое определение кодировки русскоязычного текста.
 *
 * Логика:
 *  1. BOM UTF-8 → utf-8.
 *  2. Пробуем строгий UTF-8 (fatal): если получилось — это UTF-8.
 *  3. Иначе считаем «мусорные» символы и аномалии регистра для windows-1251,
 *     koi8-r и windows-1252 и выбираем вариант с лучшим счётом.
 *
 *  Аномалии регистра — ключевой признак: при неверной кодировке вместо
 *  «Привет» получается «рТЙЧЕФ» — строчная буква чередуется с прописными.
 */
export function detectEncoding(bytes: Uint8Array): InputEncoding {
  if (hasUtf8Bom(bytes)) return 'utf-8';
  // Пустой или почти пустой файл.
  if (bytes.length === 0) return 'utf-8';

  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return 'utf-8';
  } catch {
    /* не UTF-8 — продолжаем */
  }

  const score = (encoding: InputEncoding): number => {
    const text = decodeWithEncoding(sample, encoding);
    let bad = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 0xfffd) bad += 5; // символ замены
      else if (code === 0) bad += 5;
      else if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) bad += 2;
      // Управляющие символы C1 — типичный признак неверной кодировки.
      else if (code >= 0x80 && code <= 0x9f) bad += 2;
    }

    // Аномалии регистра внутри слов: «рТЙЧЕФ» вместо «Привет».
    const caseAnomalies = (text.match(/[а-яё][А-ЯЁ]/g) ?? []).length;
    const letters = (text.match(/[А-Яа-яЁё]/g) ?? []).length;
    const uppercase = (text.match(/[А-ЯЁ]/g) ?? []).length;
    const uppercasePenalty = letters > 6 && uppercase / letters > 0.6 ? 4 : 0;

    // Бонус за частые русские биграммы.
    const commonBigrams = (
      text.toLowerCase().match(/(ст|но|то|на|ен|ов|ни|ра|во|ко|по|ро|ос|го|ер|ре|пр|ал|ли|от)/g) ?? []
    ).length;

    return bad * 5 + caseAnomalies * 3 + uppercasePenalty - commonBigrams * 0.35;
  };

  const candidates: InputEncoding[] = ['windows-1251', 'koi8-r', 'windows-1252'];
  let best: InputEncoding = 'windows-1251';
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const value = score(candidate);
    if (value < bestScore) {
      bestScore = value;
      best = candidate;
    }
  }
  return best;
}

/** Декодирование с автоопределением кодировки. */
export function decodeAuto(bytes: Uint8Array): { text: string; encoding: InputEncoding } {
  const encoding = detectEncoding(bytes);
  let view = bytes;
  if (encoding === 'utf-8' && hasUtf8Bom(bytes)) view = bytes.subarray(3);
  return { text: decodeWithEncoding(view, encoding), encoding };
}

/** Убирает BOM из строки. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Нормализация переводов строк к \n. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/* ==========================================================================
 *  Имена файлов
 * ========================================================================== */

/** Убирает из имени файла символы, недопустимые в Windows/macOS/Linux. */
export function sanitizeFileName(name: string, fallback = 'file'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : fallback;
}

/** Разбирает имя файла на базу и расширение. */
export function splitFileName(name: string): { base: string; ext: string } {
  const safe = sanitizeFileName(name);
  const dot = safe.lastIndexOf('.');
  if (dot <= 0) return { base: safe, ext: '' };
  return { base: safe.slice(0, dot), ext: safe.slice(dot + 1).toLowerCase() };
}

/** Формирует имя файла с корректным расширением. */
export function withExtension(name: string, ext: string): string {
  const { base } = splitFileName(name);
  const cleanExt = ext.replace(/^\./, '');
  return `${base}.${cleanExt}`;
}

/**
 * Значение `filename*` для заголовка Content-Disposition (RFC 5987)
 * в кодировке UTF-8 — нужно для серверной отдачи файлов с русскими именами.
 */
export function contentDispositionFilename(fileName: string): string {
  const ascii = sanitizeFileName(fileName).replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/* ==========================================================================
 *  CSV / TXT / JSON
 * ========================================================================== */

/** Экранирование значения для CSV (RFC 4180). */
export function csvEscape(value: unknown, delimiter = ';'): string {
  const text = value === null || value === undefined ? '' : String(value);
  const needsQuotes =
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text.includes(delimiter) ||
    /^\s|\s$/.test(text);
  const escaped = text.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

/**
 * Формирование CSV с BOM UTF-8 — так Excel корректно открывает кириллицу.
 */
export function buildCsv(rows: readonly (readonly unknown[])[], delimiter = ';'): string {
  const body = rows.map((row) => row.map((cell) => csvEscape(cell, delimiter)).join(delimiter));
  return `${UTF8_BOM}${body.join('\r\n')}\r\n`;
}

/** Формирование TXT с BOM UTF-8. */
export function buildTxt(text: string, withBom = true): string {
  return withBom ? `${UTF8_BOM}${text}` : text;
}

/** JSON с отступами (UTF-8, без экранирования кириллицы). */
export function buildJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Безопасный разбор JSON с понятной ошибкой. */
export function parseJson<T>(text: string): T {
  try {
    return JSON.parse(stripBom(text)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Некорректный JSON: ${message}`);
  }
}

/* ==========================================================================
 *  PDF-строки
 * ========================================================================== */

/**
 * Кодирование строки для PDF-строки с не-ASCII символами:
 * UTF-16BE с BOM в виде hex-строки (<FEFF...>). Используется как справочная
 * утилита (pdf-lib делает это автоматически для метаданных).
 */
export function utf16BeHex(text: string): string {
  const out = ['FEFF'];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0xffff) {
      const high = 0xd800 + ((code - 0x10000) >> 10);
      const low = 0xdc00 + ((code - 0x10000) & 0x3ff);
      out.push(high.toString(16).toUpperCase().padStart(4, '0'));
      out.push(low.toString(16).toUpperCase().padStart(4, '0'));
    } else {
      out.push(code.toString(16).toUpperCase().padStart(4, '0'));
    }
  }
  return out.join('');
}

/** Признак наличия не-ASCII символов (нужно встраивание шрифта). */
export function hasNonAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

/** Только кириллица (проверка перед экспортом). */
export function hasCyrillic(text: string): boolean {
  return /[А-Яа-яЁёІіЇїЄєҐґ]/.test(text);
}

/** Уникальные символы строки (для проверки покрытия глифов). */
export function uniqueChars(text: string): string[] {
  return Array.from(new Set(Array.from(text))).filter((ch) => ch !== '\n' && ch !== '\r' && ch !== '\t');
}

/* ==========================================================================
 *  Base64 / Base64URL
 * ========================================================================== */

/** Uint8Array → base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → Uint8Array. */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Uint8Array → data:URL. */
export function bytesToDataUrl(bytes: Uint8Array, mime = 'application/octet-stream'): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** data:URL → Uint8Array. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  return base64ToBytes(dataUrl);
}

/** MIME-тип из data:URL. */
export function dataUrlMime(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl);
  return match ? match[1] : 'application/octet-stream';
}

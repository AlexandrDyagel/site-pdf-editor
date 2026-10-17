/**
 * Утилиты для имён файлов и документов.
 */

import { sanitizeFileName, splitFileName } from '@/utils/encoding';
import { fileTimestamp } from '@/utils/date';

/** Базовое имя документа (без расширения). */
export function documentFileName(fileName: string): string {
  if (!fileName) return 'document';
  return splitFileName(sanitizeFileName(fileName)).base || 'document';
}

/** Имя PDF-файла для сохранения: «Документ-аннотированный.pdf». */
export function annotatedPdfName(fileName: string, suffix = 'аннотированный'): string {
  const base = documentFileName(fileName);
  return `${base}-${suffix}.pdf`;
}

/** Имя файла с временной меткой. */
export function timestampedName(base: string, extension: string): string {
  return `${documentFileName(base)}-${fileTimestamp()}.${extension.replace(/^\./, '')}`;
}

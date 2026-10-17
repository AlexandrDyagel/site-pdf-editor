/**
 * Вспомогательные функции экспорта: выбор страниц, масштаб, имена файлов.
 */

import type { ExportSettings, PdfPageState } from '@/types';
import { PT_PER_INCH } from '@/constants';
import { sanitizeFileName, splitFileName, withExtension } from '@/utils/encoding';
import { fileTimestamp } from '@/utils/date';

/** Список выбранных страниц (0-based) с учётом режима диапазона. */
export function resolveSelectedPages(
  settings: ExportSettings,
  totalPages: number,
  currentPage = 0,
): number[] {
  if (totalPages <= 0) return [];
  switch (settings.pageRange) {
    case 'current':
      return [Math.min(Math.max(currentPage, 0), totalPages - 1)];
    case 'custom': {
      const list = settings.pages
        .map((page) => Math.round(page) - 1)
        .filter((index) => index >= 0 && index < totalPages);
      const unique = Array.from(new Set(list)).sort((a, b) => a - b);
      return unique.length > 0 ? unique : [Math.min(currentPage, totalPages - 1)];
    }
    case 'all':
    default:
      return Array.from({ length: totalPages }, (_, index) => index);
  }
}

/**
 * Масштаб экспорта: DPI имеет приоритет над множителем.
 * 72 pt = 1 дюйм, поэтому scale = dpi / 72.
 */
export function resolveExportScale(settings: ExportSettings): number {
  if (settings.dpi && settings.dpi > 0) return settings.dpi / PT_PER_INCH;
  return settings.scale > 0 ? settings.scale : 1;
}

/** Человекочитаемое описание выбранных страниц. */
export function describeSelectedPages(
  pages: number[],
  total: number,
): string {
  if (pages.length === 0) return 'нет страниц';
  if (pages.length === total) return `все страницы (${total})`;
  if (pages.length === 1) return `страница ${pages[0] + 1}`;
  return `страниц: ${pages.length}`;
}

/** Имя файла для экспорта. */
export function buildExportFileName(
  settings: ExportSettings,
  extension: string,
  options: { pageLabel?: string; withTimestamp?: boolean } = {},
): string {
  const base = splitFileName(sanitizeFileName(settings.fileName || 'document')).base;
  const suffix = options.pageLabel ? `-${options.pageLabel}` : '';
  const stamp = options.withTimestamp ? `-${fileTimestamp()}` : '';
  return withExtension(`${base}${suffix}${stamp}`, extension);
}

/** Имя страницы для отдельных файлов: page-001. */
export function pageFileLabel(index: number, total: number): string {
  const width = String(total).length;
  return `page-${String(index + 1).padStart(Math.max(3, width), '0')}`;
}

/** Размер страницы в мм для интерфейса. */
export function pagesTotalSize(pages: PdfPageState[]): { width: number; height: number } {
  if (pages.length === 0) return { width: 0, height: 0 };
  return {
    width: Math.round(pages[0].displayWidth),
    height: Math.round(pages[0].displayHeight),
  };
}

/** MIME-тип для формата экспорта изображений. */
export function imageMimeFor(format: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'png':
    default:
      return 'image/png';
  }
}

/** Расширение файла для формата экспорта. */
export function extensionFor(format: string): string {
  switch (format) {
    case 'jpeg':
      return 'jpg';
    case 'webp':
      return 'webp';
    case 'docx':
      return 'docx';
    case 'json':
      return 'json';
    case 'svg':
      return 'svg';
    case 'pdf':
    case 'pdf-flat':
      return 'pdf';
    case 'library':
      return 'json';
    case 'png':
    default:
      return 'png';
  }
}

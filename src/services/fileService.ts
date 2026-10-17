/**
 * Сервис работы с файлами: диалоги выбора, чтение в нужной кодировке,
 * проверки и предупреждения.
 */

import type { InputEncoding } from '@/utils/encoding';
import { decodeAuto } from '@/utils/encoding';
import { prepareImageFile, type PreparedImage } from '@/utils/image';
import { isPdfFile, PDF_MIME } from '@/utils/pdf';
import { formatBytes } from '@/utils/download';

/** Параметры диалога выбора файла. */
export interface FileDialogOptions {
  accept?: string;
  multiple?: boolean;
  capture?: 'user' | 'environment';
}

/** Открывает системный диалог выбора файлов. */
export function openFileDialog(options: FileDialogOptions = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = options.accept ?? '';
    input.multiple = Boolean(options.multiple);
    if (options.capture) input.capture = options.capture;
    input.style.display = 'none';
    document.body.appendChild(input);
    let resolved = false;
    const finish = (files: File[]): void => {
      if (resolved) return;
      resolved = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => {
      finish(input.files ? Array.from(input.files) : []);
    });
    // Отмена выбора в некоторых браузерах не даёт события change.
    window.addEventListener(
      'focus',
      () => {
        window.setTimeout(() => {
          if (!input.files || input.files.length === 0) finish([]);
        }, 400);
      },
      { once: true },
    );
    input.click();
  });
}

/** Прочитанный PDF-файл. */
export interface ReadPdfResult {
  bytes: Uint8Array;
  name: string;
  size: number;
}

/** Чтение PDF-файла в байты (с проверкой сигнатуры). */
export async function readPdfFile(file: File): Promise<ReadPdfResult> {
  if (!(await isPdfFile(file))) {
    throw new Error('Файл не является PDF-документом. Выберите файл с расширением .pdf');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('Файл пустой (0 байт)');
  return { bytes, name: file.name, size: file.size };
}

/** Чтение текстового файла с автоопределением кодировки. */
export async function readTextFileAuto(
  file: File,
): Promise<{ text: string; encoding: InputEncoding }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return decodeAuto(bytes);
}

/** Чтение изображения с подготовкой (уменьшение, конвертация SVG). */
export async function readImageFile(file: File): Promise<PreparedImage> {
  return prepareImageFile(file);
}

/** Чтение нескольких изображений. */
export async function readImageFiles(files: readonly File[]): Promise<PreparedImage[]> {
  const result: PreparedImage[] = [];
  for (const file of files) {
    try {
      result.push(await prepareImageFile(file));
    } catch {
      /* пропускаем неподдерживаемые файлы */
    }
  }
  return result;
}

/** Чтение JSON-файла. */
export async function readJsonFile<T>(file: File): Promise<T> {
  const text = await file.text();
  return JSON.parse(text) as T;
}

/** Проверка размера файла и формирование предупреждения. */
export function warnIfLarge(
  size: number,
  thresholdMb: number,
  warnEnabled: boolean,
): string | null {
  if (!warnEnabled) return null;
  const threshold = thresholdMb * 1024 * 1024;
  if (size <= threshold) return null;
  return `Файл большой (${formatBytes(size)}). Обработка может занять время, а браузеру может не хватить памяти.`;
}

/** MIME-типы, которые принимает приложение. */
export const ACCEPT = {
  pdf: PDF_MIME,
  images: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml',
  fonts: '.ttf,.otf,font/ttf,font/otf',
  project: 'application/json,.json',
  library: 'application/json,.json',
} as const;

/** Человекочитаемая подпись для accept. */
export function describeAccept(accept: string): string {
  if (accept === ACCEPT.pdf) return 'PDF-документы';
  if (accept === ACCEPT.images) return 'Изображения';
  if (accept === ACCEPT.fonts) return 'Шрифты TTF/OTF';
  if (accept === ACCEPT.project || accept === ACCEPT.library) return 'JSON-файлы';
  return 'Файлы';
}

/** Освобождение object URL (для аккуратной работы с памятью). */
export function revokeUrl(url: string | null | undefined): void {
  if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
}

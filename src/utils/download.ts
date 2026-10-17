/**
 * Скачивание файлов и работа с Blob/URL.
 *
 * Все имена файлов проходят через `sanitizeFileName`, поэтому кириллица в
 * названиях сохраняется корректно (Blob + <a download> — UTF-8 по стандарту).
 */

import { decodeAuto, sanitizeFileName } from '@/utils/encoding';

/** Скачивает Blob под указанным именем. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, fileName);
  // Освобождаем память после начала скачивания.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Скачивает данные по уже созданному object URL. */
export function downloadUrl(url: string, fileName: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = sanitizeFileName(fileName);
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** Скачивает текстовый файл в UTF-8 (BOM опционально). */
export function downloadText(
  text: string,
  fileName: string,
  mime = 'text/plain;charset=utf-8',
): void {
  downloadBlob(new Blob([text], { type: mime }), fileName);
}

/** Скачивает JSON-файл. */
export function downloadJson(data: unknown, fileName: string): void {
  downloadText(JSON.stringify(data, null, 2), fileName, 'application/json;charset=utf-8');
}

/** Скачивает бинарные данные. */
export function downloadBytes(
  bytes: Uint8Array,
  fileName: string,
  mime = 'application/octet-stream',
): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  downloadBlob(new Blob([copy.buffer as ArrayBuffer], { type: mime }), fileName);
}

/** data:URL → Blob. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, payload = ''] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(header)?.[1] ?? 'application/octet-stream';
  if (header.includes(';base64')) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes.buffer as ArrayBuffer], { type: mime });
  }
  return new Blob([decodeURIComponent(payload)], { type: mime });
}

/** Blob → data:URL (UTF-8-safe для текста). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(blob);
  });
}

/** Blob → ArrayBuffer. */
export function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Blob → текст с автоопределением кодировки (UTF-8/1251/KOI8-R). */
export async function blobToTextAuto(blob: Blob): Promise<string> {
  const buffer = await blobToArrayBuffer(blob);
  return decodeAuto(new Uint8Array(buffer)).text;
}

/** Canvas → Blob (PNG/JPEG/WebP). */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime = 'image/png',
  quality = 0.92,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`Браузер не смог создать изображение ${mime}`));
      },
      mime,
      quality,
    );
  });
}

/** Canvas → data:URL. */
export function canvasToDataUrl(
  canvas: HTMLCanvasElement,
  mime = 'image/png',
  quality = 0.92,
): string {
  return canvas.toDataURL(mime, quality);
}

/** Форматирование размера файла. */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : fractionDigits)} ${units[index]}`;
}

/**
 * «Умный корректор»: маска, которая закрашивает только светлые участки.
 *
 * Зачем нужен растр: эффект «закрасить светлое, не тронув тёмное» — это
 * попиксельное условие, которого нет ни в canvas-блендах, ни в pdf-lib.
 * Поэтому для штриха строится картинка: берём участок страницы под штрихом,
 * оставляем только пиксели светлее порога, остальным даём прозрачность.
 *
 * Координаты: маска живёт в локальной системе объекта (0..width, 0..height),
 * поэтому поворот/масштаб объекта применяются к ней как к обычной картинке.
 */

import type { DrawingPayload, EditorObject, PdfPageState } from '@/types';
import { pdfService } from '@/services/pdfService';
import { paintStrokes } from '@/services/strokeService';
import { extraPageRotation } from '@/utils/coordinates';
import { hexToRgb } from '@/utils/pdf';
import { usePdfStore } from '@/stores/pdf';

/** Запрос маски: объект-рисунок и масштаб растра (1 = 72 dpi). */
export interface SmartMaskRequest {
  object: EditorObject & { payload: DrawingPayload };
  /** Масштаб: 1 — 72 dpi, 4.17 — 300 dpi. */
  scale: number;
  /** Страница (по умолчанию берётся из стора по номеру страницы объекта). */
  page?: PdfPageState | null;
}

const CACHE_LIMIT = 24;
const cache = new Map<string, HTMLCanvasElement>();

/** Небольшой хеш строки (FNV-1a) — для ключей кэша. */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Подпись параметров маски: меняется — маска пересчитывается. */
export function smartMaskKey(object: EditorObject & { payload: DrawingPayload }, scale: number): string {
  const payload = object.payload;
  const strokeSignature = payload.strokes
    .map((stroke) => {
      const first = stroke.points[0];
      const last = stroke.points[stroke.points.length - 1];
      return `${stroke.width}:${stroke.points.length}:${first ? `${first.x.toFixed(0)},${first.y.toFixed(0)}` : ''}:${
        last ? `${last.x.toFixed(0)},${last.y.toFixed(0)}` : ''
      }`;
    })
    .join('|');
  return [
    object.id,
    object.page,
    object.x.toFixed(1),
    object.y.toFixed(1),
    object.width.toFixed(1),
    object.height.toFixed(1),
    object.rotation.toFixed(2),
    object.opacity.toFixed(2),
    payload.smart?.threshold ?? 170,
    payload.smart?.color ?? '#ffffff',
    payload.designWidth.toFixed(1),
    payload.designHeight.toFixed(1),
    strokeSignature,
    scale.toFixed(2),
  ].join('#');
}

/** Достаёт маску из кэша или строит новую. */
export async function getSmartMask(request: SmartMaskRequest): Promise<HTMLCanvasElement | null> {
  const key = smartMaskKey(request.object, request.scale);
  const cached = cache.get(key);
  if (cached) return cached;
  const canvas = await buildSmartMask(request);
  if (!canvas) return null;
  cache.set(key, canvas);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return canvas;
}

/** Сбрасывает кэш (например, при смене документа). */
export function clearSmartMaskCache(): void {
  cache.clear();
}

/** Строит маску: участок страницы ∩ штрихи, только светлые пиксели. */
async function buildSmartMask(request: SmartMaskRequest): Promise<HTMLCanvasElement | null> {
  const { object, scale } = request;
  const page = request.page ?? usePdfStore().pages[object.page] ?? null;
  const payload = object.payload;
  const settings = payload.smart;
  if (!settings) return null;
  if (typeof document === 'undefined') return null;

  const widthPt = Math.max(1, object.width);
  const heightPt = Math.max(1, object.height);
  const pixelWidth = Math.max(1, Math.round(widthPt * scale));
  const pixelHeight = Math.max(1, Math.round(heightPt * scale));

  // 1. Растр страницы в нужном масштабе (та же ориентация, что и подложка).
  const rendered = await pdfService.renderPage(object.page, {
    scale,
    rotation: extraPageRotation(page),
    background: '#ffffff',
  });

  // 2. Переносим участок страницы в локальные координаты объекта.
  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = pixelWidth;
  pageCanvas.height = pixelHeight;
  const pageCtx = pageCanvas.getContext('2d', { willReadFrequently: true });
  if (!pageCtx) return null;

  const radians = (object.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const originX = object.x * scale;
  const originY = object.y * scale;
  pageCtx.setTransform(
    cos,
    -sin,
    sin,
    cos,
    -(cos * originX + sin * originY),
    sin * originX - cos * originY,
  );
  pageCtx.drawImage(rendered.canvas, 0, 0);

  // 3. Форма штрихов (альфа-канал — область закрашивания).
  const shapeCanvas = document.createElement('canvas');
  shapeCanvas.width = pixelWidth;
  shapeCanvas.height = pixelHeight;
  const shapeCtx = shapeCanvas.getContext('2d', { willReadFrequently: true });
  if (!shapeCtx) return null;
  const designWidth = payload.designWidth > 0 ? payload.designWidth : widthPt;
  const designHeight = payload.designHeight > 0 ? payload.designHeight : heightPt;
  // Тот же контур, что и у «чернил»: маска совпадает со штрихом один в один.
  paintStrokes(shapeCtx, payload.strokes, {
    scale: (widthPt / designWidth) * scale,
  });

  // 4. Отбираем светлые пиксели под штрихом и заливаем выбранным цветом.
  const pageData = pageCtx.getImageData(0, 0, pixelWidth, pixelHeight).data;
  const shapeData = shapeCtx.getImageData(0, 0, pixelWidth, pixelHeight).data;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = pixelWidth;
  maskCanvas.height = pixelHeight;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return null;
  const mask = maskCtx.createImageData(pixelWidth, pixelHeight);
  const fill = hexToRgb(settings.color || '#ffffff');
  const red = Math.round(fill.r * 255);
  const green = Math.round(fill.g * 255);
  const blue = Math.round(fill.b * 255);
  const threshold = Math.max(0, Math.min(255, settings.threshold));
  const opacity = Math.max(0, Math.min(1, object.opacity));

  for (let index = 0; index < shapeData.length; index += 4) {
    const coverage = shapeData[index + 3];
    if (coverage === 0) continue;
    const luminance =
      0.299 * pageData[index] + 0.587 * pageData[index + 1] + 0.114 * pageData[index + 2];
    // Тёмный текст под штрихом остаётся нетронутым.
    if (luminance < threshold) continue;
    mask.data[index] = red;
    mask.data[index + 1] = green;
    mask.data[index + 2] = blue;
    mask.data[index + 3] = Math.round((coverage / 255) * opacity * 255);
  }
  maskCtx.putImageData(mask, 0, 0);
  return maskCanvas;
}

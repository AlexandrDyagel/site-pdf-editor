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
    payload.smart?.autoColor === false ? 'manual' : 'auto',
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
  const threshold = Math.max(0, Math.min(255, settings.threshold));
  const opacity = Math.max(0, Math.min(1, object.opacity));

  /**
   * Цвет заливки.
   *
   * По умолчанию берём тон бумаги из-под самого штриха: на сканах бумага почти
   * никогда не чисто-белая, и заливка «белым» оставляла видимый след мазка.
   * Если пользователь выбрал цвет вручную («авто» выключено) — уважаем выбор.
   */
  const autoColor = settings.autoColor !== false;
  let fill = hexToRgb(settings.color || '#ffffff');
  if (autoColor) {
    // Тон бумаги берём по всей странице, а не только под штрихом: иначе один
    // тёмный участок под мазком уводил заливку в грязный цвет. Считаем моду
    // яркости светлых пикселей — это и есть бумага документа.
    const histogram = new Float64Array(256);
    const sumR = new Float64Array(256);
    const sumG = new Float64Array(256);
    const sumB = new Float64Array(256);
    // Шаг 4 пикселя по каждой оси: точности хватает, а считается быстро.
    const strideY = Math.max(1, Math.round(pixelHeight / 400));
    const strideX = Math.max(1, Math.round(pixelWidth / 400));
    for (let y = 0; y < pixelHeight; y += strideY) {
      for (let x = 0; x < pixelWidth; x += strideX) {
        const index = (y * pixelWidth + x) * 4;
        const luminance =
          0.299 * pageData[index] + 0.587 * pageData[index + 1] + 0.114 * pageData[index + 2];
        if (luminance < threshold) continue;
        const bucket = Math.min(255, Math.max(0, Math.round(luminance)));
        histogram[bucket] += 1;
        sumR[bucket] += pageData[index];
        sumG[bucket] += pageData[index + 1];
        sumB[bucket] += pageData[index + 2];
      }
    }
    let best = -1;
    let bestCount = 0;
    for (let bucket = 0; bucket < 256; bucket += 1) {
      if (histogram[bucket] > bestCount) {
        bestCount = histogram[bucket];
        best = bucket;
      }
    }
    if (best >= 0 && bestCount > 0) {
      // Усредняем окрестность моды — сглаживает шум сканирования.
      let count = 0;
      let totalR = 0;
      let totalG = 0;
      let totalB = 0;
      for (let bucket = Math.max(0, best - 6); bucket <= Math.min(255, best + 6); bucket += 1) {
        count += histogram[bucket];
        totalR += sumR[bucket];
        totalG += sumG[bucket];
        totalB += sumB[bucket];
      }
      if (count > 0) {
        fill = { r: totalR / count / 255, g: totalG / count / 255, b: totalB / count / 255 };
      }
    }
  }
  const red = Math.round(fill.r * 255);
  const green = Math.round(fill.g * 255);
  const blue = Math.round(fill.b * 255);
  /**
   * Мягкий переход к порогу.
   *
   * Жёсткий порог оставлял вокруг букв тонкую кайму: сглаженные края глифов
   * (смесь чёрного и белого) попадают между «тёмным» и «светлым» и остаются
   * незакрашенными — в PDF с аннотациями эта кайма видна как обводка. Теперь
   * такие пиксели закрашиваются частично, и граница получается плавной.
   */
  const softness = 55;
  const lowEdge = threshold - softness;

  for (let index = 0; index < shapeData.length; index += 4) {
    const coverage = shapeData[index + 3];
    if (coverage === 0) continue;
    // Цвет заливки пишем во все пиксели под штрихом, включая прозрачные:
    // у частично прозрачного края иначе остаётся чёрный RGB, и в PDF вокруг
    // закрашенной области появляется тёмная кайма.
    mask.data[index] = red;
    mask.data[index + 1] = green;
    mask.data[index + 2] = blue;
    const luminance =
      0.299 * pageData[index] + 0.587 * pageData[index + 1] + 0.114 * pageData[index + 2];
    // Тёмный текст под штрихом остаётся нетронутым (альфа 0 — видно страницу).
    if (luminance <= lowEdge) continue;
    const ramp = Math.min(1, (luminance - lowEdge) / softness);
    mask.data[index + 3] = Math.round((coverage / 255) * opacity * ramp * 255);
  }
  maskCtx.putImageData(mask, 0, 0);
  return maskCanvas;
}

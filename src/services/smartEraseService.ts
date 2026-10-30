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
import { detectTextMask } from '@/services/textDetectionService';
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
    payload.smart?.eraseAll ? 'all' : 'keep',
    payload.smart?.engine ?? 'simple',
    payload.smart?.sensitivity ?? 0,
    payload.smart?.targetColor ?? 'none',
    payload.smart?.colorTolerance ?? 0,
    payload.smart?.fillColor ?? 'paper',
    payload.smart?.eraseColoredOverText === false ? 'keep-ink' : 'erase-ink',
    payload.designWidth.toFixed(1),
    payload.designHeight.toFixed(1),
    strokeSignature,
    scale.toFixed(2),
  ].join('#');
}

/** Достаёт маску из кэша или строит новую. */
/**
 * Сырые RGBA-данные маски, которые нельзя получить обратно из canvas:
 * у полностью прозрачных пикселей хранилище canvas обнуляет цвет.
 */
const maskPixels = new WeakMap<HTMLCanvasElement, ImageData>();

/** RGBA-данные маски (для точного PNG без потери цвета в прозрачных пикселях). */
export function getSmartMaskPixels(canvas: HTMLCanvasElement): ImageData | null {
  return maskPixels.get(canvas) ?? null;
}

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

/** #rrggbb → { r, g, b } (0–255) или null. */
function parseHexColor(value: string | null): { r: number; g: number; b: number } | null {
  if (!value) return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/** Строит маску: участок страницы ∩ штрихи, только светлые пиксели. */
async function buildSmartMask(request: SmartMaskRequest): Promise<HTMLCanvasElement | null> {
  const { object } = request;
  const page = request.page ?? usePdfStore().pages[object.page] ?? null;
  const payload = object.payload;
  const settings = payload.smart;
  if (!settings) return null;
  if (typeof document === 'undefined') return null;

  /**
   * Ограничение масштаба.
   *
   * Растр страницы рендерится целиком, и у него есть предел по числу пикселей.
   * Если запросить больше, pdf.js отдаст картинку меньше — и маска окажется
   * сдвинутой: текст под штрихом перестанет защищаться и в PDF будет закрашен.
   * Поэтому заранее урезаем масштаб под этот предел.
   */
  const pageWidthPt = page?.width ?? 595;
  const pageHeightPt = page?.height ?? 842;
  const maxPagePixels = 24_000_000;
  const maxScale = Math.sqrt(maxPagePixels / Math.max(1, pageWidthPt * pageHeightPt));
  const scale = Math.max(0.25, Math.min(request.scale, maxScale));

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
  /**
   * Маска текста от модели (DBNet, PP-OCRv4 det) — только если движок «model»
   * и модель реально доступна. null означает «работаем классикой».
   */
  const modelTextMask =
    settings.engine === 'model'
      ? await detectTextMask(pageData, pixelWidth, pixelHeight)
      : null;
  const shapeData = shapeCtx.getImageData(0, 0, pixelWidth, pixelHeight).data;

  /**
   * Сглаженная яркость.
   *
   * Решения «тёмное/светлое» принимаем не по отдельному пикселю, а по среднему
   * 3×3: у скана заметный шум, и поштучный порог давал рваную маску с точками
   * и прямоугольными обрывками.
   */
  /**
   * Дистанция до целевого цвета (режим «по цвету пипетки»).
   *
   * Считается как доля от максимального расстояния в RGB и сглаживается 3×3 —
   * иначе на сжатом скане по краю печати остаются точки.
   */
  /**
   * Режим работы: единая точка правды.
   *
   * Старые проекты без поля mode выводят его из флагов, поэтому ничего не ломается.
   */
  const mode =
    settings.mode ??
    (settings.targetColor ? 'by-color' : settings.eraseAll === true ? 'erase-all' : 'keep-dark');
  const target = mode === 'by-color' ? parseHexColor(settings.targetColor ?? null) : null;
  /**
   * Цвет заливки для «Умного корректора 2»: null — тон бумаги страницы,
   * иначе конкретный цвет (пользователь выбрал его в панели).
   */
  const fillSolid = mode === 'keep-text' ? parseHexColor(settings.fillColor ?? null) : null;
  /** В keep-text цветную краску поверх букв стираем, если не отключено. */
  const eraseInkOverText = settings.eraseColoredOverText !== false;
  const colorTolerance = Math.max(0, Math.min(100, settings.colorTolerance ?? 22)) / 100;
  const colorDistance = new Float32Array(pixelWidth * pixelHeight);
  /** Дорастание цвета: 1 — сосед совпавшего пикселя, не бумага и не текст. */
  let targetGrown: Uint8Array | null = null;
  if (target) {
    const raw = new Float32Array(pixelWidth * pixelHeight);
    for (let index = 0, pixel = 0; index < pageData.length; index += 4, pixel += 1) {
      const dr = pageData[index] - target.r;
      const dg = pageData[index + 1] - target.g;
      const db = pageData[index + 2] - target.b;
      raw[pixel] = Math.sqrt(dr * dr + dg * dg + db * db) / 441.673;
    }
    for (let y = 0; y < pixelHeight; y += 1) {
      for (let x = 0; x < pixelWidth; x += 1) {
        let sum = 0;
        let count = 0;
        for (let ny = Math.max(0, y - 1); ny <= Math.min(pixelHeight - 1, y + 1); ny += 1) {
          for (let nx = Math.max(0, x - 1); nx <= Math.min(pixelWidth - 1, x + 1); nx += 1) {
            sum += raw[ny * pixelWidth + nx];
            count += 1;
          }
        }
        colorDistance[y * pixelWidth + x] = sum / count;
      }
    }

    // Дорастание: от пикселей, попавших в цвет, идём по соседям, которые не
    // похожи на бумагу и не являются текстом. Так уходит бледная кайма, которую
    // печать оставляет по краям (там тон уже далёк от целевого).
    const grown = new Uint8Array(pixelWidth * pixelHeight);
    const queue: number[] = [];
    for (let pixel = 0; pixel < colorDistance.length; pixel += 1) {
      if (colorDistance[pixel] > colorTolerance) continue;
      grown[pixel] = 1;
      queue.push(pixel);
    }
    /** Тон пикселя в градусах: сравниваем оттенок, а не яркость. */
    const hueOf = (r: number, g: number, b: number): number => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      if (delta === 0) return 0;
      let hue = 0;
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue *= 60;
      return hue < 0 ? hue + 360 : hue;
    };
    const targetHue = hueOf(target.r, target.g, target.b);
    const radius = Math.max(1, Math.round(scale * 0.35));
    let steps = 0;
    while (queue.length > 0 && steps < radius) {
      const layerSize = queue.length;
      const nextQueue: number[] = [];
      for (let item = 0; item < layerSize; item += 1) {
        const pixel = queue[item] as number;
        const x = pixel % pixelWidth;
        const y = (pixel - x) / pixelWidth;
        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= pixelHeight) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            if (nx < 0 || nx >= pixelWidth) continue;
            const neighbour = ny * pixelWidth + nx;
            if (grown[neighbour]) continue;
            const index = neighbour * 4;
            const red = pageData[index];
            const green = pageData[index + 1];
            const blue = pageData[index + 2];
            const max = Math.max(red, green, blue);
            const min = Math.min(red, green, blue);
            const saturation = max === 0 ? 0 : (max - min) / max;
            // Растём по ОТТЕНКУ: бледная краска (промытый край печати) имеет тот
            // же тон, что и целевой цвет, но сильно светлее — по яркости её не
            // поймать, по тону легко. Нейтральные буквы (насыщенность ~0) целы.
            if (saturation < 0.05) continue;
            const hue = hueOf(red, green, blue);
            const raw = Math.abs(hue - targetHue);
            const hueDelta = raw > 180 ? 360 - raw : raw;
            if (hueDelta > 30) continue;
            grown[neighbour] = 1;
            nextQueue.push(neighbour);
          }
        }
      }
      queue.length = 0;
      queue.push(...nextQueue);
      steps += 1;
    }
    targetGrown = grown;
  }

  /**
   * Адаптивный порог «очистки фона» (Sauvola-подобный).
   *
   * Для каждого пикселя берём локальное среднее и стандартное отклонение в окне
   * ~1/8 меньшей стороны ROI: threshold = mean * (1 + k * (std / 128 - 1)).
   * Глобальный порог на неравномерном фоне ошибается, локальный — нет.
   * Считается по интегральным изображениям (O(1) на пиксель).
   */
  const adaptive =
    settings.engine === 'adaptive'
      ? (() => {
          const w = pixelWidth;
          const h = pixelHeight;
          const integral = new Float64Array((w + 1) * (h + 1));
          const integralSq = new Float64Array((w + 1) * (h + 1));
          for (let y = 0; y < h; y += 1) {
            let rowSum = 0;
            let rowSq = 0;
            for (let x = 0; x < w; x += 1) {
              const index = (y * w + x) * 4;
              const lum =
                0.299 * pageData[index] + 0.587 * pageData[index + 1] + 0.114 * pageData[index + 2];
              rowSum += lum;
              rowSq += lum * lum;
              const position = (y + 1) * (w + 1) + (x + 1);
              integral[position] = integral[position - (w + 1)] + rowSum;
              integralSq[position] = integralSq[position - (w + 1)] + rowSq;
            }
          }
          const radius = Math.max(4, Math.round(Math.min(w, h) / 16));
          const sensitivity = Math.max(0, Math.min(100, settings.sensitivity ?? 55)) / 100;
          // k: 0.2 (мягко, сохраняет больше) … 0.6 (жёстко, стирает больше).
          const k = 0.2 + sensitivity * 0.4;
          const map = new Float32Array(w * h);
          const rectSum = (table: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
            table[y1 * (w + 1) + x1] -
            table[y0 * (w + 1) + x1] -
            table[y1 * (w + 1) + x0] +
            table[y0 * (w + 1) + x0];
          for (let y = 0; y < h; y += 1) {
            const y0 = Math.max(0, y - radius);
            const y1 = Math.min(h, y + radius + 1);
            for (let x = 0; x < w; x += 1) {
              const x0 = Math.max(0, x - radius);
              const x1 = Math.min(w, x + radius + 1);
              const count = (x1 - x0) * (y1 - y0);
              const sum = rectSum(integral, x0, y0, x1, y1);
              const sumSq = rectSum(integralSq, x0, y0, x1, y1);
              const mean = sum / count;
              const variance = Math.max(0, sumSq / count - mean * mean);
              const deviation = Math.sqrt(variance);
              map[y * w + x] = mean * (1 + k * (deviation / 128 - 1));
            }
          }
          return map;
        })()
      : null;

  const smoothLum = new Float32Array(pixelWidth * pixelHeight);
  {
    const raw = new Float32Array(pixelWidth * pixelHeight);
    for (let index = 0, pixel = 0; index < pageData.length; index += 4, pixel += 1) {
      raw[pixel] =
        0.299 * pageData[index] + 0.587 * pageData[index + 1] + 0.114 * pageData[index + 2];
    }
    for (let y = 0; y < pixelHeight; y += 1) {
      for (let x = 0; x < pixelWidth; x += 1) {
        let sum = 0;
        let count = 0;
        for (let ny = Math.max(0, y - 1); ny <= Math.min(pixelHeight - 1, y + 1); ny += 1) {
          for (let nx = Math.max(0, x - 1); nx <= Math.min(pixelWidth - 1, x + 1); nx += 1) {
            sum += raw[ny * pixelWidth + nx];
            count += 1;
          }
        }
        smoothLum[y * pixelWidth + x] = sum / count;
      }
    }
  }
  const lumAt = (x: number, y: number): number => smoothLum[y * pixelWidth + x];
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
   * По умолчанию заливка повторяет бумагу **в каждой точке**: строим сетку
   * среднего тона светлых пикселей (ячейка 16 px маски) и берём цвет из неё
   * билинейно. Плоская заливка оставляла видимое пятно там, где у скана
   * неравномерная бумага (тени, градиент от края), а такая заливка сливается
   * с фоном. Если пользователь выбрал цвет вручную — заливаем ровно им.
   */
  const autoColor = settings.autoColor !== false;
  /** Тон бумаги (0 — не определён). Нужен и в цикле: чистую бумагу не трогаем. */
  let paperTone = 0;
  /** Средняя насыщенность бумаги: у скана она не нулевая (желтизна, синева). */
  let paperSaturation = 0.02;
  const uniform = hexToRgb(settings.color || '#ffffff');
  const uniformR = Math.round(uniform.r * 255);
  const uniformG = Math.round(uniform.g * 255);
  const uniformB = Math.round(uniform.b * 255);

  const cell = 16;
  const cols = Math.max(1, Math.ceil(pixelWidth / cell));
  const rows = Math.max(1, Math.ceil(pixelHeight / cell));
  const gridCount = new Float32Array(cols * rows);
  const gridR = new Float32Array(cols * rows);
  const gridG = new Float32Array(cols * rows);
  const gridB = new Float32Array(cols * rows);
  const gridLum = new Float32Array(cols * rows);

  if (autoColor) {
    // 0. Мода яркости страницы — это и есть бумага. Нужна как опорная точка:
    // при низком пороге (100–120) в выборку попадают серые элементы (линии
    // формы, штампы), и «бумага» получалась грязнее настоящей.
    const histogram = new Float64Array(256);
    const bucketR = new Float64Array(256);
    const bucketG = new Float64Array(256);
    const bucketB = new Float64Array(256);
    const strideX = Math.max(1, Math.round(pixelWidth / 600));
    const strideY = Math.max(1, Math.round(pixelHeight / 600));
    for (let y = 0; y < pixelHeight; y += strideY) {
      for (let x = 0; x < pixelWidth; x += strideX) {
        const index = (y * pixelWidth + x) * 4;
        const luminance =
          0.299 * pageData[index] + 0.587 * pageData[index + 1] + 0.114 * pageData[index + 2];
        if (luminance < threshold) continue;
        const bucket = Math.min(255, Math.max(0, Math.round(luminance)));
        histogram[bucket] += 1;
        bucketR[bucket] += pageData[index];
        bucketG[bucket] += pageData[index + 1];
        bucketB[bucket] += pageData[index + 2];
      }
    }
    let paperLum = 255;
    let paperBest = 0;
    for (let bucket = 0; bucket < 256; bucket += 1) {
      if (histogram[bucket] > paperBest) {
        paperBest = histogram[bucket];
        paperLum = bucket;
      }
    }
    paperTone = paperLum;
    {
      // Средняя насыщенность светлых пикселей = «цветность» самой бумаги.
      let satSum = 0;
      let satCount = 0;
      const strideX2 = Math.max(1, Math.round(pixelWidth / 400));
      const strideY2 = Math.max(1, Math.round(pixelHeight / 400));
      for (let y = 0; y < pixelHeight; y += strideY2) {
        for (let x = 0; x < pixelWidth; x += strideX2) {
          const index = (y * pixelWidth + x) * 4;
          const r = pageData[index];
          const g = pageData[index + 1];
          const b = pageData[index + 2];
          const max = Math.max(r, g, b);
          if (max < 200) continue;
          satSum += (max - Math.min(r, g, b)) / max;
          satCount += 1;
        }
      }
      if (satCount > 0) paperSaturation = Math.min(0.2, satSum / satCount);
    }
    // В оценку бумаги берём только пиксели вплотную к самому светлому тону
    // (8 единиц): сглаженные края букв на 200–250 иначе занижали заливку, и
    // она выглядела серой полосой на белой бумаге.
    const paperFloor = Math.max(threshold, paperLum - 8);

    /**
     * Однородная ли бумага на странице.
     *
     * Если почти все светлые пиксели лежат в узком коридоре у моды, локальная
     * сетка только вредит: у краёв текста она чуть темнее, и мазок получается
     * пятнистым (перепад 250–255 на белом видно). В этом случае заливаем одним
     * тоном. У сканов с тенью и градиентом доля таких пикселей меньше, и
     * работает локальная сетка.
     */
    let lightTotal = 0;
    let nearMode = 0;
    for (let bucket = 0; bucket < 256; bucket += 1) {
      lightTotal += histogram[bucket];
      if (Math.abs(bucket - paperLum) <= 6) nearMode += histogram[bucket];
    }
    const uniformPaper = lightTotal > 0 && nearMode / lightTotal >= 0.85;
    // Цвет самой моды — ровно тот тон, которого больше всего на странице.
    const modalCount = histogram[paperLum];
    const modalR = modalCount > 0 ? bucketR[paperLum] / modalCount : uniformR;
    const modalG = modalCount > 0 ? bucketG[paperLum] / modalCount : uniformG;
    const modalB = modalCount > 0 ? bucketB[paperLum] / modalCount : uniformB;

    // 1. Накапливаем светлые (бумажные) пиксели по ячейкам.
    for (let y = 0; y < pixelHeight; y += 1) {
      const rowBase = Math.floor(y / cell) * cols;
      for (let x = 0; x < pixelWidth; x += 1) {
        const index = (y * pixelWidth + x) * 4;
        const luminance =
          0.299 * pageData[index] + 0.587 * pageData[index + 1] + 0.114 * pageData[index + 2];
        if (luminance < paperFloor) continue;
        const cellIndex = rowBase + Math.floor(x / cell);
        gridCount[cellIndex] += 1;
        gridR[cellIndex] += pageData[index];
        gridG[cellIndex] += pageData[index + 1];
        gridB[cellIndex] += pageData[index + 2];
        gridLum[cellIndex] += luminance;
      }
    }
    // 2. Пустые ячейки (сплошной текст, картинка) — берём средний тон страницы.
    let totalR = 0;
    let totalG = 0;
    let totalB = 0;
    let totalCount = 0;
    let brightestR = 0;
    let brightestG = 0;
    let brightestB = 0;
    let brightestCount = 0;
    for (let index = 0; index < gridCount.length; index += 1) {
      if (gridCount[index] === 0) continue;
      totalR += gridR[index];
      totalG += gridG[index];
      totalB += gridB[index];
      totalCount += gridCount[index];
      if (gridLum[index] >= paperLum - 4) {
        brightestR += gridR[index];
        brightestG += gridG[index];
        brightestB += gridB[index];
        brightestCount += gridCount[index];
      }
    }
    const fallbackR = uniformPaper ? modalR : brightestCount > 0 ? brightestR / brightestCount : totalCount > 0 ? totalR / totalCount : uniformR;
    const fallbackG = uniformPaper ? modalG : brightestCount > 0 ? brightestG / brightestCount : totalCount > 0 ? totalG / totalCount : uniformG;
    const fallbackB = uniformPaper ? modalB : brightestCount > 0 ? brightestB / brightestCount : totalCount > 0 ? totalB / totalCount : uniformB;
    for (let index = 0; index < gridCount.length; index += 1) {
      const count = gridCount[index];
      if (count > 0) {
        gridR[index] /= count;
        gridG[index] /= count;
        gridB[index] /= count;
        gridLum[index] /= count;
      } else {
        gridR[index] = fallbackR;
        gridG[index] = fallbackG;
        gridB[index] = fallbackB;
        gridLum[index] = 0.299 * fallbackR + 0.587 * fallbackG + 0.114 * fallbackB;
        gridCount[index] = 0;
      }
    }
    // Движок модели даёт контентную маску: заливке достаточно одного тона бумаги,
    // иначе на ровных местах видна «полосатость» 250–255.
    if (settings.engine === 'model') {
      for (let index = 0; index < gridCount.length; index += 1) {
        gridR[index] = modalR;
        gridG[index] = modalG;
        gridB[index] = modalB;
        gridLum[index] = 0.299 * modalR + 0.587 * modalG + 0.114 * modalB;
        gridCount[index] = Math.max(1, gridCount[index]);
      }
    }
    // 2б. Пустые ячейки (сплошная печать) заполняем тоном соседей: так заливка
    // продолжает бумагу, а не становится светлее её.
    for (let pass = 0; pass < 6; pass += 1) {
      let filledAny = false;
      const nextR = new Float32Array(gridR);
      const nextG = new Float32Array(gridG);
      const nextB = new Float32Array(gridB);
      const nextCount = new Float32Array(gridCount);
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const index = row * cols + col;
          if (gridCount[index] > 0) continue;
          let count = 0;
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            const ny = row + dy;
            if (ny < 0 || ny >= rows) continue;
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = col + dx;
              if (nx < 0 || nx >= cols) continue;
              const neighbour = ny * cols + nx;
              if (gridCount[neighbour] <= 0) continue;
              sumR += gridR[neighbour];
              sumG += gridG[neighbour];
              sumB += gridB[neighbour];
              count += 1;
            }
          }
          if (count === 0) continue;
          nextR[index] = sumR / count;
          nextG[index] = sumG / count;
          nextB[index] = sumB / count;
          nextCount[index] = 1;
          filledAny = true;
        }
      }
      gridR.set(nextR);
      gridG.set(nextG);
      gridB.set(nextB);
      gridCount.set(nextCount);
      if (!filledAny) break;
    }
    // 3. Заливка берёт локальный тон бумаги из сетки (см. `paperAt`).
    //
    // Раньше здесь был «один тон на весь мазок»: это убирало полосатость, но
    // когда маска перестала трогать чистую бумагу, закрашиваются только участки
    // печати и грязи — и плоский тон в них светлее окружающей бумаги, из-за чего
    // был виден прямоугольный «призрак». Локальный тон сливается с окружением.

    // 4. Несколько проходов сглаживания сетки: без резких переходов между
    // ячейками, иначе на заливке видны прямоугольные ступени.
    const smoothR = new Float32Array(gridR);
    const smoothG = new Float32Array(gridG);
    const smoothB = new Float32Array(gridB);
    for (let pass = 0; pass < 2; pass += 1) {
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const index = row * cols + col;
          let count = 0;
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            const ny = row + dy;
            if (ny < 0 || ny >= rows) continue;
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = col + dx;
              if (nx < 0 || nx >= cols) continue;
              const neighbour = ny * cols + nx;
              sumR += smoothR[neighbour];
              sumG += smoothG[neighbour];
              sumB += smoothB[neighbour];
              count += 1;
            }
          }
          gridR[index] = sumR / count;
          gridG[index] = sumG / count;
          gridB[index] = sumB / count;
        }
      }
      smoothR.set(gridR);
      smoothG.set(gridG);
      smoothB.set(gridB);
    }
  }

  /** Билинейный цвет «бумаги» в пикселе маски. */
  function paperAt(x: number, y: number): [number, number, number] {
    if (!autoColor) return [uniformR, uniformG, uniformB];
    const gx = Math.min(cols - 1, Math.max(0, x / cell - 0.5));
    const gy = Math.min(rows - 1, Math.max(0, y / cell - 0.5));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(cols - 1, x0 + 1);
    const y1 = Math.min(rows - 1, y0 + 1);
    const fx = gx - x0;
    const fy = gy - y0;
    const i00 = y0 * cols + x0;
    const i10 = y0 * cols + x1;
    const i01 = y1 * cols + x0;
    const i11 = y1 * cols + x1;
    const top = [
      gridR[i00] * (1 - fx) + gridR[i10] * fx,
      gridG[i00] * (1 - fx) + gridG[i10] * fx,
      gridB[i00] * (1 - fx) + gridB[i10] * fx,
    ];
    const bottom = [
      gridR[i01] * (1 - fx) + gridR[i11] * fx,
      gridG[i01] * (1 - fx) + gridG[i11] * fx,
      gridB[i01] * (1 - fx) + gridB[i11] * fx,
    ];
    return [
      top[0] * (1 - fy) + bottom[0] * fy,
      top[1] * (1 - fy) + bottom[1] * fy,
      top[2] * (1 - fy) + bottom[2] * fy,
    ];
  }

  /**
   * Мягкий переход к порогу.
   *
   * Жёсткий порог оставлял вокруг букв тонкую кайму: сглаженные края глифов
   * (смесь чёрного и белого) попадают между «тёмным» и «светлым» и остаются
   * незакрашенными — в PDF с аннотациями эта кайма видна как обводка. Теперь
   * такие пиксели закрашиваются частично, и граница получается плавной.
   */
  // Переход только в узкой полосе у порога: всё, что светлее порога, закрашено
  // полностью — иначе на скане сквозь полупрозрачную заливку просвечивала
  // текстура бумаги и мазок выглядел пятнистым.
  const softness = 40;
  const lowEdge = threshold - softness;
  /**
   * Кромка маски.
   *
   * Полупрозрачный край — источник тёмной каймы: он смешивается с содержимым
   * страницы под ним (буква, линия), и в PDF вокруг мазка появляется полоска.
   * Поэтому альфа бинарная: пиксель либо закрашен полностью, либо не закрашен.
   *
   * Порог низкий (24 из 255): сглаженный край самого штриха тоже должен попасть
   * в заливку. Иначе по периметру мазка остаётся непокрытая полоска исходного
   * контента — та самая кайма вокруг мазка, только не от альфы, а от «зазора».
   */
  const edgeCoverage = 24;
  // В режиме «вернуть текст» заливаем всё: распознанный текст рисуется поверх.
  const eraseAll = mode === 'erase-all' || mode === 'retype';

  /**
   * Карта «цветного» содержимого.
   *
   * Печать, штампы и рукописные пометки цветные, а машинописный текст —
   * нейтрально чёрный. В сжатом скане отдельные пиксели печати выглядят
   * нейтральными, поэтому карту цветного расширяем на пару пикселей: иначе
   * внутри стёртой печати оставались точки.
   */
  const colored = new Uint8Array(pixelWidth * pixelHeight);
  for (let index = 0, pixel = 0; index < pageData.length; index += 4, pixel += 1) {
    const r = pageData[index];
    const g = pageData[index + 1];
    const b = pageData[index + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 60) continue; // почти чёрный — нейтральный
    if ((max - min) / max > 0.35) colored[pixel] = 1;
  }
  const colorSpread = Math.max(2, Math.round(scale * 0.5));
  {
    const spread = new Uint8Array(colored);
    for (let y = 0; y < pixelHeight; y += 1) {
      for (let x = 0; x < pixelWidth; x += 1) {
        if (!colored[y * pixelWidth + x]) continue;
        for (let ny = Math.max(0, y - colorSpread); ny <= Math.min(pixelHeight - 1, y + colorSpread); ny += 1) {
          for (let nx = Math.max(0, x - colorSpread); nx <= Math.min(pixelWidth - 1, x + colorSpread); nx += 1) {
            spread[ny * pixelWidth + nx] = 1;
          }
        }
      }
    }
    colored.set(spread);
  }
  const isColoredPixel = (x: number, y: number): boolean => colored[y * pixelWidth + x] === 1;
  /** Насыщенность пикселя 0..1 (нужна, чтобы отличить бумагу от бледного тона печати). */
  const saturationAt = (index: number): number => {
    const r = pageData[index];
    const g = pageData[index + 1];
    const b = pageData[index + 2];
    const max = Math.max(r, g, b);
    if (max === 0) return 0;
    return (max - Math.min(r, g, b)) / max;
  };

  /**
   * Защита тёмного с ореолом.
   *
   * Без неё у букв закрашивались сглаженные края, а ядро оставалось — текст
   * выглядел «изъеденным». Сначала помечаем тёмные пиксели, затем расширяем
   * пометку на 1 пиксель и такие пиксели не трогаем совсем.
   */
  let protect: Uint8Array | null = null;
  if (!eraseAll) {
    const dark = new Uint8Array(pixelWidth * pixelHeight);
    for (let y = 0; y < pixelHeight; y += 1) {
      for (let x = 0; x < pixelWidth; x += 1) {
        const index = (y * pixelWidth + x) * 4;
        const luminance =
          0.299 * pageData[index] + 0.587 * pageData[index + 1] + 0.114 * pageData[index + 2];
        const limit = adaptive ? adaptive[y * pixelWidth + x] : threshold;
        // Защищаем текст, если его видит классика ИЛИ модель: два детектора
        // дополняют друг друга, и слово не теряется, если один промахнулся.
        const modelSaysText = modelTextMask ? modelTextMask[y * pixelWidth + x] === 1 : false;
        if (modelSaysText || (lumAt(x, y) < limit && !isColoredPixel(x, y))) {
          dark[y * pixelWidth + x] = 1;
        }
      }
    }
    // Ореол в пикселях маски: около 0.8 pt — столько занимает сглаженный край
    // глифа. Без него буквы «худеют» и выглядят обкусанными прямоугольниками.
    const halo = Math.max(2, Math.round(scale * 0.8));
    // Гистерезис: сначала ядро (совсем тёмное), затем рост в сглаженный край
    // буквы (чуть светлее), связанный с ядром. Так текст сохраняется целиком,
    // вместе с кромкой, и вокруг него не остаётся светлого ореола.
    {
      const coreLimit = 25;
      const skirtLimit = 22;
      const queue: number[] = [];
      const grown = new Uint8Array(dark);
      for (let index = 0; index < dark.length; index += 1) {
        if (!dark[index]) continue;
        const x = index % pixelWidth;
        const y = (index - x) / pixelWidth;
        const limit = adaptive ? adaptive[index] : threshold;
        const lum = smoothLum[index];
        if (lum <= limit - coreLimit) queue.push(index);
        else if (lum > limit + skirtLimit) dark[index] = 0;
        void x;
        void y;
      }
      // Снятие «не-ядра», затем рост из ядра в пределах сглаженного края.
      const seeds = new Uint8Array(dark);
      for (let index = 0; index < seeds.length; index += 1) {
        if (!seeds[index]) continue;
        const limit = adaptive ? adaptive[index] : threshold;
        if (smoothLum[index] > limit - coreLimit) seeds[index] = 0;
      }
      const grownMap = new Uint8Array(seeds);
      const stack = queue.slice();
      while (stack.length > 0) {
        const index = stack.pop() as number;
        const x = index % pixelWidth;
        const y = (index - x) / pixelWidth;
        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= pixelHeight) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            if (nx < 0 || nx >= pixelWidth) continue;
            const neighbour = ny * pixelWidth + nx;
            if (grownMap[neighbour]) continue;
            const limit = adaptive ? adaptive[neighbour] : threshold;
            if (smoothLum[neighbour] > limit + skirtLimit) continue;
            grownMap[neighbour] = 1;
            stack.push(neighbour);
          }
        }
      }
      dark.set(grownMap);
    }

    // Открытие (эрозия → дилатация) убирает мелкие тёмные острова: иначе они
    // защищались как текст и оставались крошкой внутри мазка.
    {
      const radius = Math.max(1, Math.round(scale * 0.25));
      const eroded = new Uint8Array(pixelWidth * pixelHeight);
      for (let y = 0; y < pixelHeight; y += 1) {
        for (let x = 0; x < pixelWidth; x += 1) {
          if (!dark[y * pixelWidth + x]) continue;
          let keep = 1;
          for (let ny = Math.max(0, y - radius); ny <= Math.min(pixelHeight - 1, y + radius) && keep; ny += 1) {
            for (let nx = Math.max(0, x - radius); nx <= Math.min(pixelWidth - 1, x + radius); nx += 1) {
              if (!dark[ny * pixelWidth + nx]) {
                keep = 0;
                break;
              }
            }
          }
          eroded[y * pixelWidth + x] = keep;
        }
      }
      const opened = new Uint8Array(pixelWidth * pixelHeight);
      for (let y = 0; y < pixelHeight; y += 1) {
        for (let x = 0; x < pixelWidth; x += 1) {
          if (!eroded[y * pixelWidth + x]) continue;
          for (let ny = Math.max(0, y - radius); ny <= Math.min(pixelHeight - 1, y + radius); ny += 1) {
            for (let nx = Math.max(0, x - radius); nx <= Math.min(pixelWidth - 1, x + radius); nx += 1) {
              opened[ny * pixelWidth + nx] = 1;
            }
          }
        }
      }
      dark.set(opened);
    }

    protect = new Uint8Array(pixelWidth * pixelHeight);
    for (let y = 0; y < pixelHeight; y += 1) {
      for (let x = 0; x < pixelWidth; x += 1) {
        if (!dark[y * pixelWidth + x]) continue;
        const y0 = Math.max(0, y - halo);
        const y1 = Math.min(pixelHeight - 1, y + halo);
        const x0 = Math.max(0, x - halo);
        const x1 = Math.min(pixelWidth - 1, x + halo);
        for (let ny = y0; ny <= y1; ny += 1) {
          for (let nx = x0; nx <= x1; nx += 1) protect[ny * pixelWidth + nx] = 1;
        }
      }
    }
  }

  /**
   * Цвет пишем во ВСЕ пиксели маски, включая полностью прозрачные.
   *
   * Причина: у прозрачного пикселя RGB по умолчанию чёрный. Просмотрщики PDF и
   * браузер интерполируют картинку маски по краю мазка и при наивном сглаживании
   * (без предумножения на альфу) подмешивают этот чёрный — вокруг мазка выходит
   * чёрная кайма. Если во всех пикселях лежит тон бумаги, каймы не бывает: цвет
   * совпадает с фоном при любом способе интерполяции.
   */
  for (let y = 0; y < pixelHeight; y += 1) {
    for (let x = 0; x < pixelWidth; x += 1) {
      const index = (y * pixelWidth + x) * 4;
      if (fillSolid) {
        mask.data[index] = fillSolid.r;
        mask.data[index + 1] = fillSolid.g;
        mask.data[index + 2] = fillSolid.b;
        continue;
      }
      const [paperRed, paperGreen, paperBlue] = paperAt(x, y);
      mask.data[index] = Math.round(paperRed);
      mask.data[index + 1] = Math.round(paperGreen);
      mask.data[index + 2] = Math.round(paperBlue);
    }
  }

  for (let y = 0; y < pixelHeight; y += 1) {
    for (let x = 0; x < pixelWidth; x += 1) {
      const index = (y * pixelWidth + x) * 4;
      const coverage = shapeData[index + 3];
      if (coverage === 0) continue;
      if (coverage < edgeCoverage) continue;
      if (target) {
        // Режим «по цвету пипетки»: цвет плюс его дорастание по соседним
        // не-бумажным пикселям (бледные края печати иначе остаются следом).
        const pixel = y * pixelWidth + x;
        const matched =
          colorDistance[pixel] <= colorTolerance || (targetGrown && targetGrown[pixel] === 1);
        if (matched) mask.data[index + 3] = Math.round(opacity * 255);
        continue;
      }
      if (mode === 'keep-text') {
        const pixel = y * pixelWidth + x;
        const isProtectedText = protect ? protect[pixel] === 1 : false;
        const isInk = isColoredPixel(x, y);
        // Буква остаётся видимой; краску поверх буквы стираем, если так задано.
        if (isProtectedText && !(eraseInkOverText && isInk)) continue;
        mask.data[index + 3] = Math.round(opacity * 255);
        continue;
      }
      if (protect && protect[y * pixelWidth + x] && !isColoredPixel(x, y)) continue;
      if (!eraseAll) {
        const luminance =
          0.299 * pageData[index] + 0.587 * pageData[index + 1] + 0.114 * pageData[index + 2];
        // Чистая бумага остаётся как была: закрашивать её плоским цветом нельзя —
        // на текстуре скана ровное пятно видно кромкой. Допуск 25 единиц: у скана
        // бумага «дышит» на 10–20 единиц, и без запаса её шум превращался в
        // крошку из закрашенных точек.
        if (
          autoColor &&
          paperTone > 0 &&
          luminance >= paperTone - 25 &&
          saturationAt(index) <= paperSaturation + 0.04
        ) {
          continue;
        }
        // Цветное (печать, штампы, пометки) стираем всегда, а нейтрально тёмный
        // текст под штрихом остаётся нетронутым (альфа 0 — видно страницу).
        const localLimit = adaptive ? adaptive[y * pixelWidth + x] : threshold;
        const edge = adaptive ? localLimit - softness : lowEdge;
        if (luminance <= edge && !isColoredPixel(x, y)) continue;
        const ramp =
          luminance >= localLimit ? 1 : Math.min(1, (luminance - edge) / softness);
        mask.data[index + 3] = Math.round(opacity * ramp * 255);
        continue;
      }
      mask.data[index + 3] = Math.round(opacity * 255);
    }
  }
  // Чистка «соли и перца»: одиночные закрашенные пиксели убираем, одиночные
  // дырки внутри заливки закрываем. Без этого на шумном скане маска выглядит
  // как прямоугольная крошка.
  {
    const filled = new Uint8Array(pixelWidth * pixelHeight);
    for (let pixel = 0; pixel < pixelWidth * pixelHeight; pixel += 1) {
      if (mask.data[pixel * 4 + 3] > 120) filled[pixel] = 1;
    }
    const cleaned = new Uint8Array(filled);
    const radius = 2;
    for (let y = radius; y < pixelHeight - radius; y += 1) {
      for (let x = radius; x < pixelWidth - radius; x += 1) {
        const pixel = y * pixelWidth + x;
        let neighbours = 0;
        let total = 0;
        for (let ny = y - radius; ny <= y + radius; ny += 1) {
          for (let nx = x - radius; nx <= x + radius; nx += 1) {
            if (ny === y && nx === x) continue;
            total += 1;
            neighbours += filled[ny * pixelWidth + nx];
          }
        }
        // Одиночный островок (меньше трети окружения) убираем, «дырку» закрываем.
        if (filled[pixel] && neighbours <= Math.floor(total * 0.34)) cleaned[pixel] = 0;
        else if (!filled[pixel] && neighbours >= Math.ceil(total * 0.8)) cleaned[pixel] = 1;
      }
    }
    for (let pixel = 0; pixel < pixelWidth * pixelHeight; pixel += 1) {
      mask.data[pixel * 4 + 3] = cleaned[pixel] ? Math.round(opacity * 255) : 0;
    }
  }

  maskCtx.putImageData(mask, 0, 0);
  maskPixels.set(maskCanvas, mask);
  return maskCanvas;
}

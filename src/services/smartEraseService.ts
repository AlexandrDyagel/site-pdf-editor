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
    payload.smart?.eraseAll ? 'all' : 'keep',
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
   * По умолчанию заливка повторяет бумагу **в каждой точке**: строим сетку
   * среднего тона светлых пикселей (ячейка 16 px маски) и берём цвет из неё
   * билинейно. Плоская заливка оставляла видимое пятно там, где у скана
   * неравномерная бумага (тени, градиент от края), а такая заливка сливается
   * с фоном. Если пользователь выбрал цвет вручную — заливаем ровно им.
   */
  const autoColor = settings.autoColor !== false;
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
      }
    }
    // 3. Решаем, нужна ли локальная сетка вообще.
    //
    // На ровной бумаге (а это почти все сканы форм) сетка только вредит: у
    // краёв текста ячейки чуть темнее, и мазок выглядит пятнистой полосой
    // 250–255 на белом 255. Поэтому считаем разброс тона по ячейкам и, если он
    // невелик, заливаем всё цветом моды — он совпадает с бумагой и мазка не
    // видно. У страниц с тенью или градиентом разброс больше, и работает сетка.
    const cellTones: number[] = [];
    for (let index = 0; index < gridCount.length; index += 1) {
      if (gridCount[index] > 0) cellTones.push(gridLum[index] / gridCount[index]);
    }
    cellTones.sort((a, b) => a - b);
    const p05 = cellTones.length ? cellTones[Math.floor(cellTones.length * 0.05)] : 0;
    const p95 = cellTones.length ? cellTones[Math.floor(cellTones.length * 0.95)] : 0;
    if (cellTones.length === 0 || p95 - p05 <= 10) {
      for (let index = 0; index < gridCount.length; index += 1) {
        gridR[index] = modalR;
        gridG[index] = modalG;
        gridB[index] = modalB;
      }
    }

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
   * На 300 dpi ступенька в 1 пиксель маски незаметна.
   */
  const edgeCoverage = 110;
  const eraseAll = settings.eraseAll === true;

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
        if (luminance < threshold) dark[y * pixelWidth + x] = 1;
      }
    }
    protect = new Uint8Array(pixelWidth * pixelHeight);
    for (let y = 0; y < pixelHeight; y += 1) {
      for (let x = 0; x < pixelWidth; x += 1) {
        if (!dark[y * pixelWidth + x]) continue;
        const y0 = Math.max(0, y - 1);
        const y1 = Math.min(pixelHeight - 1, y + 1);
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(pixelWidth - 1, x + 1);
        for (let ny = y0; ny <= y1; ny += 1) {
          for (let nx = x0; nx <= x1; nx += 1) protect[ny * pixelWidth + nx] = 1;
        }
      }
    }
  }

  for (let y = 0; y < pixelHeight; y += 1) {
    for (let x = 0; x < pixelWidth; x += 1) {
      const index = (y * pixelWidth + x) * 4;
      const coverage = shapeData[index + 3];
      if (coverage === 0) continue;
      const [red, green, blue] = paperAt(x, y);
      // Цвет заливки пишем во все пиксели под штрихом, включая прозрачные:
      // у частично прозрачного края иначе остаётся чёрный RGB, и в PDF вокруг
      // закрашенной области появляется тёмная кайма.
      mask.data[index] = Math.round(red);
      mask.data[index + 1] = Math.round(green);
      mask.data[index + 2] = Math.round(blue);
      if (coverage < edgeCoverage) continue;
      if (protect && protect[y * pixelWidth + x]) continue;
      if (!eraseAll) {
        const luminance =
          0.299 * pageData[index] + 0.587 * pageData[index + 1] + 0.114 * pageData[index + 2];
        // Тёмный текст под штрихом остаётся нетронутым (альфа 0 — видно страницу).
        if (luminance <= lowEdge) continue;
        const ramp = luminance >= threshold ? 1 : Math.min(1, (luminance - lowEdge) / softness);
        mask.data[index + 3] = Math.round(opacity * ramp * 255);
        continue;
      }
      mask.data[index + 3] = Math.round(opacity * 255);
    }
  }
  maskCtx.putImageData(mask, 0, 0);
  return maskCanvas;
}

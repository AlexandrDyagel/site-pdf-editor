/**
 * «Стереть всё и вернуть текст»: распознаём текст в области и рисуем его заново.
 *
 * Зачем: если краска (печать, штамп, помарка) лежит ПОВЕРХ букв, восстановить
 * буквы из пикселей нельзя — их там нет. Единственный способ получить чистый фон
 * и целый текст — стереть область и набрать текст заново распознанными словами.
 *
 * Что делает модуль:
 *   1. берёт маску текста от модели (DBNet) в области;
 *   2. собирает из неё строки (по строкам пикселей) и слова (по разрывам);
 *   3. распознаёт каждое слово (PP-OCR rec, кириллица);
 *   4. возвращает строки с координатами и размером шрифта.
 */

import { detectTextMask, recognizeTextLines, type TextLineBox } from '@/services/textDetectionService';
import { pdfService } from '@/services/pdfService';

export interface RetypedLine {
  /** Распознанный текст строки (слова через пробел). */
  text: string;
  /** Прямоугольник строки в точках страницы (от левого верхнего угла). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Оценка кегля по высоте строки. */
  fontSize: number;
}

export interface RetypeOptions {
  page: number;
  /** Масштаб растеризации области (px на точку). */
  scale?: number;
  /** Область в точках страницы. */
  rect: { x: number; y: number; width: number; height: number };
}

const DEFAULT_SCALE = 300 / 72;

/** Делит маску строки на слова по вертикальным разрывам. */
function splitWords(
  mask: Uint8Array,
  width: number,
  height: number,
): { x: number; width: number }[] {
  const columns = new Uint8Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) columns[x] = 1;
    }
  }
  // Минимальный разрыв между словами: доля высоты строки.
  const minGap = Math.max(2, Math.round(height * 0.35));
  const words: { x: number; width: number }[] = [];
  let start = -1;
  let gap = 0;
  for (let x = 0; x < width; x += 1) {
    if (columns[x]) {
      if (start < 0) start = x;
      gap = 0;
      continue;
    }
    if (start < 0) continue;
    gap += 1;
    if (gap >= minGap) {
      words.push({ x: start, width: x - gap + 1 - start });
      start = -1;
      gap = 0;
    }
  }
  if (start >= 0) words.push({ x: start, width: width - start });
  return words.filter((word) => word.width >= 3);
}

/** Строки маски: горизонтальные полосы, где есть текст. */
function splitLines(
  mask: Uint8Array,
  width: number,
  height: number,
): { y: number; height: number }[] {
  const rows = new Uint8Array(height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) {
        rows[y] = 1;
        break;
      }
    }
  }
  const lines: { y: number; height: number }[] = [];
  let start = -1;
  let gap = 0;
  for (let y = 0; y < height; y += 1) {
    if (rows[y]) {
      if (start < 0) start = y;
      gap = 0;
      continue;
    }
    if (start < 0) continue;
    gap += 1;
    if (gap >= Math.max(2, Math.round(height * 0.02))) {
      lines.push({ y: start, height: y - gap + 1 - start });
      start = -1;
      gap = 0;
    }
  }
  if (start >= 0) lines.push({ y: start, height: height - start });
  return lines.filter((line) => line.height >= 6);
}

/**
 * Распознаёт текст в области страницы.
 *
 * @returns строки с текстом и координатами в точках страницы; пустой массив,
 *          если текста нет; null, если модель недоступна.
 */
export async function recognizeRegion(options: RetypeOptions): Promise<RetypedLine[] | null> {
  const { page, rect } = options;
  const scale = options.scale ?? DEFAULT_SCALE;
  const pixelWidth = Math.max(1, Math.round(rect.width * scale));
  const pixelHeight = Math.max(1, Math.round(rect.height * scale));

  // Рендерим страницу и вырезаем область.
  const rendered = await pdfService.renderPage(page, { scale, background: '#ffffff' });
  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(
    rendered.canvas,
    Math.round(rect.x * scale),
    Math.round(rect.y * scale),
    pixelWidth,
    pixelHeight,
    0,
    0,
    pixelWidth,
    pixelHeight,
  );
  const imageData = context.getImageData(0, 0, pixelWidth, pixelHeight);

  // Маска текста от модели.
  const textMask = await detectTextMask(imageData.data, pixelWidth, pixelHeight);
  if (!textMask) return null;

  const lines = splitLines(textMask, pixelWidth, pixelHeight);
  if (lines.length === 0) return [];

  // Для каждой строки — слова, для каждого слова — прямоугольник.
  const wordBoxes: TextLineBox[] = [];
  const lineWords: { line: number; first: number; count: number }[] = [];
  lines.forEach((line, lineIndex) => {
    const lineWidth = pixelWidth;
    const lineHeight = line.height;
    const band = new Uint8Array(lineWidth * lineHeight);
    for (let y = 0; y < lineHeight; y += 1) {
      for (let x = 0; x < lineWidth; x += 1) {
        band[y * lineWidth + x] = textMask[(line.y + y) * pixelWidth + x] ?? 0;
      }
    }
    const words = splitWords(band, lineWidth, lineHeight);
    const first = wordBoxes.length;
    for (const word of words) {
      wordBoxes.push({
        x: rect.x + word.x / scale,
        y: rect.y + line.y / scale,
        width: Math.max(2, word.width / scale),
        height: Math.max(4, line.height / scale),
      });
    }
    lineWords.push({ line: lineIndex, first, count: words.length });
  });

  // Распознаём слова одним запросом (пиксели области + прямоугольники в пикселях).
  const pixelBoxes = wordBoxes.map((box) => ({
    x: (box.x - rect.x) * scale,
    y: (box.y - rect.y) * scale,
    width: box.width * scale,
    height: box.height * scale,
  }));
  const texts = await recognizeTextLines(imageData.data, pixelWidth, pixelHeight, pixelBoxes);
  if (!texts) return null;

  const result: RetypedLine[] = [];
  lineWords.forEach(({ line, first, count }) => {
    if (count === 0) return;
    const words: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const text = (texts[first + index] ?? '').trim();
      if (text) words.push(text);
    }
    if (words.length === 0) return;
    const boxes = wordBoxes.slice(first, first + count);
    const left = Math.min(...boxes.map((box) => box.x));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const lineHeight = lines[line]?.height ?? 12;
    result.push({
      text: words.join(' '),
      x: left,
      y: boxes[0]?.y ?? rect.y,
      width: Math.max(4, right - left),
      height: Math.max(6, lineHeight / scale),
      // Кегль: высота строки — это высота строчных, кегль примерно в 1.35 раза больше.
      fontSize: Math.max(5, (lineHeight / scale) * 1.35),
    });
  });
  return result;
}

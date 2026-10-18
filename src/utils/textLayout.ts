/**
 * ============================================================================
 *  Раскладка текста.
 * ============================================================================
 *
 *  Один и тот же алгоритм переноса строк используется и для отрисовки на
 *  Konva-канвасе, и для экспорта в PDF. Это гарантирует, что переносы строк
 *  в предпросмотре и в готовом PDF совпадают.
 *
 *  Измерение ширины выполняется через Canvas 2D API с реально загруженным
 *  TTF-шрифтом (тот же файл встраивается затем в PDF через fontkit), поэтому
 *  метрики совпадают с точностью до хинтинга.
 */

import type { TextAlign, VerticalAlign } from '@/types';

/** Параметры шрифта для раскладки. */
export interface LayoutFontStyle {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  letterSpacing: number;
  /** Множитель межстрочного интервала. */
  lineHeight: number;
}

/** Результат раскладки текстового блока. */
export interface TextLayoutResult {
  lines: string[];
  /** Высота одной строки, pt. */
  lineHeight: number;
  /** Общая высота текста (без внутренних отступов), pt. */
  height: number;
  /** Фактическая максимальная ширина строки, pt. */
  contentWidth: number;
  /** Ширина каждой строки, pt (для выравнивания). */
  lineWidths: number[];
}

const measureCanvas: HTMLCanvasElement | null =
  typeof document !== 'undefined' ? document.createElement('canvas') : null;
const measureCtx: CanvasRenderingContext2D | null = measureCanvas
  ? measureCanvas.getContext('2d')
  : null;

const widthCache = new Map<string, number>();

/** CSS-строка шрифта для canvas. */
export function cssFontString(style: Pick<LayoutFontStyle, 'italic' | 'bold' | 'fontSize' | 'fontFamily'>): string {
  const weight = style.bold ? '700' : '400';
  const italic = style.italic ? 'italic ' : '';
  return `${italic}${weight} ${style.fontSize}px "${style.fontFamily}"`;
}
/**
 * Высота «чернил» строки над базовой линией (pt).
 *
 * Нужна, чтобы текст, созданный кликом, начинался ровно в точке клика: у
 * верхушки букв нет такого же отступа, как у строки целиком (ascent шрифта
 * выше заглавных букв), поэтому используем реальную рамку глифов.
 * Возвращает `null`, если браузер не умеет `actualBoundingBoxAscent`.
 */
export function measureInkAscent(text: string, style: LayoutFontStyle): number | null {
  const sample = text.length > 0 ? text : 'Н';
  if (!measureCtx) return null;
  measureCtx.font = cssFontString(style);
  const metrics = measureCtx.measureText(sample);
  const ascent = metrics.actualBoundingBoxAscent;
  return typeof ascent === 'number' && Number.isFinite(ascent) ? ascent : null;
}

/**
 * Ширина строки в pt. Учитывает межбуквенное расстояние.
 * Кэшируется: раскладка вызывается на каждом кадре перетаскивания.
 */
export function measureTextWidth(text: string, style: LayoutFontStyle): number {
  if (!text) return 0;
  const key = `${style.fontFamily}|${style.fontSize}|${style.bold ? 1 : 0}|${style.italic ? 1 : 0}|${
    style.letterSpacing
  }|${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;

  let width: number;
  if (!measureCtx) {
    // SSR/тесты: грубая оценка (средняя ширина глифа ~0.5em).
    width = text.length * style.fontSize * 0.52 + style.letterSpacing * Math.max(0, text.length - 1);
    widthCache.set(key, width);
    return width;
  }

  measureCtx.font = cssFontString(style);
  width = measureCtx.measureText(text).width;
  if (style.letterSpacing) {
    width += style.letterSpacing * Math.max(0, text.length - 1);
  }
  widthCache.set(key, width);
  if (widthCache.size > 6000) widthCache.clear();
  return width;
}

/** Высота строки, pt. */
export function getLineHeight(style: LayoutFontStyle): number {
  return style.fontSize * (style.lineHeight || 1.25);
}

/** Разбиение абзаца на слова с сохранением пробелов как разделителей. */
function splitWords(paragraph: string): string[] {
  return paragraph.split(/(\s+)/).filter((part) => part.length > 0);
}

/**
 * Перенос текста по ширине.
 *  - учитывает явные переводы строк `\n`;
 *  - переносит по словам;
 *  - слишком длинные слова режет посимвольно.
 */
export function wrapText(text: string, style: LayoutFontStyle, maxWidth: number): string[] {
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  const lines: string[] = [];
  const limit = Math.max(maxWidth, style.fontSize * 1.5);

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }
    const words = splitWords(paragraph);
    let current = '';
    for (const word of words) {
      const candidate = current + word;
      if (measureTextWidth(candidate, style) <= limit || current.trim().length === 0) {
        // Слово целиком не влезает даже в пустую строку — режем по символам.
        if (current.length === 0 && measureTextWidth(word, style) > limit) {
          let chunk = '';
          for (const char of word) {
            if (measureTextWidth(chunk + char, style) > limit && chunk.length > 0) {
              lines.push(chunk);
              chunk = char;
            } else {
              chunk += char;
            }
          }
          current = chunk;
          continue;
        }
        current = candidate;
      } else {
        lines.push(current.replace(/\s+$/, ''));
        current = word.replace(/^\s+/, '');
      }
    }
    lines.push(current.replace(/\s+$/, ''));
  }

  return lines.length > 0 ? lines : [''];
}

/** Полная раскладка текстового блока в рамке. */
export function layoutTextBlock(
  text: string,
  style: LayoutFontStyle,
  boxWidth: number,
  padding = 0,
): TextLayoutResult {
  const contentLimit = Math.max(1, boxWidth - padding * 2);
  const lines = wrapText(text, style, contentLimit);
  const lineWidths = lines.map((line) => measureTextWidth(line, style));
  const lineHeight = getLineHeight(style);
  return {
    lines,
    lineHeight,
    height: lines.length * lineHeight,
    contentWidth: lineWidths.reduce((max, value) => Math.max(max, value), 0),
    lineWidths,
  };
}

/** X-координата строки внутри рамки с учётом выравнивания. */
export function alignOffset(
  align: TextAlign,
  lineWidth: number,
  boxWidth: number,
  padding: number,
): number {
  const inner = boxWidth - padding * 2;
  switch (align) {
    case 'center':
      return padding + Math.max(0, (inner - lineWidth) / 2);
    case 'right':
      return padding + Math.max(0, inner - lineWidth);
    case 'justify':
    case 'left':
    default:
      return padding;
  }
}

/**
 * Дополнительный сдвиг слов для выравнивания по ширине (justify).
 * Возвращает массив сдвигов для каждого слова строки.
 */
export function justifyOffsets(
  line: string,
  style: LayoutFontStyle,
  boxWidth: number,
  padding: number,
): { words: string[]; offsets: number[] } {
  const words = line.split(' ').filter((word) => word.length > 0);
  if (words.length < 2) return { words: [line], offsets: [0] };
  const inner = boxWidth - padding * 2;
  const totalWidth = words.reduce((sum, word) => sum + measureTextWidth(word, style), 0);
  const gap = (inner - totalWidth) / (words.length - 1);
  const offsets: number[] = [];
  let cursor = 0;
  for (let i = 0; i < words.length; i += 1) {
    offsets.push(cursor);
    cursor += measureTextWidth(words[i], style) + gap;
  }
  return { words, offsets };
}

/** Вертикальное смещение текста внутри рамки. */
export function verticalOffset(
  align: VerticalAlign,
  contentHeight: number,
  boxHeight: number,
  padding: number,
): number {
  const inner = boxHeight - padding * 2;
  switch (align) {
    case 'middle':
      return padding + Math.max(0, (inner - contentHeight) / 2);
    case 'bottom':
      return padding + Math.max(0, inner - contentHeight);
    case 'top':
    default:
      return padding;
  }
}

/**
 * Оценка метрик шрифта (ascent/descent) в pt.
 * Используется для согласования базовой линии между canvas и PDF.
 */
export interface FontMetricsEstimate {
  ascent: number;
  descent: number;
  /** Расстояние от верха строки до базовой линии. */
  baseline: number;
}

/**
 * Оценка вертикальных метрик по данным fontkit (если известны) либо
 * типографским коэффициентам. `unitsPerEm` и `ascent` берутся из шрифта.
 */
export function estimateFontMetrics(
  fontSize: number,
  lineHeightMultiplier: number,
  fontAscent?: number,
  fontDescent?: number,
  unitsPerEm = 1000,
): FontMetricsEstimate {
  const ascentRatio = fontAscent && unitsPerEm ? fontAscent / unitsPerEm : 0.8;
  const descentRatio = fontDescent && unitsPerEm ? fontDescent / unitsPerEm : 0.2;
  const ascent = ascentRatio * fontSize;
  const descent = descentRatio * fontSize;
  const lineHeight = fontSize * (lineHeightMultiplier || 1.25);
  // Половина «лишнего» межстрочного расстояния добавляется сверху,
  // так же как это делает Konva.Text и браузерный layout.
  const halfLeading = Math.max(0, (lineHeight - (ascent + descent)) / 2);
  return { ascent, descent, baseline: halfLeading + ascent };
}

/** Очистка кэша измерений (после загрузки нового шрифта). */
export function clearTextMeasureCache(): void {
  widthCache.clear();
}

/**
 * ============================================================================
 *  Отрисовка текстовых объектов.
 * ============================================================================
 *
 *  Один и тот же расчёт раскладки (`computeTextBlockLayout`) используется:
 *    - для предпросмотра на Konva-канвасе (Konva.Shape + sceneFunc);
 *    - для растрового экспорта (PNG/JPEG/WebP);
 *    - для векторного экспорта в PDF (позиции базовых линий).
 *
 *  Благодаря этому текст в PDF стоит там же, где пользователь его видит,
 *  а кириллица рисуется реальными глифами встроенного шрифта.
 */

import type { TextPayload } from '@/types';
import {
  alignOffset,
  estimateFontMetrics,
  getLineHeight,
  justifyOffsets,
  layoutTextBlock,
  measureInkMetrics,
  measureTextWidth,
  verticalOffset,
  type LayoutFontStyle,
  type TextLayoutResult,
} from '@/utils/textLayout';
import { fontService } from '@/services/fontService';

/** Метрики шрифта. */
export interface FontMetrics {
  unitsPerEm: number;
  ascent: number;
  descent: number;
}

const METRICS_FALLBACK: FontMetrics = { unitsPerEm: 1000, ascent: 800, descent: 200 };
const metricsCache = new Map<string, FontMetrics>();

function metricsKey(fontId: string, bold: boolean, italic: boolean): string {
  return `${fontId}|${bold ? 'b' : 'n'}|${italic ? 'i' : 'n'}`;
}

/** Синхронные метрики (для отрисовки в кадре). */
export function getMetricsSync(fontId: string, bold: boolean, italic: boolean): FontMetrics {
  return metricsCache.get(metricsKey(fontId, bold, italic)) ?? METRICS_FALLBACK;
}

/** Асинхронная загрузка метрик шрифта. */
export async function ensureMetrics(
  fontId: string,
  bold: boolean,
  italic: boolean,
): Promise<FontMetrics> {
  const key = metricsKey(fontId, bold, italic);
  const cached = metricsCache.get(key);
  if (cached) return cached;
  const metrics = await fontService.getMetrics(fontId, bold, italic);
  const value: FontMetrics = metrics
    ? { unitsPerEm: metrics.unitsPerEm, ascent: metrics.ascent, descent: metrics.descent }
    : METRICS_FALLBACK;
  metricsCache.set(key, value);
  return value;
}

/** Прогрев метрик для объекта. */
export async function ensureTextMetrics(payload: TextPayload): Promise<void> {
  await Promise.all([
    ensureMetrics(payload.fontId, payload.bold, payload.italic),
    fontService.ensureFacesLoaded(payload.fontId),
  ]);
}

/** Загружены ли уже метрики (чтобы не перерисовывать лишний раз). */
export function hasTextMetrics(fontId: string, bold: boolean, italic: boolean): boolean {
  return metricsCache.has(metricsKey(fontId, bold, italic));
}

/** Стиль шрифта для раскладки. */
export function textStyleOf(payload: TextPayload): LayoutFontStyle {
  return {
    fontFamily: payload.fontFamily,
    fontSize: payload.fontSize,
    bold: payload.bold,
    italic: payload.italic,
    letterSpacing: payload.letterSpacing,
    lineHeight: payload.lineHeight,
  };
}

/** Одна строка с рассчитанной позицией. */
export interface TextLineLayout {
  text: string;
  /** X начала строки (для не-justify), pt. */
  x: number;
  /** Y базовой линии, pt от верха объекта. */
  baseline: number;
  /** Ширина строки, pt. */
  width: number;
}

/** Полная раскладка текстового блока. */
export interface TextBlockLayout {
  lines: TextLineLayout[];
  /** Высота строки, pt. */
  lineHeight: number;
  /** Расстояние от верха строки до базовой линии, pt. */
  baselineInLine: number;
  /** Высота всего текста, pt. */
  contentHeight: number;
  /** Максимальная ширина строки, pt. */
  contentWidth: number;
  ascent: number;
  descent: number;
  /** Итоговая высота блока (с отступами). */
  boxHeight: number;
  raw: TextLayoutResult;
}

/**
 * Расчёт раскладки текста внутри рамки объекта.
 * Учитывает выравнивание, межстрочный интервал, отступы и вертикальное
 * выравнивание — всё то, что видно на канвасе.
 */
export function computeTextBlockLayout(
  payload: TextPayload,
  width: number,
  height: number,
): TextBlockLayout {
  const style = textStyleOf(payload);
  const padding = Math.max(0, payload.padding);
  const raw = layoutTextBlock(payload.text || ' ', style, width, padding);
  const lineHeight = getLineHeight(style);
  const metrics = getMetricsSync(payload.fontId, payload.bold, payload.italic);
  const estimate = estimateFontMetrics(
    payload.fontSize,
    payload.lineHeight,
    metrics.ascent,
    metrics.descent,
    metrics.unitsPerEm,
  );
  const contentHeight = raw.lines.length * lineHeight;
  const boxHeight = payload.autoHeight ? contentHeight + padding * 2 : height;
  const vOffset = verticalOffset(payload.verticalAlign, contentHeight, boxHeight, padding);

  const lines: TextLineLayout[] = raw.lines.map((text, index) => {
    const lineWidth = raw.lineWidths[index] ?? 0;
    return {
      text,
      x: alignOffset(payload.align === 'justify' ? 'left' : payload.align, lineWidth, width, padding),
      width: lineWidth,
      baseline: vOffset + index * lineHeight + estimate.baseline,
    };
  });

  return {
    lines,
    lineHeight,
    baselineInLine: estimate.baseline,
    contentHeight,
    contentWidth: raw.contentWidth,
    ascent: estimate.ascent,
    descent: estimate.descent,
    boxHeight,
    raw,
  };
}

/**
 * Отступ от верхнего края объекта до **середины** букв первой строки (pt).
 *
 * Точка клика инструментом «Текст» становится центром будущего текста, а не
 * его верхом. Этот же отступ получает оверлей ввода (`padding-top`), поэтому
 * каретка начинается на одной высоте с текстом.
 */
export function textInkCenter(payload: TextPayload, boxHeight = 0): number {
  const height = Math.max(1, boxHeight || payload.fontSize * 1.4);
  const layout = computeTextBlockLayout(payload, 100000, height);
  const padding = Math.max(0, payload.padding);
  const firstLine = (payload.text ?? '').split('\n')[0];
  const style = {
    fontFamily: payload.fontFamily,
    fontSize: payload.fontSize,
    bold: payload.bold,
    italic: payload.italic,
    letterSpacing: payload.letterSpacing,
    lineHeight: payload.lineHeight,
  };
  const ink = measureInkMetrics(firstLine, style);
  const ascent = ink ? ink.ascent : layout.ascent;
  const descent = ink ? ink.descent : Math.max(0, layout.descent);
  const inkTop = padding + Math.max(0, layout.baselineInLine - ascent);
  return inkTop + (ascent + descent) / 2;
}

/** Итоговая ширина/высота объекта с учётом autoHeight. */
export function resolveTextBox(payload: TextPayload,
  width: number,
  height: number,
): { width: number; height: number } {
  if (!payload.autoHeight) return { width, height };
  const layout = computeTextBlockLayout(payload, width, height);
  return { width, height: Math.max(layout.boxHeight, payload.fontSize + payload.padding * 2) };
}

/** Параметры отрисовки на canvas. */
export interface PaintTextOptions {
  /** Множитель для растрового экспорта. */
  scale?: number;
  /** Дополнительная прозрачность. */
  alpha?: number;
}

/**
 * Отрисовка текстового объекта на canvas 2D.
 * Координаты — локальные для объекта (0..width, 0..height).
 */
export function paintTextObject(
  ctx: CanvasRenderingContext2D,
  payload: TextPayload,
  width: number,
  height: number,
  options: PaintTextOptions = {},
): void {
  const { scale = 1, alpha = 1 } = options;
  const layout = computeTextBlockLayout(payload, width, height);
  const style = textStyleOf(payload);
  const opacity = Math.max(0, Math.min(1, alpha));

  ctx.save();
  ctx.scale(scale, scale);
  // ВАЖНО: умножаем, а не перезаписываем — так сохраняется прозрачность,
  // заданная на уровне Konva-узла/слоя.
  ctx.globalAlpha *= opacity;

  // Фон рамки.
  if (payload.backgroundColor) {
    ctx.save();
    ctx.globalAlpha *= Math.max(0, Math.min(1, payload.backgroundOpacity));
    ctx.fillStyle = payload.backgroundColor;
    ctx.fillRect(0, 0, width, layout.boxHeight);
    ctx.restore();
  }

  // Рамка.
  if (payload.borderColor && payload.borderWidth > 0) {
    ctx.save();
    ctx.strokeStyle = payload.borderColor;
    ctx.lineWidth = payload.borderWidth;
    const inset = payload.borderWidth / 2;
    ctx.strokeRect(inset, inset, Math.max(0, width - payload.borderWidth), Math.max(0, layout.boxHeight - payload.borderWidth));
    ctx.restore();
  }

  ctx.font = `${
    payload.italic ? 'italic ' : ''
  }${payload.bold ? '700' : '400'} ${payload.fontSize}px "${payload.fontFamily}"`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = payload.color;

  for (const line of layout.lines) {
    const x = line.x;

    if (payload.shadow) {
      ctx.save();
      ctx.globalAlpha *= 0.55;
      paintLineShadow(ctx, payload, line.text, x, line.baseline, width);
      ctx.restore();
    }

    if (payload.align === 'justify' && line !== layout.lines[layout.lines.length - 1]) {
      const { words, offsets } = justifyOffsets(line.text, style, width, payload.padding);
      const startX = payload.padding;
      for (let i = 0; i < words.length; i += 1) {
        drawTextWithSpacing(ctx, words[i], startX + offsets[i], line.baseline, payload.letterSpacing);
      }
    } else {
      drawTextWithSpacing(ctx, line.text, x, line.baseline, payload.letterSpacing);
    }

    if (payload.underline) {
      ctx.save();
      ctx.strokeStyle = payload.color;
      ctx.lineWidth = Math.max(0.6, payload.fontSize * 0.06);
      const underlineY = line.baseline + layout.descent * 0.45;
      ctx.beginPath();
      ctx.moveTo(x, underlineY);
      ctx.lineTo(x + line.width, underlineY);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.restore();
}

/** Тень под строкой (улучшает читаемость поверх сканов). */
function paintLineShadow(
  ctx: CanvasRenderingContext2D,
  payload: TextPayload,
  text: string,
  x: number,
  baseline: number,
  width: number,
): void {
  const offset = Math.max(0.5, payload.fontSize * 0.06);
  ctx.fillStyle = '#ffffff';
  for (const [dx, dy] of [
    [-offset, 0],
    [offset, 0],
    [0, -offset],
    [0, offset],
    [-offset, -offset],
    [offset, offset],
  ]) {
    drawTextWithSpacing(ctx, text, x + dx, baseline + dy, payload.letterSpacing);
  }
  void width;
}

/** Отрисовка текста с межбуквенным расстоянием. */
export function drawTextWithSpacing(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  baseline: number,
  letterSpacing: number,
): void {
  if (!letterSpacing) {
    ctx.fillText(text, x, baseline);
    return;
  }
  let cursor = x;
  for (const char of text) {
    ctx.fillText(char, cursor, baseline);
    cursor += ctx.measureText(char).width + letterSpacing;
  }
}

/**
 * Ширина текста с межбуквенным расстоянием (в локальных координатах объекта).
 */
export function measureStyledText(text: string, payload: TextPayload): number {
  return measureTextWidth(text, textStyleOf(payload));
}

/** Строковое представление текста объекта (для DOCX/TXT-экспорта). */
export function textObjectPlainText(payload: TextPayload): string {
  return payload.text.replace(/\r\n?/g, '\n');
}

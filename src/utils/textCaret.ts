/**
 * ============================================================================
 *  Каретка текста: точка на холсте → позиция в строке.
 * ============================================================================
 *
 *  Нужно, чтобы при клике инструментом «Текст» по уже написанному тексту
 *  каретка встала ровно туда, куда нажали. Раскладку берём ту же, что и
 *  рендерер (`computeTextBlockLayout`), поэтому позиции совпадают с картинкой.
 */

import type { TextPayload } from '@/types';
import { computeTextBlockLayout } from '@/services/textRenderService';
import { measureTextWidth } from '@/utils/textLayout';

/** Стиль шрифта для измерения ширины префиксов строки. */
function styleOf(payload: TextPayload) {
  return {
    fontFamily: payload.fontFamily,
    fontId: payload.fontId,
    fontSize: payload.fontSize,
    bold: payload.bold,
    italic: payload.italic,
    letterSpacing: payload.letterSpacing,
    lineHeight: payload.lineHeight,
    underline: payload.underline,
  };
}

/**
 * Индекс символа, ближайшего к точке.
 *
 * `x`/`y` — координаты в локальной системе объекта (pt от левого верхнего угла,
 * без учёта поворота объекта).
 */
export function caretOffsetAtPoint(
  payload: TextPayload,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const text = payload.text ?? '';
  if (text.length === 0) return 0;

  const layout = computeTextBlockLayout(payload, Math.max(4, width), Math.max(4, height));
  const padding = Math.max(0, payload.padding);
  // Строка, в которую попала точка (строки идут сверху вниз с шагом lineHeight).
  const lineIndex = Math.min(
    Math.max(0, layout.lines.length - 1),
    Math.max(0, Math.floor((y - padding) / Math.max(1, layout.lineHeight))),
  );

  // Позиция начала каждой строки в исходном тексте.
  const starts: number[] = [];
  let cursor = 0;
  for (const line of layout.lines) {
    if (line.text.length === 0) {
      starts.push(cursor);
      cursor += 1;
      continue;
    }
    const found = text.indexOf(line.text, cursor);
    const start = found >= 0 ? found : cursor;
    starts.push(start);
    cursor = start + line.text.length;
  }

  const line = layout.lines[lineIndex];
  if (!line) return text.length;
  const start = starts[lineIndex] ?? 0;
  const style = styleOf(payload);
  const relativeX = x - line.x;

  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= line.text.length; index += 1) {
    const prefix = line.text.slice(0, index);
    const distance = Math.abs(measureTextWidth(prefix, style) - relativeX);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }

  return Math.min(text.length, start + best);
}

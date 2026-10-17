/**
 * ============================================================================
 *  Векторная отрисовка штампа/печати в PDF (pdf-lib).
 * ============================================================================
 *
 *  Штамп рисуется настоящими векторными примитивами: рамки, разделители,
 *  текст (включая текст по кругу) и логотип. Кириллица остаётся текстом и
 *  использует встроенный TTF-шрифт, поэтому «кракозябр» не бывает.
 *
 *  Система координат штампа: (0,0) — левый верхний угол, Y вниз.
 *  `ctx.toPdf(x, y)` переводит локальную точку штампа в точку PDF
 *  (с учётом поворота страницы и поворота объекта на странице).
 *  Для pdf-lib `rotate` передаётся как `ctx.rotate - локальный_угол`.
 */

import { BlendMode, LineCapStyle, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import type { StampTemplate } from '@/types';
import { hexToRgb } from '@/utils/pdf';
import {
  computeStampLayout,
  type StampFontResolver,
  type StampLayout,
} from '@/services/stampRenderService';

/** Контекст отрисовки штампа на странице PDF. */
export interface StampPdfContext {
  /** Локальная точка штампа → точка в PDF. */
  toPdf: (localX: number, localYDown: number) => { x: number; y: number };
  /** Базовый угол поворота для pdf-lib (pageRotation - objectRotation). */
  rotate: number;
  /** Локальный масштаб (обычно 1). */
  scale?: number;
  /** Текст → семейство (для замеров ширины). */
  resolveFamily: StampFontResolver;
  /** Встраивание шрифта с кэшированием. */
  embedFont: (fontId: string, bold: boolean, italic: boolean) => Promise<PDFFont>;
  /** Уже встроенный логотип (PNG/JPEG). */
  logoImage?: PDFImage | null;
  /** Переопределение первой строки текста. */
  textOverride?: string | null;
  /** Переопределение цвета. */
  colorOverride?: string | null;
  /** Прозрачность объекта (умножается на прозрачность шаблона). */
  alpha?: number;
}

/** Курсив в PDF: наклон текстовой матрицы (градусы). */
const ITALIC_SKEW = 12;

/** SVG-путь прямоугольника со скруглёнными углами (Y вниз). */
function roundedRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const x2 = x + width;
  const y2 = y + height;
  if (r <= 0.01) {
    return `M ${x} ${y} L ${x2} ${y} L ${x2} ${y2} L ${x} ${y2} Z`;
  }
  const c = r * 0.5523;
  return [
    `M ${x + r} ${y}`,
    `L ${x2 - r} ${y}`,
    `C ${x2 - r + c} ${y} ${x2} ${y + r - c} ${x2} ${y + r}`,
    `L ${x2} ${y2 - r}`,
    `C ${x2} ${y2 - r + c} ${x2 - r + c} ${y2} ${x2 - r} ${y2}`,
    `L ${x + r} ${y2}`,
    `C ${x + r - c} ${y2} ${x} ${y2 - r + c} ${x} ${y2 - r}`,
    `L ${x} ${y + r}`,
    `C ${x} ${y + r - c} ${x + r - c} ${y} ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

/** Отрисовка одной рамки (прямоугольник или эллипс). */
function drawFrame(
  page: PDFPage,
  ctx: StampPdfContext,
  frame: StampLayout['frames'][number],
  borderWidth: number,
  inset: number,
  color: string,
  opacity: number,
): void {
  if (borderWidth <= 0) return;
  const width = frame.width - inset * 2;
  const height = frame.height - inset * 2;
  if (width <= 0 || height <= 0) return;
  const { r, g, b } = hexToRgb(color);

  if (frame.shape === 'rect') {
    const path = roundedRectPath(
      frame.x + inset,
      frame.y + inset,
      width,
      height,
      frame.radius,
    );
    const point = ctx.toPdf(0, 0);
    page.drawSvgPath(path, {
      x: point.x,
      y: point.y,
      rotate: degrees(ctx.rotate),
      borderColor: rgb(r, g, b),
      borderWidth,
      borderOpacity: opacity,
    });
    return;
  }

  const center = ctx.toPdf(frame.x + frame.width / 2, frame.y + frame.height / 2);
  page.drawEllipse({
    x: center.x,
    y: center.y,
    xScale: width / 2,
    yScale: height / 2,
    rotate: degrees(ctx.rotate),
    borderColor: rgb(r, g, b),
    borderWidth,
    borderOpacity: opacity,
  });
}

/**
 * Отрисовка штампа на странице PDF. Возвращает использованную геометрию.
 * Если логотип не был передан (например, SVG), он пропускается — об этом
 * сообщает вызывающая сторона через предупреждения.
 */
export async function drawStampToPdfPage(
  page: PDFPage,
  template: StampTemplate,
  ctx: StampPdfContext,
): Promise<StampLayout> {
  const layout = computeStampLayout(template, ctx.resolveFamily, {
    textOverride: ctx.textOverride ?? null,
    colorOverride: ctx.colorOverride ?? null,
  });
  const alpha = Math.max(0, Math.min(1, ctx.alpha ?? 1)) * Math.max(0, Math.min(1, layout.opacity));

  // Фон (если задан).
  if (layout.backgroundColor) {
    const { r, g, b } = hexToRgb(layout.backgroundColor);
    const origin = ctx.toPdf(0, 0);
    if (layout.shape === 'rect') {
      const path = roundedRectPath(0, 0, layout.width, layout.height, layout.cornerRadius);
      page.drawSvgPath(path, {
        x: origin.x,
        y: origin.y,
        rotate: degrees(ctx.rotate),
        color: rgb(r, g, b),
        opacity: alpha,
      });
    } else {
      const center = ctx.toPdf(layout.width / 2, layout.height / 2);
      page.drawEllipse({
        x: center.x,
        y: center.y,
        xScale: layout.width / 2,
        yScale: layout.height / 2,
        rotate: degrees(ctx.rotate),
        color: rgb(r, g, b),
        opacity: alpha,
      });
    }
  }

  // Рамки: вторая (внутренняя) — со смещением.
  const offset = layout.doubleBorder ? layout.borderWidth + layout.borderGap : 0;
  const inner = layout.frames[1];
  const outer = layout.frames[0];
  if (inner) drawFrame(page, ctx, inner, layout.borderWidth, offset, layout.color, alpha);
  if (outer) drawFrame(page, ctx, outer, layout.borderWidth, 0, layout.color, alpha);

  // Разделитель.
  if (layout.divider) {
    const start = ctx.toPdf(layout.divider.x1, layout.divider.y1);
    const end = ctx.toPdf(layout.divider.x2, layout.divider.y2);
    const { r, g, b } = hexToRgb(layout.color);
    page.drawLine({
      start,
      end,
      thickness: Math.max(0.6, layout.borderWidth * 0.6),
      color: rgb(r, g, b),
      opacity: alpha,
      lineCap: LineCapStyle.Round,
    });
  }

  // Прямые строки текста.
  for (const line of layout.lines) {
    const font = await ctx.embedFont(line.fontId, line.bold, line.italic);
    const { r, g, b } = hexToRgb(line.color);
    const skew = line.italic ? ITALIC_SKEW : 0;

    if (line.letterSpacing > 0.01) {
      // Посимвольно — так межбуквенное расстояние точно соблюдается.
      let advance = 0;
      for (const char of line.text) {
        const point = ctx.toPdf(line.x + advance, line.baseline);
        page.drawText(char, {
          x: point.x,
          y: point.y,
          size: line.fontSize,
          font,
          color: rgb(r, g, b),
          opacity: alpha,
          rotate: degrees(ctx.rotate),
          xSkew: degrees(skew),
        });
        advance += font.widthOfTextAtSize(char, line.fontSize) + line.letterSpacing;
      }
    } else {
      const point = ctx.toPdf(line.x, line.baseline);
      page.drawText(line.text, {
        x: point.x,
        y: point.y,
        size: line.fontSize,
        font,
        color: rgb(r, g, b),
        opacity: alpha,
        rotate: degrees(ctx.rotate),
        xSkew: degrees(skew),
      });
    }
  }

  // Текст по кругу.
  for (const char of layout.chars) {
    const font = await ctx.embedFont(template.fontId, char.bold, char.italic);
    const { r, g, b } = hexToRgb(char.color);
    const point = ctx.toPdf(char.x, char.y);
    page.drawText(char.char, {
      x: point.x,
      y: point.y,
      size: char.fontSize,
      font,
      color: rgb(r, g, b),
      opacity: alpha,
      rotate: degrees(ctx.rotate - char.angle),
    });
  }

  // Логотип.
  if (layout.logo && ctx.logoImage) {
    const point = ctx.toPdf(layout.logo.x, layout.logo.y + layout.logo.height);
    page.drawImage(ctx.logoImage, {
      x: point.x,
      y: point.y,
      width: layout.logo.width,
      height: layout.logo.height,
      rotate: degrees(ctx.rotate),
      opacity: alpha * Math.max(0, Math.min(1, layout.logo.opacity)),
      blendMode: BlendMode.Normal,
    });
  }

  return layout;
}

/**
 * ============================================================================
 *  Круглая печать → PDF (pdf-lib, векторно).
 * ============================================================================
 *
 *  Рисуем не картинку, а настоящие векторные примитивы: кольца, точки краски
 *  и разделительную окружность. Поэтому оттиск в PDF остаётся резким при
 *  любом увеличении и не «мылится» при печати.
 *
 *  Текст и логотип печати рисует общий код штампов (`stampPdfRenderer`),
 *  сюда приходит только «краска».
 *
 *  Система координат: (0,0) — левый верхний угол печати, Y вниз;
 *  `ctx.toPdf(x, y)` переводит локальную точку в точку страницы с учётом
 *  поворота страницы и поворота объекта.
 */

import { degrees, rgb, type PDFPage } from 'pdf-lib';
import { hexToRgb } from '@/utils/pdf';
import type { SealInkGeometry, SealRingGeometry } from '@/services/sealRenderService';

/** Минимальный контекст, нужный печати: перевод координат и базовый поворот. */
export interface SealPdfContext {
  toPdf: (localX: number, localYDown: number) => { x: number; y: number };
  /** Угол для pdf-lib: pageRotation − objectRotation. */
  rotate: number;
}

/** Отрисовка одного кольца. */
function drawRing(
  page: PDFPage,
  ctx: SealPdfContext,
  ring: SealRingGeometry,
  color: ReturnType<typeof rgb>,
  opacity: number,
): void {
  const width = Math.max(0.3, ring.width);
  if (ring.path) {
    // Неровный контур: путь уже в локальных координатах (Y вниз), поэтому
    // достаточно поставить его в точку начала координат печати.
    const origin = ctx.toPdf(0, 0);
    page.drawSvgPath(ring.path, {
      x: origin.x,
      y: origin.y,
      rotate: degrees(ctx.rotate),
      borderColor: color,
      borderWidth: width,
      borderOpacity: opacity,
    });
    return;
  }
  const center = ctx.toPdf(ring.cx, ring.cy);
  page.drawEllipse({
    x: center.x,
    y: center.y,
    xScale: Math.max(0.5, ring.radius),
    yScale: Math.max(0.5, ring.radius),
    rotate: degrees(ctx.rotate),
    borderColor: color,
    borderWidth: width,
    borderOpacity: opacity,
  });
}

/**
 * Отрисовка «краски» печати на странице PDF.
 *
 * `alpha` — общая прозрачность объекта и шаблона (0..1).
 */
export function drawSealInkToPdfPage(
  page: PDFPage,
  ctx: SealPdfContext,
  geometry: SealInkGeometry,
  color: string,
  alpha: number,
): void {
  const opacity = Math.max(0, Math.min(1, alpha));
  const { r, g, b } = hexToRgb(color);
  const stroke = rgb(r, g, b);

  // Второй прокат — первым и полупрозрачным, как и на холсте.
  for (const ring of geometry.ghostRings) {
    drawRing(page, ctx, ring, stroke, opacity * 0.28);
  }

  for (const ring of geometry.rings) {
    drawRing(page, ctx, ring, stroke, opacity);
  }

  // Зерно: мелкие точки краски. Больше 160 точек не рисуем — это уже
  // незаметно глазу, но заметно по размеру PDF.
  for (const speck of geometry.specks.slice(0, 160)) {
    const point = ctx.toPdf(speck.x, speck.y);
    page.drawCircle({
      x: point.x,
      y: point.y,
      size: Math.max(0.2, speck.radius),
      color: stroke,
      opacity: opacity * speck.alpha,
    });
  }

  if (geometry.divider) {
    const center = ctx.toPdf(geometry.divider.cx, geometry.divider.cy);
    page.drawEllipse({
      x: center.x,
      y: center.y,
      xScale: Math.max(0.5, geometry.divider.radius),
      yScale: Math.max(0.5, geometry.divider.radius),
      rotate: degrees(ctx.rotate),
      borderColor: stroke,
      borderWidth: Math.max(0.2, geometry.divider.width),
      borderOpacity: opacity,
    });
  }
}

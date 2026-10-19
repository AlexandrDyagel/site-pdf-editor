/**
 * ============================================================================
 *  Штрихи от руки (кисть, маркер, корректор, подписи).
 * ============================================================================
 *
 *  Геометрия штриха вычисляется через `perfect-freehand`: получается замкнутый
 *  контур (outline), который одинаково рисуется:
 *    - на Konva-канвасе (canvas 2D);
 *    - в PDF (pdf-lib, заливка векторного контура);
 *    - в SVG (экспорт подписи/рисунка).
 *
 *  Именно поэтому рисунок не «пикселизируется», а остаётся векторным.
 */

import { getStroke } from 'perfect-freehand';
import type { StrokeData, StrokePoint } from '@/types';
import { simplifyPolyline, type Point } from '@/utils/geometry';

/** Настройки генерации контура. */
export interface OutlineOptions {
  /** Коэффициент сглаживания (0 — ломаная, 1 — максимальное сглаживание). */
  smoothing?: number;
  /** Уплощение кривой. */
  streamline?: number;
  /** Минимальная длина штриха для отрисовки. */
  minLength?: number;
}

const DEFAULT_OPTIONS: Required<OutlineOptions> = {
  smoothing: 0.55,
  streamline: 0.45,
  minLength: 0.5,
};

/** Точки штриха в формате perfect-freehand: [x, y, pressure]. */
export function toFreehandPoints(points: readonly StrokePoint[]): number[][] {
  return points.map((point) => [point.x, point.y, point.pressure > 0 ? point.pressure : 0.5]);
}

/**
 * Замкнутый контур штриха (полигон).
 * Возвращает точки в тех же координатах, что и входные.
 */
export function getStrokeOutline(
  stroke: StrokeData,
  options: OutlineOptions = {},
): Point[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (stroke.points.length === 0) return [];
  if (stroke.points.length === 1) {
    // Точка-«клякса» — рисуем маленький круг.
    const point = stroke.points[0];
    const radius = Math.max(stroke.width / 2, 0.1);
    const circle: Point[] = [];
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * Math.PI * 2;
      circle.push({ x: point.x + Math.cos(angle) * radius, y: point.y + Math.sin(angle) * radius });
    }
    return circle;
  }

  const outline = getStroke(toFreehandPoints(stroke.points), {
    size: Math.max(stroke.width, 0.2),
    thinning: stroke.tool === 'eraser' ? 0 : 0.55,
    smoothing: opts.smoothing,
    streamline: opts.streamline,
    simulatePressure: stroke.points.every((point) => point.pressure === 0.5),
    last: true,
    start: { taper: 0, cap: true },
    end: { taper: 0, cap: true },
  });

  const points: Point[] = outline.map(([x, y]) => ({ x, y }));
  // Слишком подробный контур раздувает PDF, поэтому упрощаем геометрию.
  return simplifyPolyline(points, Math.max(0.05, stroke.width / 24));
}

/** SVG-путь замкнутого контура (только M/L/Z — совместимо с pdf-lib). */
export function outlineToPath(points: readonly Point[], close = true): string {
  if (points.length === 0) return '';
  const commands = points.map(
    (point, index) =>
      `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`,
  );
  return `${commands.join(' ')}${close ? ' Z' : ''}`;
}

/** Аккуратный вывод числа в SVG/PDF. */
function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/**
 * Отрисовка штриха на canvas 2D в текущей системе координат.
 * Используется и для превью (Konva.Shape), и для растрового экспорта.
 */
export function paintStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeData,
  options: { scale?: number; alpha?: number } = {},
): void {
  const { scale = 1, alpha = 1 } = options;
  if (stroke.points.length === 0) return;
  const points = getStrokeOutline(stroke);
  if (points.length < 3) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0].x * scale, points[0].y * scale);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i].x * scale, points[i].y * scale);
  }
  ctx.closePath();
  // Умножаем — сохраняем альфу, заданную на уровне Konva-узла/слоя.
  ctx.globalAlpha *= Math.max(0, Math.min(1, stroke.opacity * alpha));
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = stroke.color;
  ctx.fill();
  ctx.restore();
}

/** Отрисовка набора штрихов. */
export function paintStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: readonly StrokeData[],
  options: { scale?: number; alpha?: number } = {},
): void {
  for (const stroke of strokes) paintStroke(ctx, stroke, options);
}

/** SVG-элемент для набора штрихов (экспорт подписи/рисунка). */
export function strokesToSvg(
  strokes: readonly StrokeData[],
  width: number,
  height: number,
  options: { scale?: number; background?: string | null } = {},
): string {
  const { scale = 1, background = null } = options;
  const paths = strokes
    .map((stroke) => {
      const outline = getStrokeOutline(stroke);
      if (outline.length < 3) return '';
      return `<path d="${outlineToPath(outline)}" fill="${stroke.color}" fill-opacity="${round(
        stroke.opacity,
      )}" transform="scale(${round(scale)})" />`;
    })
    .filter(Boolean)
    .join('\n  ');

  const backgroundRect = background
    ? `\n  <rect width="100%" height="100%" fill="${background}" />`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${round(width * scale)}" height="${round(
    height * scale,
  )}" viewBox="0 0 ${round(width)} ${round(height)}">${backgroundRect}
  ${paths}
</svg>`;
}

/**
 * Нормализация нарисованных точек: приведение к локальной системе объекта
 * (левый верхний угол bbox = 0,0) и вычисление размеров «дизайнерской» области.
 */
export function normalizeStrokePoints(
  points: readonly StrokePoint[],
): { points: StrokePoint[]; offsetX: number; offsetY: number; width: number; height: number } {
  if (points.length === 0) {
    return { points: [], offsetX: 0, offsetY: 0, width: 0, height: 0 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    points: points.map((point) => ({ ...point, x: point.x - minX, y: point.y - minY })),
    offsetX: minX,
    offsetY: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
  };
}

/**
 * Масштабирование штриха (например, при изменении размера объекта
 * или при экспорте с другим DPI).
 */
export function scaleStroke(stroke: StrokeData, factor: number, origin: Point = { x: 0, y: 0 }): StrokeData {
  return {
    ...stroke,
    width: stroke.width * factor,
    points: stroke.points.map((point) => ({
      ...point,
      x: origin.x + (point.x - origin.x) * factor,
      y: origin.y + (point.y - origin.y) * factor,
    })),
  };
}

/** Масштабирование набора штрихов. */
export function scaleStrokes(strokes: readonly StrokeData[], factor: number): StrokeData[] {
  return strokes.map((stroke) => scaleStroke(stroke, factor));
}

/** Пересчёт ширины при изменении размера объекта. */
export function rescaleStrokesForBox(
  strokes: readonly StrokeData[],
  designWidth: number,
  designHeight: number,
  targetWidth: number,
  targetHeight: number,
): StrokeData[] {
  const scaleX = designWidth > 0 ? targetWidth / designWidth : 1;
  const scaleY = designHeight > 0 ? targetHeight / designHeight : 1;
  const factor = (scaleX + scaleY) / 2;
  return strokes.map((stroke) => ({
    ...stroke,
    width: stroke.width * factor,
    points: stroke.points.map((point) => ({ ...point, x: point.x * scaleX, y: point.y * scaleY })),
  }));
}

/** Есть ли в наборе штрихи, требующие «стирания» (корректор). */
export function hasEraserStrokes(strokes: readonly StrokeData[]): boolean {
  return strokes.some((stroke) => stroke.tool === 'eraser');
}

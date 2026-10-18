/**
 * Геометрические утилиты: точки, прямоугольники, повороты, прилипание.
 */

import type { MarqueeRect, ObjectTransform } from '@/types';

/** Точка на плоскости. */
export interface Point {
  x: number;
  y: number;
}

/** Прямоугольник (левый верхний угол + размеры). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Ограничение значения. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Приведение угла к диапазону [0, 360). */
export function normalizeAngle(angle: number): number {
  const result = angle % 360;
  return result < 0 ? result + 360 : result;
}

/** Градусы → радианы. */
export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Радианы → градусы. */
export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** Округление до шага. */
export function roundTo(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

/** Округление до 2 знаков (для хранения координат). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Расстояние между точками. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Поворот точки вокруг центра на угол (градусы, по часовой стрелке в экранной СК). */
export function rotatePoint(point: Point, center: Point, degrees: number): Point {
  const rad = toRadians(degrees);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/** Центр прямоугольника. */
export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Границы набора точек. */
export function boundsOfPoints(points: readonly Point[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Объединение прямоугольников. */
export function unionRects(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Пересечение прямоугольников (null, если не пересекаются). */
export function intersectRects(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Попадание точки внутрь прямоугольника. */
export function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** Прямоугольник по двум точкам (для marquee и dragging-инструментов). */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * Квадрат по двум точкам — ограничение рисования при зажатом Shift.
 *
 * Угол, от которого тянут, остаётся на месте, а сторона равна большему из
 * смещений, поэтому фигура не «прыгает» при смене направления.
 */
export function squareFromPoints(a: Point, b: Point): Rect {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  const signX = dx < 0 ? -1 : 1;
  const signY = dy < 0 ? -1 : 1;
  return {
    x: Math.min(a.x, a.x + signX * size),
    y: Math.min(a.y, a.y + signY * size),
    width: size,
    height: size,
  };
}

/**
 * Рамка правильного (равностороннего) треугольника по двум точкам.
 *
 * Высота правильного треугольника = сторона × √3/2, поэтому рамка не квадратная:
 * иначе треугольник, заполняющий рамку, был бы только равнобедренным.
 */
export function equilateralTriangleBox(a: Point, b: Point): Rect {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  const height = size * (Math.sqrt(3) / 2);
  const signX = dx < 0 ? -1 : 1;
  const signY = dy < 0 ? -1 : 1;
  return {
    x: Math.min(a.x, a.x + signX * size),
    y: Math.min(a.y, a.y + signY * height),
    width: size,
    height,
  };
}

/**
 * Точка, привязанная к направлению, кратному `stepDegrees` (для линий и стрелок
 * при зажатом Shift). Длина отрезка сохраняется.
 */
export function snapPointToAngle(start: Point, end: Point, stepDegrees = 45): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const step = toRadians(stepDegrees) || Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const length = Math.hypot(dx, dy);
  return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
}

/** Нормализация прямоугольника (положительные размеры). */
export function normalizeRect(rect: Rect): Rect {
  return {
    x: rect.width < 0 ? rect.x + rect.width : rect.x,
    y: rect.height < 0 ? rect.y + rect.height : rect.y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

/**
 * Габаритный прямоугольник повёрнутого объекта (axis-aligned) —
 * нужен для выделения рамкой и проверок выхода за страницу.
 */
export function rotatedBounds(transform: ObjectTransform): Rect {
  const { x, y, width, height, rotation } = transform;
  if (!rotation) return { x, y, width, height };
  const center: Point = { x: x + width / 2, y: y + height / 2 };
  const corners: Point[] = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ].map((p) => rotatePoint(p, center, rotation));
  return boundsOfPoints(corners);
}

/** Габариты группы объектов. */
export function boundsOfTransforms(items: readonly ObjectTransform[]): Rect {
  if (items.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  return unionRects(items.map((item) => rotatedBounds(item)));
}

/**
 * Прилипание значения к ближайшей «направляющей» из списка.
 * Возвращает новое значение и величину смещения (для отрисовки линии-подсказки).
 */
export function snapValue(
  value: number,
  guides: readonly number[],
  tolerance: number,
): { value: number; snapped: number | null } {
  let best: number | null = null;
  let bestDistance = tolerance;
  for (const guide of guides) {
    const delta = Math.abs(guide - value);
    if (delta <= bestDistance) {
      bestDistance = delta;
      best = guide;
    }
  }
  return best === null ? { value, snapped: null } : { value: best, snapped: best };
}

/** Точки рамки выделения (marquee) → прямоугольник. */
export function marqueeToRect(marquee: MarqueeRect): Rect {
  return normalizeRect(marquee);
}

/**
 * Разбиение полилинии на сегменты (используется для векторного экспорта).
 */
export function polylineSegments(points: readonly Point[]): [Point, Point][] {
  const segments: [Point, Point][] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    segments.push([points[i], points[i + 1]]);
  }
  return segments;
}

/**
 * Упрощение полилинии алгоритмом Рамера — Дугласа — Пекера.
 * Уменьшает количество точек без заметной потери качества.
 */
export function simplifyPolyline(points: readonly Point[], tolerance = 0.6): Point[] {
  if (points.length <= 2) return [...points];

  const sqTolerance = tolerance * tolerance;
  const sqDistanceToSegment = (p: Point, a: Point, b: Point): number => {
    let x = a.x;
    let y = a.y;
    let dx = b.x - x;
    let dy = b.y - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = b.x;
        y = b.y;
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }
    dx = p.x - x;
    dy = p.y - y;
    return dx * dx + dy * dy;
  };

  const simplifyStep = (first: number, last: number, output: Point[]): void => {
    let maxSqDistance = sqTolerance;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const sqDistance = sqDistanceToSegment(points[i], points[first], points[last]);
      if (sqDistance > maxSqDistance) {
        index = i;
        maxSqDistance = sqDistance;
      }
    }
    if (index === -1) return;
    if (index - first > 1) simplifyStep(first, index, output);
    output.push(points[index]);
    if (last - index > 1) simplifyStep(index, last, output);
  };

  const result: Point[] = [points[0]];
  simplifyStep(0, points.length - 1, result);
  result.push(points[points.length - 1]);
  return result;
}

/** Линейная интерполяция. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

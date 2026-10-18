/**
 * ============================================================================
 *  Пути многоугольников и треугольников.
 * ============================================================================
 *
 *  Один и тот же SVG-путь используется и на холсте (`Konva.Path`), и в PDF
 *  (`page.drawSvgPath`), поэтому фигура выглядит одинаково в редакторе и в
 *  файле. Координаты локальные (0…width, 0…height) и «y вниз», как у остальных
 *  фигур редактора.
 */

export interface PathPoint {
  x: number;
  y: number;
}

/** Минимальное и максимальное число сторон многоугольника. */
export const POLYGON_MIN_SIDES = 3;
export const POLYGON_MAX_SIDES = 24;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Число сторон с ограничением и приведением к целому. */
export function normalizeSides(sides: number | undefined | null): number {
  const value = typeof sides === 'number' && Number.isFinite(sides) ? Math.round(sides) : 5;
  return Math.max(POLYGON_MIN_SIDES, Math.min(POLYGON_MAX_SIDES, value));
}

/**
 * Вершины правильного многоугольника, вписанного в рамку `width × height`.
 *
 * Первая вершина — сверху по центру, дальше по часовой стрелке. Радиусы по
 * осям разные, поэтому многоугольник растягивается вместе с рамкой объекта.
 * `flipY` переводит «y вниз» (холст) в «y вверх» (система PDF).
 */
export function polygonVertices(
  width: number,
  height: number,
  sides: number,
  flipY = false,
): PathPoint[] {
  const count = normalizeSides(sides);
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2;
  const ry = height / 2;
  const points: PathPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
    const y = cy + ry * Math.sin(angle);
    points.push({ x: cx + rx * Math.cos(angle), y: flipY ? height - y : y });
  }
  return points;
}

/**
 * SVG-путь многоугольника со скруглёнными углами.
 *
 * Скругление — квадратичная кривая через вершину: радиус ограничен половиной
 * длины смежных сторон, поэтому на треугольнике углы не «выворачиваются».
 */
export function polygonPath(
  width: number,
  height: number,
  sides: number,
  cornerRadius = 0,
  flipY = false,
): string {
  const points = polygonVertices(width, height, sides, flipY);
  const count = points.length;
  const limit = Math.min(width, height) / 3;
  const radius = Math.max(0, Math.min(cornerRadius, limit));

  if (radius <= 0.01) {
    return `${points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`)
      .join(' ')} Z`;
  }

  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const current = points[index];
    const previous = points[(index - 1 + count) % count];
    const next = points[(index + 1) % count];

    const toPreviousX = previous.x - current.x;
    const toPreviousY = previous.y - current.y;
    const toNextX = next.x - current.x;
    const toNextY = next.y - current.y;
    const previousLength = Math.hypot(toPreviousX, toPreviousY) || 1;
    const nextLength = Math.hypot(toNextX, toNextY) || 1;

    const corner = Math.min(radius, previousLength / 2, nextLength / 2);
    const startX = current.x + (toPreviousX / previousLength) * corner;
    const startY = current.y + (toPreviousY / previousLength) * corner;
    const endX = current.x + (toNextX / nextLength) * corner;
    const endY = current.y + (toNextY / nextLength) * corner;

    parts.push(`${index === 0 ? 'M' : 'L'} ${round(startX)} ${round(startY)}`);
    parts.push(`Q ${round(current.x)} ${round(current.y)} ${round(endX)} ${round(endY)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

/** Путь треугольника (3 стороны) — просто удобный псевдоним. */
export function trianglePath(width: number, height: number, cornerRadius = 0): string {
  return polygonPath(width, height, 3, cornerRadius);
}
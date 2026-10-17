/**
 * ============================================================================
 *  Координаты и трансформации страниц.
 * ============================================================================
 *
 *  Две системы координат:
 *
 *  1. **Пространство редактора (display / Konva)** — origin в левом верхнем
 *     углу страницы, ось Y направлена вниз, единица измерения — PDF points.
 *     Именно в нём хранятся координаты объектов (`EditorObject.x/y/width/height`).
 *
 *  2. **Пространство PDF** — origin в левом нижнем углу MediaBox, ось Y вверх.
 *     Именно в нём рисует pdf-lib.
 *
 *  Формулы полностью соответствуют `pdf.js` (`PageViewport`), поэтому
 *  конвертация согласована с тем, что видит пользователь на экране, включая
 *  страницы с поворотом `/Rotate 90/180/270`.
 *
 *  Дополнительно: у каждого объекта есть **локальная система координат**
 *  (левый верхний угол объекта, y вниз, до поворота объекта). Локальные
 *  координаты нужны для штрихов, изображений и текста.
 */

import type { ObjectTransform } from '@/types';
import type { Point, Rect } from '@/utils/geometry';
import { clamp, round2, toRadians } from '@/utils/geometry';

/** Геометрия страницы, как она описана в PDF. */
export interface PageGeometry {
  /** Ширина MediaBox, pt. */
  width: number;
  /** Высота MediaBox, pt. */
  height: number;
  /** Поворот страницы (/Rotate), градусы. */
  rotation: number;
  /** X левого нижнего угла MediaBox (обычно 0), pt. */
  originX?: number;
  /** Y левого нижнего угла MediaBox (обычно 0), pt. */
  originY?: number;
}

/** Полная трансформация страницы. */
export interface PageTransform {
  /** Нормализованный поворот: 0 | 90 | 180 | 270. */
  rotation: 0 | 90 | 180 | 270;
  /** Ширина страницы в PDF, pt. */
  pdfWidth: number;
  /** Высота страницы в PDF, pt. */
  pdfHeight: number;
  /** Ширина так, как видит пользователь, pt. */
  displayWidth: number;
  /** Высота так, как видит пользователь, pt. */
  displayHeight: number;
  /** Масштаб отображения (для экспорта в растр). */
  scale: number;
  /** X левого нижнего угла MediaBox, pt. */
  originX: number;
  /** Y левого нижнего угла MediaBox, pt. */
  originY: number;
  /** Матрица PDF → display: [a, b, c, d, e, f]. */
  pdfToDisplay: Matrix;
  /** Матрица display → PDF: [a, b, c, d, e, f]. */
  displayToPdf: Matrix;
  /** Границы страницы в пространстве редактора. */
  bounds: Rect;
}

/** Аффинная матрица [a, b, c, d, e, f]. */
export type Matrix = [number, number, number, number, number, number];

/** Нормализация угла поворота к одному из значений 0/90/180/270. */
export function normalizePdfRotation(angle: number): 0 | 90 | 180 | 270 {
  const normalized = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  if (normalized === 90) return 90;
  if (normalized === 180) return 180;
  if (normalized === 270) return 270;
  return 0;
}

/** Размер страницы так, как её видит пользователь (с учётом поворота). */
export function getDisplaySize(
  width: number,
  height: number,
  rotation: number,
): { width: number; height: number } {
  const normalized = normalizePdfRotation(rotation);
  return normalized === 90 || normalized === 270
    ? { width: height, height: width }
    : { width, height };
}

/**
 * Итоговый поворот страницы с учётом поворота, добавленного пользователем.
 * Именно это значение видит пользователь и именно оно попадает в PDF.
 */
export function effectivePageRotation(page: { rotation: number; viewRotation?: number }): number {
  return normalizePdfRotation(page.rotation + (page.viewRotation ?? 0));
}

/** Дополнительный (пользовательский) поворот страницы. */
export function extraPageRotation(page: { viewRotation?: number }): number {
  return ((page.viewRotation ?? 0) % 360 + 360) % 360;
}

/** Приведение аргумента к PageTransform. */
export function asPageTransform(value: PageGeometry | PageTransform): PageTransform {
  return 'displayToPdf' in value ? value : getTransformForPage(value);
}

/**
 * Главная функция трансформации страницы: возвращает все матрицы и размеры,
 * необходимые для отрисовки и экспорта.
 */
export function getTransformForPage(page: PageGeometry, scale = 1): PageTransform {
  const rotation = normalizePdfRotation(page.rotation);
  const pdfWidth = page.width;
  const pdfHeight = page.height;
  const originX = page.originX ?? 0;
  const originY = page.originY ?? 0;
  const { width: displayWidth, height: displayHeight } = getDisplaySize(
    pdfWidth,
    pdfHeight,
    rotation,
  );

  // PDF → display (в точности как pdf.js PageViewport при viewBox = MediaBox).
  let pdfToDisplay: Matrix;
  switch (rotation) {
    case 90:
      pdfToDisplay = [0, scale, scale, 0, -scale * originY, -scale * originX];
      break;
    case 180:
      pdfToDisplay = [-scale, 0, 0, scale, scale * (originX + pdfWidth), -scale * originY];
      break;
    case 270:
      pdfToDisplay = [
        0,
        -scale,
        -scale,
        0,
        scale * (originY + pdfHeight),
        scale * (originX + pdfWidth),
      ];
      break;
    case 0:
    default:
      pdfToDisplay = [scale, 0, 0, -scale, -scale * originX, scale * (originY + pdfHeight)];
      break;
  }

  // display → PDF: обратная матрица (для page rotation она ортонормирована,
  // поэтому достаточно транспонировать линейную часть и пересчитать сдвиг).
  const displayToPdf = invertMatrix(pdfToDisplay, scale);

  return {
    rotation,
    pdfWidth,
    pdfHeight,
    displayWidth,
    displayHeight,
    scale,
    originX,
    originY,
    pdfToDisplay,
    displayToPdf,
    bounds: { x: 0, y: 0, width: displayWidth, height: displayHeight },
  };
}

/** Обращение аффинной матрицы. */
export function invertMatrix(m: Matrix, scale = 1): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0];
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

/** Применение матрицы к точке. */
export function applyMatrix(point: Point, m: Matrix): Point {
  return {
    x: m[0] * point.x + m[2] * point.y + m[4],
    y: m[1] * point.x + m[3] * point.y + m[5],
  };
}

/* ==========================================================================
 *  Базовые конвертеры координат
 * ========================================================================== */

/**
 * Координаты редактора (Konva, top-left, Y вниз) → координаты PDF
 * (bottom-left, Y вверх). Учитывает поворот страницы.
 */
export function konvaToPdfCoordinates(
  x: number,
  y: number,
  page: PageGeometry | PageTransform,
): Point {
  const t = asPageTransform(page);
  const { pdfWidth, pdfHeight, rotation } = t;
  const originX = t.originX;
  const originY = t.originY;
  switch (rotation) {
    case 90:
      return { x: y + originX, y: x + originY };
    case 180:
      return { x: originX + pdfWidth - x, y: y + originY };
    case 270:
      return { x: originX + pdfWidth - y, y: originY + pdfHeight - x };
    case 0:
    default:
      return { x: x + originX, y: originY + pdfHeight - y };
  }
}

/**
 * Координаты PDF (bottom-left, Y вверх) → координаты редактора
 * (top-left, Y вниз). Учитывает поворот страницы.
 */
export function pdfToKonvaCoordinates(
  x: number,
  y: number,
  page: PageGeometry | PageTransform,
): Point {
  const t = asPageTransform(page);
  const { pdfWidth, pdfHeight, rotation } = t;
  const originX = t.originX;
  const originY = t.originY;
  switch (rotation) {
    case 90:
      return { x: y - originY, y: x - originX };
    case 180:
      return { x: originX + pdfWidth - x, y: y - originY };
    case 270:
      return { x: originY + pdfHeight - y, y: originX + pdfWidth - x };
    case 0:
    default:
      return { x: x - originX, y: originY + pdfHeight - y };
  }
}

/** Прямоугольник редактора → прямоугольник PDF (через габариты). */
export function konvaRectToPdfRect(
  rect: Rect,
  page: PageGeometry | PageTransform,
): { x: number; y: number; width: number; height: number } {
  const t = asPageTransform(page);
  const a = konvaToPdfCoordinates(rect.x, rect.y, t);
  const b = konvaToPdfCoordinates(rect.x + rect.width, rect.y + rect.height, t);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Прямоугольник PDF → прямоугольник редактора. */
export function pdfRectToKonvaRect(
  rect: { x: number; y: number; width: number; height: number },
  page: PageGeometry | PageTransform,
): Rect {
  const t = asPageTransform(page);
  const a = pdfToKonvaCoordinates(rect.x, rect.y, t);
  const b = pdfToKonvaCoordinates(rect.x + rect.width, rect.y + rect.height, t);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/* ==========================================================================
 *  Локальные координаты объекта
 * ========================================================================== */

/**
 * Локальная точка объекта (Y вниз, до поворота) → координаты редактора.
 * Поворот выполняется вокруг точки (obj.x, obj.y) по часовой стрелке —
 * так же, как это делает Konva.
 */
export function localToDisplay(local: Point, obj: ObjectTransform): Point {
  const rad = toRadians(obj.rotation);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: obj.x + local.x * cos - local.y * sin,
    y: obj.y + local.x * sin + local.y * cos,
  };
}

/** Координаты редактора → локальная точка объекта (обратное преобразование). */
export function displayToLocal(display: Point, obj: ObjectTransform): Point {
  const rad = toRadians(-obj.rotation);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = display.x - obj.x;
  const dy = display.y - obj.y;
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/** Локальная точка объекта → координаты PDF. */
export function localToPdfCoordinates(
  local: Point,
  obj: ObjectTransform,
  page: PageGeometry | PageTransform,
): Point {
  return konvaToPdfCoordinates(localToDisplay(local, obj).x, localToDisplay(local, obj).y, page);
}

/**
 * Якорь объекта в координатах PDF + угол поворота для pdf-lib.
 *
 * Возвращает точку (x, y) — это соответствует левому верхнему углу объекта
 * в пространстве редактора, переведённому в PDF. Для рисования в pdf-lib
 * используется матрица страницы, поэтому «экранный» поворот по часовой
 * стрелке равен положительному углу в матрице PDF (см. pdfExportService).
 */
export function getPdfAnchor(
  obj: ObjectTransform,
  page: PageGeometry | PageTransform,
): { x: number; y: number; rotation: number } {
  const anchor = konvaToPdfCoordinates(obj.x, obj.y, page);
  return { x: anchor.x, y: anchor.y, rotation: getPdfObjectRotation(page, obj.rotation) };
}

/**
 * Угол поворота объекта в системе PDF (градусы, против часовой стрелки) —
 * то значение, которое нужно передавать в `rotate` у pdf-lib.
 *
 * Экранный поворот по часовой стрелке `displayRotation` на странице с
 * поворотом `/Rotate = pageRotation` соответствует углу
 * `pageRotation - displayRotation` в системе PDF.
 */
export function getPdfObjectRotation(
  page: PageGeometry | PageTransform,
  displayRotation: number,
): number {
  const t = asPageTransform(page);
  return (((t.rotation - displayRotation) % 360) + 360) % 360;
}

/**
 * Точка локальной системы объекта (Y вниз, до поворота) в системе PDF
 * с учётом поворота страницы и поворота объекта. Это именно та точка,
 * которую нужно передать в pdf-lib вместе с `rotate = getPdfObjectRotation`.
 */
export function localPointToPdf(
  localX: number,
  localY: number,
  obj: ObjectTransform,
  page: PageGeometry | PageTransform,
): Point {
  const display = localToDisplay({ x: localX, y: localY }, obj);
  return konvaToPdfCoordinates(display.x, display.y, page);
}

/* ==========================================================================
 *  Нормализация и масштабирование объектов
 * ========================================================================== */

export interface NormalizeOptions {
  /** Не давать объекту уйти за пределы страницы. */
  clampToPage?: boolean;
  /** Минимальный размер объекта, pt. */
  minSize?: number;
  /** Округлять координаты до сотых. */
  round?: boolean;
}

/**
 * Приводит объект к корректному виду: положительные размеры, аккуратные
 * координаты, при необходимости — удержание в границах страницы.
 * Не изменяет исходный объект (возвращает новый).
 */
export function normalizeObjectToPage<T extends ObjectTransform>(
  obj: T,
  page: PageGeometry | PageTransform,
  options: NormalizeOptions = {},
): T {
  const { clampToPage = false, minSize = 2, round = true } = options;
  const t = asPageTransform(page);
  const width = Math.max(minSize, Math.abs(obj.width));
  const height = Math.max(minSize, Math.abs(obj.height));
  let x = Math.min(obj.x, obj.x + obj.width);
  let y = Math.min(obj.y, obj.y + obj.height);

  if (clampToPage) {
    const minVisible = Math.min(16, width / 2, height / 2);
    x = clamp(x, -width + minVisible, t.displayWidth - minVisible);
    y = clamp(y, -height + minVisible, t.displayHeight - minVisible);
  }

  return {
    ...obj,
    x: round ? round2(x) : x,
    y: round ? round2(y) : y,
    width: round ? round2(width) : width,
    height: round ? round2(height) : height,
    rotation: round ? round2(((obj.rotation % 360) + 360) % 360) : obj.rotation,
    opacity: clamp(obj.opacity, 0, 1),
  };
}

/** Поля объекта, которые масштабируются вместе с геометрией. */
const SCALABLE_PAYLOAD_KEYS = [
  'fontSize',
  'strokeWidth',
  'letterSpacing',
  'padding',
  'borderWidth',
  'borderGap',
  'cornerRadius',
] as const;

/**
 * Масштабирование объекта (например, для экспорта в растр с другим DPI).
 * Масштабируются геометрия и «физические» размеры внутри payload.
 */
export function scaleObjectForExport<T extends ObjectTransform>(
  obj: T,
  factor: number,
  origin: Point = { x: 0, y: 0 },
): T {
  if (factor === 1) return obj;
  const payload = { ...(obj as unknown as { payload?: Record<string, unknown> }).payload };
  if (payload) {
    for (const key of SCALABLE_PAYLOAD_KEYS) {
      const value = payload[key];
      if (typeof value === 'number') payload[key] = round2(value * factor);
    }
  }
  return {
    ...obj,
    x: round2(origin.x + (obj.x - origin.x) * factor),
    y: round2(origin.y + (obj.y - origin.y) * factor),
    width: round2(obj.width * factor),
    height: round2(obj.height * factor),
    payload,
  } as T;
}

/** Пересчёт точки из одного масштаба страницы в другой. */
export function scalePoint(point: Point, factor: number): Point {
  return { x: point.x * factor, y: point.y * factor };
}

/** Центр объекта в координатах редактора (с учётом поворота). */
export function objectCenter(obj: ObjectTransform): Point {
  return localToDisplay({ x: obj.width / 2, y: obj.height / 2 }, obj);
}

/**
 * Позиция объекта при переносе его на другую страницу с другим размером:
 * сохраняет относительное расположение (в процентах от размеров страницы).
 */
export function remapObjectToPage<T extends ObjectTransform>(
  obj: T,
  from: PageGeometry | PageTransform,
  to: PageGeometry | PageTransform,
): T {
  const a = asPageTransform(from);
  const b = asPageTransform(to);
  const sx = b.displayWidth / (a.displayWidth || 1);
  const sy = b.displayHeight / (a.displayHeight || 1);
  const factor = Math.min(sx, sy);
  return {
    ...obj,
    x: round2(obj.x * sx),
    y: round2(obj.y * sy),
    width: round2(obj.width * factor),
    height: round2(obj.height * factor),
  };
}

/**
 * Масштаб для перевода DPI в множитель PDF points.
 * 72 pt = 1 дюйм, поэтому scale = dpi / 72.
 */
export function dpiToScale(dpi: number): number {
  return dpi / 72;
}

/* ==========================================================================
 *  Поворот страницы
 * ========================================================================== */

/** Округление угла к значениям 0/90/180/270. */
export function quarterTurns(angle: number): number {
  return (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
}

/** Объект, который можно перенести при повороте страницы. */
export interface RotatableObject extends ObjectTransform {
  id: string;
}

/** Патч объекта после поворота страницы. */
export interface RotationPatch {
  id: string;
  patch: { x: number; y: number; rotation: number };
}

/**
 * Пересчёт объектов в систему координат нового поворота страницы.
 *
 * Физическое положение объекта на странице не меняется: точка привязки
 * переводится в систему PDF и обратно в новую систему отображения, а к
 * собственному повороту добавляется разница поворотов страницы.
 *
 * Используется при повороте страницы в редакторе, поэтому вынесено в чистые
 * утилиты (без зависимостей от сторов) и покрыто тестами.
 */
export function remapObjectsForPageRotation<T extends RotatableObject>(
  items: readonly T[],
  from: PageGeometry | PageTransform,
  to: PageGeometry | PageTransform,
): RotationPatch[] {
  const a = asPageTransform(from);
  const b = asPageTransform(to);
  const delta = b.rotation - a.rotation;
  return items.map((obj) => {
    const anchor = konvaToPdfCoordinates(obj.x, obj.y, a);
    const position = pdfToKonvaCoordinates(anchor.x, anchor.y, b);
    return {
      id: obj.id,
      patch: {
        x: round2(position.x),
        y: round2(position.y),
        rotation: round2(((obj.rotation + delta) % 360 + 360) % 360),
      },
    };
  });
}

/** Множитель PDF points → пиксели при заданном DPI. */
export function ptToPx(pt: number, dpi: number): number {
  return (pt / 72) * dpi;
}

/** Пиксели → PDF points при заданном DPI. */
export function pxToPt(px: number, dpi: number): number {
  return (px / dpi) * 72;
}

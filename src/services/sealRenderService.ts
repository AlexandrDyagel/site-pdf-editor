/**
 * ============================================================================
 *  Круглая печать: геометрия, кольца, текст по дуге и «мокрая» фактура.
 * ============================================================================
 *
 *  Модуль считает всю геометрию оттиска один раз, а рисуют её три разных
 *  бэкенда:
 *    - canvas 2D — холст редактора и растровый экспорт (PNG/JPEG/Word);
 *    - SVG — векторный экспорт и предпросмотр в конструкторе;
 *    - pdf-lib — векторная вставка в PDF (см. `sealPdfRenderer`).
 *
 *  Благодаря общему расчёту оттиск выглядит одинаково везде: на экране,
 *  в PNG и в готовом PDF (никаких «съехавших» букв и колец).
 *
 *  ЕДИНИЦЫ ИЗМЕРЕНИЯ
 *  В проекте 1 px канвы = 1 pt = 1/72 дюйма (так же устроен PDF и Konva).
 *  Поэтому все размеры — толщины, шрифты, зазоры — задаются в px и без
 *  пересчёта попадают в PDF. Миллиметры нужны только пользователю:
 *  диаметр 30–60 мм переводится в px константой `SEAL_PX_PER_MM`.
 *
 *  СИСТЕМА КООРДИНАТ
 *  Локальная: (0,0) — левый верхний угол оттиска, Y направлен вниз.
 *  Углы: 0° — вправо, 90° — вниз, 270° — вверх (экранная СК).
 */

import type {
  SealArcText,
  SealInk,
  SealRing,
  SealRingLine,
  SealSettings,
  StampLogo,
  StampTemplate,
} from '@/types';
import type { StampCharLayout, StampLineLayout } from '@/services/stampRenderService';
import { measureTextWidth } from '@/utils/textLayout';
import { createId } from '@/utils/id';

/* ==========================================================================
 *  Константы и единицы
 * ========================================================================== */

/** Пикселей в миллиметре: 1 px = 1/72 дюйма. */
export const SEAL_PX_PER_MM = 72 / 25.4;

/** Пределы диаметра, мм (по заданию). */
export const SEAL_MIN_MM = 30;
export const SEAL_MAX_MM = 60;

/** Диаметр новой печати, мм. */
export const SEAL_DEFAULT_MM = 38;

/** Максимум колец: наружное + два внутренних. */
export const SEAL_MAX_RINGS = 4;

/** Шрифт для отрисовки текста печати. */
export interface SealFontResolver {
  (fontId: string | undefined): string;
}

/* ==========================================================================
 *  Фабрики значений
 * ========================================================================== */

/** Кольцо печати. */
export function createSealRing(width = 2.4, gap = 4): SealRing {
  return { width, gap };
}

/** Строка текста по кольцу. */
export function createSealRingLine(patch: Partial<SealRingLine> = {}): SealRingLine {
  return {
    id: patch.id ?? createId('ringline'),
    text: '',
    slot: 0,
    side: 'top',
    fontSize: 7,
    letterSpacing: 1,
    wordSpacing: 2,
    // 1 — «по ширине текста»; больше — растягивает, меньше — сжимает.
    spanAngle: 1,
    radiusOffset: 0,
    angleOffset: 0,
    bold: false,
    italic: false,
    ...patch,
  };
}

/**
 * Устаревшая фабрика дугового текста.
 * Нужна только для чтения шаблонов, сохранённых до перехода на строки.
 */
export function createSealArcText(patch: Partial<SealArcText> = {}): SealArcText {
  return {
    enabled: true,
    text: '',
    fontSize: 9,
    letterSpacing: 1.2,
    wordSpacing: 2,
    spanAngle: 1,
    centerAngle: 270,
    radius: 0,
    gap: 3,
    betweenRings: false,
    bold: false,
    italic: false,
    ...patch,
  };
}

/**
 * Фактура «мокрой» печати.
 * По умолчанию выключена: чистая векторная печать — это предсказуемый
 * результат, а «живость» включают осознанно.
 */
export function createSealInk(patch: Partial<SealInk> = {}): SealInk {
  return {
    enabled: false,
    roughness: 0.3,
    grain: 0.3,
    doubleStrike: 0.28,
    strikeOffset: 0.45,
    seed: 1337,
    ...patch,
  };
}

/** Настройки печати по умолчанию. */
export function createSealSettings(patch: Partial<SealSettings> = {}): SealSettings {
  return {
    diameterMm: SEAL_DEFAULT_MM,
    version: 2,
    rings: [createSealRing(2.5, 0), createSealRing(1.4, 4.5)],
    lines: [
      createSealRingLine({
        text: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ',
        // Кегль подобран так, чтобы длинное название занимало верхнюю дугу
        // (≈225°), но не замыкалось в кольцо.
        fontSize: 5.5,
        slot: 0,
        side: 'top',
      }),
      createSealRingLine({
        text: 'г. МОСКВА',
        // 5.5 pt — чтобы строка целиком помещалась в зазор 4.5 pt и не
        // задевала кольца (кегль больше зазора вылезает за кольца).
        fontSize: 5.5,
        slot: 0,
        side: 'bottom',
      }),
    ],
    divider: { enabled: false, radius: 0, width: 1.2 },
    ink: createSealInk(),
    ...patch,
  };
}

/* ==========================================================================
 *  Миллиметры ↔ пиксели
 * ========================================================================== */

/** Диаметр в мм → диаметр в px. */
export function sealDiameterPx(diameterMm: number): number {
  const clamped = Math.min(SEAL_MAX_MM, Math.max(SEAL_MIN_MM, diameterMm));
  return Math.round(clamped * SEAL_PX_PER_MM * 100) / 100;
}

/** Диаметр в px → диаметр в мм (для панели свойств). */
export function sealDiameterMm(diameterPx: number): number {
  return Math.round((Math.max(1, diameterPx) / SEAL_PX_PER_MM) * 10) / 10;
}

/* ==========================================================================
 *  Совместимость со старыми шаблонами
 * ========================================================================== */

/** Строка из устаревшей дуги (arcTop/arcBottom). */
function lineFromLegacyArc(arc: SealArcText, side: 'top' | 'bottom'): SealRingLine {
  return createSealRingLine({
    text: arc.text,
    side,
    slot: 0,
    fontSize: arc.fontSize,
    letterSpacing: arc.letterSpacing,
    wordSpacing: arc.wordSpacing,
    spanAngle: arc.spanAngle,
    bold: arc.bold,
    italic: arc.italic,
    fontId: arc.fontId,
  });
}

/** Старые дуги → строки новой модели. */
function linesFromLegacyArcs(
  seal: Pick<SealSettings, 'arcTop' | 'arcBottom'>,
): SealRingLine[] {
  const lines: SealRingLine[] = [];
  if (seal.arcTop?.enabled && seal.arcTop.text.trim()) {
    lines.push(lineFromLegacyArc(seal.arcTop, 'top'));
  }
  if (seal.arcBottom?.enabled && seal.arcBottom.text.trim()) {
    lines.push(lineFromLegacyArc(seal.arcBottom, 'bottom'));
  }
  return lines;
}

/**
 * Настройки печати для шаблона, созданного до появления конструктора.
 *
 * Старые печати хранят только `doubleBorder` + `circularText`. Превращаем
 * это в кольца и строки, чтобы конструктор открывал их без потери вида.
 */
export function sealSettingsFromTemplate(template: StampTemplate): SealSettings {
  if (template.seal) return normalizeSealSettings(template.seal);

  const size = Math.max(8, Math.min(template.width, template.height));
  const rings: SealRing[] = [createSealRing(Math.max(1.2, template.borderWidth), 0)];
  if (template.doubleBorder) {
    rings.push(createSealRing(Math.max(1, template.borderWidth * 0.7), Math.max(2, template.borderGap)));
  }

  const circular = template.circularText;
  const legacyArcs = {
    arcTop: createSealArcText({
      enabled: Boolean(circular?.enabled && circular.text.trim()),
      text: circular?.text ?? '',
      fontSize: circular?.fontSize ?? 9,
      letterSpacing: circular?.letterSpacing ?? 1,
    }),
    arcBottom: createSealArcText({
      enabled: Boolean(circular?.enabled && circular.splitBottom && circular.bottomText.trim()),
      text: circular?.bottomText ?? '',
      fontSize: circular?.fontSize ?? 9,
      letterSpacing: circular?.letterSpacing ?? 1,
    }),
  };

  return normalizeSealSettings({
    diameterMm: sealDiameterMm(size),
    rings,
    lines: linesFromLegacyArcs(legacyArcs),
    divider: { enabled: false, radius: 0, width: 1 },
    ink: createSealInk(),
  });
}

/** Нормализация одной строки. */
function normalizeRingLine(line: SealRingLine, ringCount: number): SealRingLine {
  const base = createSealRingLine();
  const angle = Number.isFinite(line.angleOffset) ? line.angleOffset : 0;
  return {
    ...base,
    ...line,
    id: line.id || base.id,
    text: line.text ?? '',
    slot: Math.round(clamp(line.slot ?? 0, 0, Math.max(0, ringCount - 1))),
    side: line.side === 'bottom' ? 'bottom' : 'top',
    fontSize: clamp(line.fontSize ?? 7, 3, 40),
    letterSpacing: clamp(line.letterSpacing ?? 1, -4, 40),
    wordSpacing: clamp(line.wordSpacing ?? 2, -10, 60),
    spanAngle: clamp(line.spanAngle ?? 1, 1, 400),
    radiusOffset: clamp(line.radiusOffset ?? 0, -200, 200),
    // Угол приводим к (-180; 180], чтобы поворот всегда читался одинаково.
    angleOffset: (((angle + 180) % 360) + 360) % 360 - 180,
    bold: Boolean(line.bold),
    italic: Boolean(line.italic),
  };
}

/**
 * Приведение настроек к допустимым значениям.
 * Конструктор может прислать что угодно (импорт библиотеки, старый JSON),
 * поэтому все числа проверяются здесь, а не в рендерерах.
 */
export function normalizeSealSettings(seal: SealSettings): SealSettings {
  const rings = (seal.rings?.length ? seal.rings : [createSealRing()])
    .slice(0, SEAL_MAX_RINGS)
    .map((ring, index) => ({
      width: clamp(ring.width, 0.2, 12),
      gap: index === 0 ? 0 : clamp(ring.gap, 0.5, 100),
    }));

  // Новые строки; если их нет — поднимаем старые дуги.
  const sourceLines =
    Array.isArray(seal.lines) && seal.lines.length > 0
      ? seal.lines
      : seal.arcTop || seal.arcBottom
        ? linesFromLegacyArcs(seal)
        : [];
  const lines = sourceLines
    .slice(0, 24)
    .map((line) => normalizeRingLine(line, rings.length));

  /**
   * Миграция старых шаблонов (без `version`).
   *
   * Раньше строки в одном зазоре и на одной половине складывались в стопку и
   * центрировались блоком. Теперь каждая строка независима: чтобы старые
   * печати не «схлопнулись» в одну линию, раздвигаем такие строки смещениями.
   */
  const modelVersion = seal.version ?? 1;
  if (modelVersion < 2) {
    const groups = new Map<string, SealRingLine[]>();
    for (const line of lines) {
      const key = `${line.slot}:${line.side}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(line);
      else groups.set(key, [line]);
    }
    for (const bucket of groups.values()) {
      if (bucket.length < 2) continue;
      // Если пользователь уже расставил строки вручную — не трогаем.
      if (bucket.some((line) => Math.abs(line.radiusOffset) > 0.01)) continue;
      let cursor = 0;
      for (const line of bucket) {
        if (cursor > 0) {
          line.radiusOffset = Math.round((line.radiusOffset - cursor) * 10) / 10;
        }
        cursor += line.fontSize * 1.3 + 1.5;
      }
    }
  }

  return {
    diameterMm: clamp(seal.diameterMm, SEAL_MIN_MM, SEAL_MAX_MM),
    rings,
    lines,
    version: 2,
    divider: {
      enabled: Boolean(seal.divider?.enabled),
      radius: clamp(seal.divider?.radius ?? 0, 0, 2000),
      width: clamp(seal.divider?.width ?? 1, 0.2, 8),
    },
    ink: {
      ...createSealInk(),
      ...seal.ink,
      enabled: Boolean(seal.ink?.enabled),
      roughness: clamp(seal.ink?.roughness ?? 0, 0, 1),
      grain: clamp(seal.ink?.grain ?? 0, 0, 1),
      doubleStrike: clamp(seal.ink?.doubleStrike ?? 0, 0, 1),
      strikeOffset: clamp(seal.ink?.strikeOffset ?? 0, 0, 4),
      seed: Math.trunc(seal.ink?.seed ?? 1337) || 1337,
    },
  };
}

/* ==========================================================================
 *  Вспомогательная математика
 * ========================================================================== */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Детерминированный генератор псевдослучайных чисел (mulberry32).
 * Один и тот же `seed` всегда даёт одинаковую «неидеальность»: оттиск не
 * мерцает при перерисовке и совпадает на холсте и в PDF.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Точка на окружности. */
function polar(cx: number, cy: number, radius: number, angleRad: number): { x: number; y: number } {
  return { x: cx + Math.cos(angleRad) * radius, y: cy + Math.sin(angleRad) * radius };
}

/* ==========================================================================
 *  Кольца
 * ========================================================================== */

/**
 * Радиусы колец от наружного к внутренним.
 *
 * Наружное кольцо прижато к краю оттиска: его осевая линия отстоит от края
 * на половину толщины. Каждое следующее отступает от внутреннего края
 * предыдущего на свой `gap` — ровно так, как это читается в конструкторе.
 */
export function sealRingRadii(rings: SealRing[], size: number): number[] {
  const radii: number[] = [];
  let innerEdge = size / 2;
  for (const [index, ring] of rings.entries()) {
    const width = Math.max(0.2, ring.width);
    const gap = index === 0 ? 0 : Math.max(0, ring.gap);
    // Кольцо можно утянуть почти к центру: радиус упирается в минимально
    // возможный, а не пропадает — печать не должна ломаться.
    const minRadius = Math.max(2, width / 2 + 0.5);
    const radius = Math.max(minRadius, innerEdge - gap - width / 2);
    radii.push(radius);
    innerEdge = radius - width / 2;
  }
  return radii;
}

/* ==========================================================================
 *  Текст по дуге — ключевая математика
 * ========================================================================== */

/** Параметры раскладки одного дугового текста. */
export interface SealArcLayoutInput {
  text: string;
  /** Радиус базовой линии, px. */
  radius: number;
  fontSize: number;
  letterSpacing: number;
  wordSpacing: number;
  /** Желаемый угол дуги, градусы (0 — по ширине текста). */
  spanAngle: number;
  /** Центр дуги, градусы. */
  centerAngle: number;
  side: 'top' | 'bottom';
  cx: number;
  cy: number;
  family: string;
  /** Шрифт (FontAsset.id) — нужен для встраивания в PDF. */
  fontId?: string;
  color: string;
  bold: boolean;
  italic: boolean;
}

/** Результат раскладки дугового текста. */
export interface SealArcLayout {
  chars: StampCharLayout[];
  /** Границы дуги (для маркеров растяжения), градусы. */
  startAngle: number;
  endAngle: number;
  /** Фактически занятый угол, градусы. */
  spanAngle: number;
}

/**
 * Минимальный угол, до которого строку можно сжать без «каши» из букв.
 *
 * Маркер сужения не должен обещать больше, чем может дать раскладка: ниже
 * этого угла буквы уже наезжают друг на друга. Конструктор ограничивает
 * маркер этим значением, поэтому ползунок и картинка не расходятся.
 */
export function sealArcMinSpan(input: {
  text: string;
  radius: number;
  fontSize: number;
  letterSpacing: number;
  wordSpacing: number;
  family: string;
  bold: boolean;
  italic: boolean;
}): number {
  const chars = Array.from(input.text);
  if (chars.length === 0 || input.text.trim().length === 0) return 0;
  const style = {
    fontFamily: input.family,
    fontSize: input.fontSize,
    bold: input.bold,
    italic: input.italic,
    letterSpacing: 0,
    lineHeight: 1.2,
  };
  const widths = chars.map((char) => measureTextWidth(char, style));
  const advances = widths.map((width, index) => {
    const extraWord = chars[index] === ' ' ? input.wordSpacing : 0;
    return width + input.letterSpacing + extraWord;
  });
  const natural = advances.reduce((sum, value) => sum + value, 0);
  const minAdvance = Math.min(...advances);
  const minLength = natural - minAdvance * 0.75 * chars.length;
  const radius = Math.max(4, input.radius);
  return (Math.max(0, minLength) / radius) * (180 / Math.PI);
}

/**
 * Раскладка текста по дуге.
 *
 * Алгоритм:
 *  1. меряем ширину каждого глифа;
 *  2. считаем «шаг» — ширина глифа + трекинг (+ межсловный интервал для
 *     пробела). Сумма шагов — длина строки вдоль дуги;
 *  3. переводим длину в угол: `угол = длина / радиус`;
 *  4. если задан `spanAngle` (пользователь потянул маркер), распределяем
 *     недостаток/излишек длины поровну между глифами — буквы расходятся,
 *     но сами глифы не деформируются;
 *  5. каждый глиф ставим серединой на дугу и поворачиваем по касательной:
 *     верх — `угол + 90°`, низ — `угол − 90°`.
 *
 * Именно пункт 5 даёт «правильные» буквы: на верхней дуге они стоят
 * макушкой к краю печати, на нижней — макушкой к центру (читаются слева
 * направо, не перевёрнуты).
 */
export function layoutSealArc(input: SealArcLayoutInput): SealArcLayout {
  const chars = Array.from(input.text);
  const empty: SealArcLayout = {
    chars: [],
    startAngle: input.centerAngle,
    endAngle: input.centerAngle,
    spanAngle: 0,
  };
  if (chars.length === 0 || input.text.trim().length === 0) return empty;

  const radius = Math.max(4, input.radius);
  const style = {
    fontFamily: input.family,
    fontSize: input.fontSize,
    bold: input.bold,
    italic: input.italic,
    letterSpacing: 0,
    lineHeight: 1.2,
  };

  // 1–2. Ширины и шаги вдоль дуги.
  const widths = chars.map((char) => measureTextWidth(char, style));
  const advances = widths.map((width, index) => {
    const extraWord = chars[index] === ' ' ? input.wordSpacing : 0;
    return width + input.letterSpacing + extraWord;
  });
  const natural = advances.reduce((sum, value) => sum + value, 0);

  // 3–4. Подгонка под заданный угол.
  // `spanAngle` — целевой угол: 1 («по ширине текста») — естественная
  // раскладка; больше — растягиваем; меньше — сжимаем шаг, насколько
  // позволяют буквы. Кегль не меняется ни при каком значении — поэтому
  // трекинг и интервалы двигают только дугу.
  const naturalAngle = natural / radius;
  const requestedAngle = (Math.max(1, input.spanAngle) * Math.PI) / 180;
  const MAX_TOTAL_ANGLE = (400 * Math.PI) / 180;
  const explicitSpan = input.spanAngle > 1.001;
  let targetAngle = explicitSpan ? requestedAngle : naturalAngle;
  // Совсем длинный текст с огромным трекингом не должен замыкаться сам в себя.
  targetAngle = Math.min(targetAngle, MAX_TOTAL_ANGLE);

  let extra = (targetAngle * radius - natural) / chars.length;
  // Сжимать бесконечно нельзя: буквы начнут наезжать друг на друга.
  // Разрешаем заметное сжатие (маркер «на сужение» должен работать), но
  // оставляем глифам место, чтобы текст оставался читаемым.
  const minAdvance = Math.min(...advances);
  extra = Math.max(extra, -minAdvance * 0.75);

  const totalLength = natural + extra * chars.length;
  const totalAngle = totalLength / radius;
  const totalAngleDeg = (totalAngle * 180) / Math.PI;

  // Направление обхода: верх — по часовой, низ — против. Так текст на обеих
  // дугах читается слева направо.
  const direction = input.side === 'top' ? 1 : -1;
  const startAngleRad =
    ((input.centerAngle * Math.PI) / 180) - (direction * totalAngle) / 2;

  const result: StampCharLayout[] = [];
  let cursor = 0;
  for (const [index, char] of chars.entries()) {
    const advance = advances[index] + extra;
    const width = widths[index];
    // Середина слота глифа на окружности.
    const middle = startAngleRad + (direction * (cursor + advance / 2)) / radius;
    const point = polar(input.cx, input.cy, radius, middle);
    // Круговая касательная в этой точке (направление чтения).
    const tangentX = direction > 0 ? -Math.sin(middle) : Math.sin(middle);
    const tangentY = direction > 0 ? Math.cos(middle) : -Math.cos(middle);
    const half = width / 2;
    const rotation = (middle * 180) / Math.PI + (input.side === 'top' ? 90 : -90);

    result.push({
      char,
      x: point.x - tangentX * half,
      y: point.y - tangentY * half,
      angle: rotation,
      fontSize: input.fontSize,
      color: input.color,
      family: input.family,
      fontId: input.fontId,
      bold: input.bold,
      italic: input.italic,
    });
    cursor += advance;
  }

  const startDeg = (startAngleRad * 180) / Math.PI;
  return {
    chars: result,
    startAngle: startDeg,
    endAngle: startDeg + direction * totalAngleDeg,
    spanAngle: totalAngleDeg,
  };
}

/* ==========================================================================
 *  Геометрия печати
 * ========================================================================== */

/** Кольцо, готовое к отрисовке. */
export interface SealRingGeometry {
  cx: number;
  cy: number;
  radius: number;
  width: number;
  /** Точки неровного контура (null — ровная окружность). */
  points: { x: number; y: number }[] | null;
  /** SVG-путь по точкам (null — ровная окружность). */
  path: string | null;
}

/** Точка краски (зернистость). */
export interface SealSpeck {
  x: number;
  y: number;
  radius: number;
  alpha: number;
}

/** Разделительная окружность. */
export interface SealDividerGeometry {
  cx: number;
  cy: number;
  radius: number;
  width: number;
}

/** Вся «краска» печати помимо текста: кольца, точки, разделитель. */
export interface SealInkGeometry {
  ink: SealInk;
  rings: SealRingGeometry[];
  /** Второй прокат — слабый повторный след. */
  ghostRings: SealRingGeometry[];
  specks: SealSpeck[];
  divider: SealDividerGeometry | null;
}

/** Строка печати, готовая к отрисовке. */
export interface SealRingLineGeometry {
  /** Идентификатор строки — по нему выбираются маркеры и правки. */
  lineId: string;
  /** Зазор между кольцами (0 — между 1-м и 2-м). */
  slot: number;
  side: 'top' | 'bottom';
  chars: StampCharLayout[];
  cx: number;
  cy: number;
  /** Радиус базовой линии, pt. */
  radius: number;
  /** Фактический кегль, pt. */
  fontSize: number;
  /** Границы дуги для маркеров растяжения, градусы. */
  startAngle: number;
  endAngle: number;
  /** Центр дуги, градусы (270 — верх, 90 — низ). */
  centerAngle: number;
  text: string;
}

/** Зазор между кольцами (или свободное место внутри последнего кольца). */
export interface SealSlotGeometry {
  index: number;
  /** Радиус середины зазора, pt. */
  center: number;
  /** Ширина зазора по радиусу, pt. */
  thickness: number;
  /** Меньший радиус зазора. */
  innerEdge: number;
  /** Больший радиус зазора. */
  outerEdge: number;
}

/** Полная геометрия печати в координатах шаблона. */
export interface SealLogoGeometry {
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  /** Поворот вокруг центра, градусы. */
  rotation: number;
}

export interface SealParts {
  width: number;
  height: number;
  ink: SealInkGeometry;
  /** Строки текста по кольцам. */
  ringLines: SealRingLineGeometry[];
  /** Зазоры между кольцами — нужны интерфейсу конструктора. */
  slots: SealSlotGeometry[];
  lines: StampLineLayout[];
  /** Все логотипы печати. */
  logos: SealLogoGeometry[];
  /** Первый логотип (совместимость со старым кодом). */
  logo: SealLogoGeometry | null;
}

/**
 * Кольцевые зазоры: 0 — между 1-м и 2-м кольцом, 1 — между 2-м и 3-м, …,
 * последний — свободное место внутри самого внутреннего кольца.
 */
export function sealSlotGeometry(
  rings: { radius: number; width: number }[],
  size: number,
): SealSlotGeometry[] {
  const slots: SealSlotGeometry[] = [];
  for (let index = 0; index < rings.length; index += 1) {
    const current = rings[index];
    const outerEdge = current.radius - current.width / 2;
    if (index < rings.length - 1) {
      const next = rings[index + 1];
      const innerEdge = next.radius + next.width / 2;
      slots.push({
        index,
        center: (outerEdge + innerEdge) / 2,
        thickness: Math.max(0, outerEdge - innerEdge),
        innerEdge,
        outerEdge,
      });
      continue;
    }
    // Под последним кольцом: полоса внутри него. Точной «второй границы»
    // нет (там центр), поэтому берём разумную полосу и даём двигать строку.
    const thickness = Math.max(8, Math.min(outerEdge * 0.45, size * 0.22));
    const innerEdge = Math.max(2, outerEdge - thickness);
    slots.push({
      index,
      center: (outerEdge + innerEdge) / 2,
      thickness: outerEdge - innerEdge,
      innerEdge,
      outerEdge,
    });
  }
  return slots;
}

/** Точки контура кольца с «дрожанием» радиуса. */
function buildRingPoints(
  cx: number,
  cy: number,
  radius: number,
  amplitude: number,
  random: () => number,
): { x: number; y: number }[] | null {
  if (amplitude <= 0.02) return null;
  const segments = Math.max(120, Math.min(360, Math.round(radius * 5)));
  // Край краски — это не «пила» по точкам, а медленные волны по окружности
  // плюс мелкая дрожь. Две низкочастотные гармоники дают именно такой край:
  // он выглядит живым, но не «мохнатым».
  const phaseA = random() * Math.PI * 2;
  const phaseB = random() * Math.PI * 2;
  const wavesA = 2 + Math.floor(random() * 2);
  const wavesB = 5 + Math.floor(random() * 3);
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    const smooth =
      Math.sin(angle * wavesA + phaseA) * 0.55 + Math.sin(angle * wavesB + phaseB) * 0.25;
    const noise = (random() - 0.5) * 0.18;
    points.push(polar(cx, cy, radius + (smooth + noise) * amplitude * 1.6, angle));
  }
  return points;
}

/** SVG-путь замкнутого контура по точкам. */
export function pointsToPath(points: { x: number; y: number }[]): string {
  const format = (value: number): string => (Math.round(value * 100) / 100).toString();
  let path = `M ${format(points[0].x)} ${format(points[0].y)}`;
  for (let index = 1; index < points.length; index += 1) {
    path += ` L ${format(points[index].x)} ${format(points[index].y)}`;
  }
  return `${path} Z`;
}

/** Кольцо с учётом фактуры. */
function buildRing(
  cx: number,
  cy: number,
  radius: number,
  width: number,
  amplitude: number,
  random: () => number,
): SealRingGeometry {
  const points = buildRingPoints(cx, cy, radius, amplitude, random);
  return {
    cx,
    cy,
    radius,
    width,
    points,
    path: points ? pointsToPath(points) : null,
  };
}

/**
 * Сдвиг готового кольца (для второго проката).
 * Точки пересчитываются, путь пересобирается — форма края сохраняется.
 */
function translateRing(
  ring: SealRingGeometry,
  dx: number,
  dy: number,
  widthFactor = 1,
): SealRingGeometry {
  const points = ring.points ? ring.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) : null;
  return {
    cx: ring.cx + dx,
    cy: ring.cy + dy,
    radius: ring.radius,
    width: ring.width * widthFactor,
    points,
    path: points ? pointsToPath(points) : null,
  };
}

/**
 * Неравномерность прижима отдельного глифа (0.8…1).
 *
 * У настоящего оттиска одни буквы пропечатаны ярче, другие бледнее. Считаем
 * детерминированно от `seed` и `grain`: рисунок недопечатка не мерцает и
 * совпадает на холсте, в SVG и в PDF.
 */
export function sealInkAlpha(index: number, ink: SealInk): number {
  if (!ink.enabled || ink.grain <= 0.01) return 1;
  const raw = Math.sin((index + 1) * 12.9898 + ink.seed * 0.017) * 43758.5453;
  const fraction = raw - Math.floor(raw);
  return 1 - ink.grain * (0.05 + 0.15 * fraction);
}

/**
 * Полный расчёт оттиска.
 *
 * `width`/`height` — размеры шаблона (они же размеры объекта на странице).
 * Все размеры внутри `seal` заданы для диаметра `diameterMm`, поэтому при
 * масштабировании объекта геометрия умножается на `k` — печать остаётся
 * пропорциональной.
 */
export function computeSealParts(
  template: StampTemplate,
  width: number,
  height: number,
  resolveFamily: SealFontResolver,
): SealParts {
  const seal = normalizeSealSettings(template.seal ?? sealSettingsFromTemplate(template));
  const size = Math.max(8, Math.min(width, height));
  const cx = width / 2;
  const cy = height / 2;
  const color = template.color;

  // Масштаб геометрии: у только что созданной печати k = 1.
  const baseDiameter = sealDiameterPx(seal.diameterMm);
  const k = size / Math.max(1, baseDiameter);

  const ringWidths = seal.rings.map((ring) => ({
    width: Math.max(0.2, ring.width * k),
    gap: Math.max(0, ring.gap * k),
  }));
  const radii = sealRingRadii(ringWidths, size);
  const innerEdge = radii.length
    ? radii[radii.length - 1] - ringWidths[radii.length - 1].width / 2
    : size / 2;

  const inkEnabled = seal.ink.enabled;
  const random = mulberry32(seal.ink.seed);

  // --- Кольца и второй прокат -------------------------------------------
  // Неровность до ~1 px на диаметре 40 мм: край «плывёт», но кольцо
  // остаётся кольцом.
  const amplitude = inkEnabled ? seal.ink.roughness * 1.0 * Math.max(0.6, k) : 0;
  const rings: SealRingGeometry[] = radii.map((radius, index) =>
    buildRing(cx, cy, radius, ringWidths[index].width, amplitude, random),
  );

  const ghostRings: SealRingGeometry[] = [];
  if (inkEnabled && seal.ink.doubleStrike > 0.02 && seal.ink.strikeOffset > 0.02) {
    // Направление «дрожания» фиксировано сидом — оттиск стабилен.
    const angle = random() * Math.PI * 2;
    const distance = seal.ink.strikeOffset * k * seal.ink.doubleStrike;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    for (const ring of rings) {
      // Второй прокат — это ТО ЖЕ кольцо, сдвинутое на доли пикселя.
      // Свою случайную неровность ему не даём: иначе вместо «двойного
      // прижима» получается второй контур с другим рисунком края.
      ghostRings.push(translateRing(ring, dx, dy, 0.8));
    }
  }

  // --- Текст по кольцам ---------------------------------------------------
  const slotGeometry = sealSlotGeometry(
    radii.map((radius, index) => ({ radius, width: ringWidths[index].width })),
    size,
  );

  /**
   * Каждая строка живёт сама по себе: её положение = центр её зазора плюс
   * собственное смещение. Раньше строки в одном зазоре складывались в стопку
   * и центрировались блоком — из-за этого добавление второй строки сдвигало
   * первую. Теперь общая раскладка на строку не влияет.
   */
  const ringLines: SealRingLineGeometry[] = [];
  for (const line of seal.lines) {
    if (!line.text.trim()) continue;
    const slotIndex = Math.min(slotGeometry.length - 1, Math.max(0, line.slot));
    const slot = slotGeometry[slotIndex];
    if (!slot) continue;

    const fontSize = Math.max(3, line.fontSize * k);
    // Базовая линия: у верхней половины буквы растут наружу от неё,
    // у нижней — внутрь к центру. Поэтому середина «чернил» смещена.
    const baselineCenter =
      line.side === 'top' ? slot.center - fontSize * 0.36 : slot.center + fontSize * 0.36;
    const radius = Math.max(size * 0.05, baselineCenter + line.radiusOffset * k);
    const centerAngle = (line.side === 'top' ? 270 : 90) + line.angleOffset;

    const layout = layoutSealArc({
      text: line.text,
      radius,
      fontSize,
      letterSpacing: line.letterSpacing * k,
      wordSpacing: line.wordSpacing * k,
      spanAngle: line.spanAngle,
      centerAngle,
      side: line.side,
      cx,
      cy,
      family: resolveFamily(line.fontId ?? template.fontId),
      fontId: line.fontId ?? template.fontId,
      color,
      bold: line.bold,
      italic: line.italic,
    });

    ringLines.push({
      lineId: line.id,
      slot: slotIndex,
      side: line.side,
      chars: layout.chars,
      cx,
      cy,
      radius,
      fontSize,
      startAngle: layout.startAngle,
      endAngle: layout.endAngle,
      centerAngle,
      text: line.text,
    });
  }

  // --- Центр: что остаётся внутри текста ----------------------------------
  // Свободный радиус центра считаем по фактическим строкам: у верхних
  // «чернила» начинаются от базовой линии наружу, у нижних — внутрь.
  let centerLimit = innerEdge - 2;
  for (const ringLine of ringLines) {
    const inner =
      ringLine.side === 'top'
        ? ringLine.radius
        : ringLine.radius - ringLine.fontSize * 0.9;
    centerLimit = Math.min(centerLimit, inner - 2);
  }
  centerLimit = Math.max(size * 0.1, centerLimit);

  const visibleLines = template.lines.filter((line) => line.text.trim().length > 0);
  const lineMetrics = visibleLines.map((line) => {
    const family = resolveFamily(line.fontId ?? template.fontId);
    const style = (fontSize: number) => ({
      fontFamily: family,
      fontSize,
      bold: line.bold,
      italic: line.italic,
      letterSpacing: line.letterSpacing,
      wordSpacing: line.wordSpacing ?? 0,
      lineHeight: 1.25,
    });
    const fontSize = Math.max(3, line.fontSize);
    const lineWidth = measureTextWidth(line.text, style(fontSize));
    return { line, family, fontSize, lineWidth, height: fontSize * 1.32 };
  });

  // Логотипы — независимые объекты: размер и положение задаёт пользователь,
  // они не участвуют в авто-раскладке строк центра.
  const logoSources: StampLogo[] =
    Array.isArray(template.logos) && template.logos.length
      ? template.logos
      : template.logo
        ? [template.logo]
        : [];
  const logos: SealLogoGeometry[] = logoSources
    .filter((item) => Boolean(item.src))
    .map((item) => {
      const width = Math.min(size * 0.9, Math.max(3, item.width * k));
      const height = Math.min(size * 0.9, Math.max(3, item.height * k));
      return {
        src: item.src,
        x: cx - width / 2 + (item.offsetX ?? 0) * k,
        y: cy - height / 2 + (item.offsetY ?? 0) * k,
        width,
        height,
        opacity: item.opacity,
        rotation: item.rotation ?? 0,
      };
    });
  const logo = logos[0] ?? null;

  const baseLinesHeight = lineMetrics.reduce((sum, item) => sum + item.height, 0);
  const availableHeight = Math.max(4, centerLimit * 1.7);
  const heightFactor =
    baseLinesHeight > availableHeight && baseLinesHeight > 0 ? availableHeight / baseLinesHeight : 1;
  if (heightFactor < 1) {
    for (const metric of lineMetrics) {
      metric.fontSize = Math.max(3, metric.fontSize * heightFactor);
      metric.lineWidth = measureTextWidth(metric.line.text, {
        fontFamily: metric.family,
        fontSize: metric.fontSize,
        bold: metric.line.bold,
        italic: metric.line.italic,
        letterSpacing: metric.line.letterSpacing,
        wordSpacing: metric.line.wordSpacing ?? 0,
        lineHeight: 1.25,
      });
      metric.height = metric.fontSize * 1.32;
    }
  }

  const linesHeight = lineMetrics.reduce((sum, item) => sum + item.height, 0);
  let cursorY = cy - linesHeight / 2;

  const lines: StampLineLayout[] = lineMetrics.map((metric) => {
    const { line, family, lineWidth } = metric;
    // Смещения строки — «свободное» положение: пользователь может утащить
    // строку центра в любое место, не двигая остальные.
    const baseline = cursorY + metric.fontSize * 0.98 + (line.offsetY ?? 0);
    const x =
      (line.align === 'left'
        ? cx - size / 2 + metric.fontSize
        : line.align === 'right'
          ? cx + size / 2 - metric.fontSize - lineWidth
          : cx - lineWidth / 2) + (line.offsetX ?? 0);
    cursorY += metric.height;
    return {
      text: line.text,
      x,
      baseline,
      fontSize: metric.fontSize,
      width: lineWidth,
      letterSpacing: line.letterSpacing,
      wordSpacing: line.wordSpacing ?? 0,
      color: line.color || color,
      fontId: line.fontId || template.fontId,
      family,
      bold: line.bold,
      italic: line.italic,
    };
  });

  // --- Разделительная окружность -----------------------------------------
  let divider: SealDividerGeometry | null = null;
  if (seal.divider.enabled) {
    const contentHalfHeight = linesHeight / 2;
    const contentHalfWidth = lineMetrics.reduce((max, item) => Math.max(max, item.lineWidth / 2), 0);
    // Текст занимает ~78 % диаметра разделителя: у настоящих печатей между
    // строками центра и окружностью всегда есть заметное поле.
    const autoRadius =
      Math.max(contentHalfHeight, contentHalfWidth) / 0.78 + Math.max(1.5, size * 0.012);
    // Нижняя граница — чтобы у маленьких печатей разделитель не схлопнулся.
    const minRadius = Math.max(size * 0.14, contentHalfHeight + 2);
    const radius =
      seal.divider.radius > 0 ? seal.divider.radius * k : Math.max(minRadius, autoRadius);
    divider = {
      cx,
      cy,
      // centerLimit уже учитывает текст по кольцам — разделитель его не пересечёт.
      radius: Math.max(4, Math.min(radius, centerLimit)),
      width: Math.max(0.2, seal.divider.width * k),
    };
  }

  // --- Зернистость --------------------------------------------------------
  const specks: SealSpeck[] = [];
  if (inkEnabled && seal.ink.grain > 0.01) {
    const count = Math.round(seal.ink.grain * 150);
    for (let index = 0; index < count; index += 1) {
      if (rings.length > 0) {
        // Большая часть точек — вокруг колец: именно там краска «плывёт».
        const ring = rings[Math.floor(random() * rings.length)];
        const angle = random() * Math.PI * 2;
        const radialOffset = (random() - 0.5) * ring.width * 2.4;
        const point = polar(ring.cx, ring.cy, ring.radius + radialOffset, angle);
        specks.push({
          x: point.x,
          y: point.y,
          radius: 0.25 + random() * 0.85 * Math.max(0.6, k),
          alpha: 0.12 + random() * 0.4,
        });
      } else {
        const angle = random() * Math.PI * 2;
        const radius = random() * shapeRadius(size);
        const point = polar(cx, cy, radius, angle);
        specks.push({
          x: point.x,
          y: point.y,
          radius: 0.25 + random() * 0.8,
          alpha: 0.1 + random() * 0.3,
        });
      }
    }
  }

  return {
    width,
    height,
    ink: { ink: seal.ink, rings, ghostRings, specks, divider },
    ringLines,
    slots: slotGeometry,
    lines,
    logos,
    logo,
  };
}

/** Радиус «поля» печати (для точек без колец). */
function shapeRadius(size: number): number {
  return size / 2 - 1;
}

/* ==========================================================================
 *  Отрисовка на canvas
 * ========================================================================== */

/** Обводка кольца: ровная окружность или неровный контур. */
function strokeRing(ctx: CanvasRenderingContext2D, ring: SealRingGeometry, color: string, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.3, width);
  ctx.beginPath();
  if (ring.points && ring.points.length > 2) {
    ctx.moveTo(ring.points[0].x, ring.points[0].y);
    for (let index = 1; index < ring.points.length; index += 1) {
      ctx.lineTo(ring.points[index].x, ring.points[index].y);
    }
    ctx.closePath();
  } else {
    ctx.arc(ring.cx, ring.cy, Math.max(0.5, ring.radius), 0, Math.PI * 2);
  }
  ctx.stroke();
}

/**
 * Отрисовка «краски» печати: кольца, второй прокат, точки, разделитель.
 * Текст и логотип рисуются отдельно — общим кодом штампов.
 */
export function paintSealInk(
  ctx: CanvasRenderingContext2D,
  geometry: SealInkGeometry,
  color: string,
): void {
  // Второй прокат рисуем первым и полупрозрачным: он должен «просвечивать».
  if (geometry.ghostRings.length > 0) {
    ctx.save();
    ctx.globalAlpha *= 0.28;
    for (const ring of geometry.ghostRings) {
      strokeRing(ctx, ring, color, ring.width);
    }
    ctx.restore();
  }

  for (const ring of geometry.rings) {
    strokeRing(ctx, ring, color, ring.width);
  }

  if (geometry.specks.length > 0) {
    ctx.save();
    ctx.fillStyle = color;
    // Глобальную прозрачность (объект + шаблон) не теряем: альфа точки
    // домножается на неё, а не заменяет её.
    const baseAlpha = ctx.globalAlpha;
    for (const speck of geometry.specks) {
      ctx.globalAlpha = baseAlpha * speck.alpha;
      ctx.beginPath();
      ctx.arc(speck.x, speck.y, Math.max(0.2, speck.radius), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  if (geometry.divider) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.2, geometry.divider.width);
    ctx.beginPath();
    ctx.arc(geometry.divider.cx, geometry.divider.cy, Math.max(0.5, geometry.divider.radius), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/* ==========================================================================
 *  Отрисовка в SVG
 * ========================================================================== */

/** Число для SVG без «хвостов»: 113.385826 → 113.39. */
function svgNumber(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/**
 * SVG-фрагменты «краски» печати.
 * Возвращает готовые элементы без внешнего `<svg>`: вызывающая сторона
 * сама решает, куда их вставить.
 */
export function sealInkToSvg(geometry: SealInkGeometry, color: string, opacity: number): string[] {
  const parts: string[] = [];
  const globalOpacity = opacity < 1 ? ` opacity="${svgNumber(opacity)}"` : '';

  const ringToSvg = (ring: SealRingGeometry, width: number, extraOpacity = ''): string => {
    if (ring.path) {
      return `<path d="${ring.path}" fill="none" stroke="${color}" stroke-width="${svgNumber(
        width,
      )}"${extraOpacity} />`;
    }
    return `<circle cx="${svgNumber(ring.cx)}" cy="${svgNumber(ring.cy)}" r="${svgNumber(
      ring.radius,
    )}" fill="none" stroke="${color}" stroke-width="${svgNumber(width)}"${extraOpacity} />`;
  };

  for (const ring of geometry.ghostRings) {
    parts.push(ringToSvg(ring, ring.width, ` opacity="${svgNumber(0.28)}"`));
  }
  for (const ring of geometry.rings) {
    parts.push(ringToSvg(ring, ring.width, globalOpacity));
  }
  for (const speck of geometry.specks) {
    parts.push(
      `<circle cx="${svgNumber(speck.x)}" cy="${svgNumber(speck.y)}" r="${svgNumber(
        speck.radius,
      )}" fill="${color}" opacity="${svgNumber(speck.alpha * opacity)}" />`,
    );
  }
  if (geometry.divider) {
    parts.push(
      `<circle cx="${svgNumber(geometry.divider.cx)}" cy="${svgNumber(geometry.divider.cy)}" r="${svgNumber(
        geometry.divider.radius,
      )}" fill="none" stroke="${color}" stroke-width="${svgNumber(geometry.divider.width)}"${globalOpacity} />`,
    );
  }
  return parts;
}

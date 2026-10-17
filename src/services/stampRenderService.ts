/**
 * ============================================================================
 *  Штампы и печати: расчёт раскладки и отрисовка.
 * ============================================================================
 *
 *  Модуль решает одну задачу: по шаблону (`StampTemplate`) построить
 *  геометрию (`StampLayout`) так, чтобы она одинаково выглядела
 *    - на канвасе редактора (canvas 2D, локальные координаты, Y вниз);
 *    - в растровом экспорте (PNG/JPEG высокого разрешения);
 *    - в PDF (векторно через pdf-lib, см. `stampPdfRenderer`).
 *
 *  Локальная система координат штампа: (0,0) — левый верхний угол,
 *  Y направлен вниз, единицы — PDF points.
 */

import type { StampCircularText, StampTemplate, StampTextLine } from '@/types';
import { createId } from '@/utils/id';
import { measureTextWidth } from '@/utils/textLayout';

/** Шрифт для отрисовки штампа. */
export interface StampFontResolver {
  /** CSS-семейство по идентификатору шрифта. */
  (fontId: string | undefined): string;
}

/** Строка штампа, размещённая в локальных координатах. */
export interface StampLineLayout {
  text: string;
  /** X начала строки, pt. */
  x: number;
  /** Y базовой линии, pt. */
  baseline: number;
  fontSize: number;
  width: number;
  letterSpacing: number;
  color: string;
  fontId: string;
  family: string;
  bold: boolean;
  italic: boolean;
}

/** Символ кругового текста. */
export interface StampCharLayout {
  char: string;
  /** Точка на окружности (начало базовой линии символа), pt. */
  x: number;
  y: number;
  /** Угол поворота символа (градусы, по часовой стрелке в экранной СК). */
  angle: number;
  fontSize: number;
  color: string;
  family: string;
  bold: boolean;
  italic: boolean;
}

/** Полная геометрия штампа. */
export interface StampLayout {
  width: number;
  height: number;
  shape: StampTemplate['shape'];
  color: string;
  borderWidth: number;
  doubleBorder: boolean;
  borderGap: number;
  cornerRadius: number;
  opacity: number;
  backgroundColor: string | null;
  divider: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Прямоугольные/овальные рамки. */
  frames: { shape: StampTemplate['shape']; x: number; y: number; width: number; height: number; radius: number }[];
  lines: StampLineLayout[];
  chars: StampCharLayout[];
  logo: {
    src: string;
    x: number;
    y: number;
    width: number;
    height: number;
    opacity: number;
  } | null;
}

/** Значения по умолчанию для круглого текста. */
export function createCircularText(): StampCircularText {
  return {
    enabled: false,
    text: 'ОРГАНИЗАЦИЯ',
    fontSize: 11,
    radius: 0,
    startAngle: 270,
    direction: 'cw',
    letterSpacing: 1.2,
    color: null,
    splitBottom: true,
    bottomText: 'ИНН 0000000000',
  };
}

/** Строка текста по умолчанию. */
export function createStampLine(text: string, patch: Partial<StampTextLine> = {}): StampTextLine {
  return {
    id: createId('line'),
    text,
    fontSize: 12,
    bold: false,
    italic: false,
    align: 'center',
    letterSpacing: 0,
    offsetY: 0,
    color: null,
    ...patch,
  };
}

/** Новый шаблон штампа (прямоугольный). */
export function createStampTemplate(patch: Partial<StampTemplate> = {}): StampTemplate {
  const now = new Date().toISOString();
  return {
    id: patch.id ?? createId('stamp'),
    name: patch.name ?? 'Новый штамп',
    kind: 'stamp',
    shape: 'rect',
    width: 170,
    height: 70,
    color: '#1d4ed8',
    borderWidth: 2,
    doubleBorder: false,
    borderGap: 4,
    cornerRadius: 4,
    opacity: 1,
    rotation: 0,
    fontId: patch.fontId ?? 'pt-sans',
    lines: [
      createStampLine('УТВЕРЖДАЮ', { fontSize: 14, bold: true, letterSpacing: 1 }),
      createStampLine('Генеральный директор', { fontSize: 10 }),
      createStampLine('Иванов И. И.', { fontSize: 10, italic: true }),
    ],
    circularText: createCircularText(),
    logo: null,
    backgroundColor: null,
    divider: false,
    createdAt: now,
    updatedAt: now,
    tags: [],
    preview: null,
    ...patch,
  };
}

/** Новый шаблон круглой печати. */
export function createSealTemplate(patch: Partial<StampTemplate> = {}): StampTemplate {
  const base = createStampTemplate({
    name: 'Новая печать',
    shape: 'round',
    width: 120,
    height: 120,
    color: '#b91c1c',
    borderWidth: 2,
    doubleBorder: true,
    borderGap: 5,
    lines: [
      createStampLine('ООО «Ромашка»', { fontSize: 11, bold: true }),
      createStampLine('ОГРН 1234567890123', { fontSize: 8 }),
    ],
    circularText: { ...createCircularText(), enabled: true },
    ...patch,
  });
  return { ...base, kind: 'seal' };
}

/** Радиус по умолчанию для кругового текста. */
export function defaultCircularRadius(template: StampTemplate): number {
  const minSide = Math.min(template.width, template.height);
  const fontSize = Math.max(6, template.circularText.fontSize);
  return Math.max(
    fontSize * 1.2,
    minSide / 2 - template.borderWidth - template.borderGap * 2 - fontSize * 0.75,
  );
}

/** Вспомогательная проверка: нужен ли внешний контур. */
function isRound(shape: StampTemplate['shape']): boolean {
  return shape === 'round' || shape === 'oval';
}

/** Замер ширины строки с учётом межбуквенного расстояния. */
function measureLine(text: string, family: string, fontSize: number, bold: boolean, italic: boolean, letterSpacing: number): number {
  return measureTextWidth(text, {
    fontFamily: family,
    fontSize,
    bold,
    italic,
    letterSpacing,
    lineHeight: 1.2,
  });
}

/**
 * Построение полной геометрии штампа.
 * `resolveFamily` переводит fontId в CSS-семейство (шрифт должен быть
 * загружен через FontFace API — тогда замеры совпадут с PDF).
 */
export function computeStampLayout(
  template: StampTemplate,
  resolveFamily: StampFontResolver,
  options: { textOverride?: string | null; colorOverride?: string | null; scale?: number } = {},
): StampLayout {
  const { textOverride = null, colorOverride = null, scale = 1 } = options;
  const width = Math.max(8, template.width);
  const height = Math.max(8, template.height);
  const color = colorOverride || template.color;
  const borderWidth = Math.max(0, template.borderWidth);
  const family = resolveFamily(template.fontId);

  const frames: StampLayout['frames'] = [];
  if (isRound(template.shape)) {
    frames.push({ shape: template.shape, x: 0, y: 0, width, height, radius: 0 });
    if (template.doubleBorder) {
      frames.push({
        shape: template.shape,
        x: 0,
        y: 0,
        width,
        height,
        radius: 0,
      });
    }
  } else {
    frames.push({
      shape: 'rect',
      x: 0,
      y: 0,
      width,
      height,
      radius: template.cornerRadius,
    });
    if (template.doubleBorder) {
      frames.push({ shape: 'rect', x: 0, y: 0, width, height, radius: template.cornerRadius });
    }
  }

  // Прямые текстовые строки.
  const lines: StampLineLayout[] = [];
  const visibleLines = template.lines.filter((line) => line.text.trim().length > 0);
  const lineHeights = visibleLines.map((line) => line.fontSize * 1.35);
  const totalLinesHeight = lineHeights.reduce((sum, value) => sum + value, 0);
  const blockTop = Math.max(borderWidth + 2, (height - totalLinesHeight) / 2);
  let cursorY = blockTop;

  visibleLines.forEach((line, index) => {
    const lineFamily = line.fontId ? resolveFamily(line.fontId) : family;
    const text = index === 0 && textOverride ? textOverride : line.text;
    const lineHeight = lineHeights[index];
    const lineWidth = measureLine(
      text,
      lineFamily,
      line.fontSize,
      line.bold,
      line.italic,
      line.letterSpacing,
    );
    const padding = borderWidth + template.borderGap + 2;
    let x = (width - lineWidth) / 2;
    if (line.align === 'left') x = padding;
    if (line.align === 'right') x = width - padding - lineWidth;
    lines.push({
      text,
      x,
      baseline: cursorY + line.fontSize * 1.05 + line.offsetY,
      fontSize: line.fontSize,
      width: lineWidth,
      letterSpacing: line.letterSpacing,
      color: line.color || color,
      fontId: line.fontId || template.fontId,
      family: lineFamily,
      bold: line.bold,
      italic: line.italic,
    });
    cursorY += lineHeight;
  });

  // Круговой текст.
  const chars: StampCharLayout[] = [];
  const circular = template.circularText;
  if (circular.enabled && isRound(template.shape)) {
    const radius = (circular.radius > 0 ? circular.radius : defaultCircularRadius(template)) * 1;
    const cx = width / 2;
    const cy = height / 2;
    const circularColor = circular.color || color;

    /**
     * Раскладка текста по дуге.
     * `startAngle` задаёт центр верхней дуги (по умолчанию 270° — «вверх»
     * в экранной системе координат, где Y направлен вниз).
     *
     * Координаты символа — это НАЧАЛО его базовой линии, а `angle` — угол
     * поворота по часовой стрелке. Такой формат одинаково понимают и canvas
     * (fillText после translate+rotate), и pdf-lib (drawText с rotate).
     */
    const layoutArc = (text: string, topArc: boolean): void => {
      if (!text.trim()) return;
      const chars_ = Array.from(text);
      const widths = chars_.map((char) =>
        measureLine(char, family, circular.fontSize, false, false, circular.letterSpacing),
      );
      const steps = widths.map((width) => (width + circular.letterSpacing) / Math.max(radius, 1));
      const total = steps.reduce((sum, value) => sum + value, 0);
      const centerAngle = topArc ? circular.startAngle : circular.startAngle + 180;
      let angle = topArc
        ? (centerAngle * Math.PI) / 180 - total / 2
        : (centerAngle * Math.PI) / 180 + total / 2;

      for (let i = 0; i < chars_.length; i += 1) {
        const step = steps[i];
        const mid = topArc ? angle + step / 2 : angle - step / 2;
        // Направление чтения (касательная к окружности).
        const tangentX = topArc ? -Math.sin(mid) : Math.sin(mid);
        const tangentY = topArc ? Math.cos(mid) : -Math.cos(mid);
        const half = widths[i] / 2;
        const x = cx + Math.cos(mid) * radius - tangentX * half;
        const y = cy + Math.sin(mid) * radius - tangentY * half;
        const rotation = topArc
          ? (mid * 180) / Math.PI + 90
          : (mid * 180) / Math.PI - 90;
        chars.push({
          char: chars_[i],
          x,
          y,
          angle: rotation,
          fontSize: circular.fontSize,
          color: circularColor,
          family,
          bold: false,
          italic: false,
        });
        angle = topArc ? angle + step : angle - step;
      }
    };

    layoutArc(circular.text, true);
    if (circular.splitBottom && circular.bottomText.trim()) {
      layoutArc(circular.bottomText, false);
    }
  }

  // Логотип.
  let logo: StampLayout['logo'] = null;
  if (template.logo && template.logo.src) {
    const logoWidth = Math.max(4, template.logo.width);
    const logoHeight = Math.max(4, template.logo.height);
    logo = {
      src: template.logo.src,
      x: (width - logoWidth) / 2 + template.logo.offsetX,
      y: (height - logoHeight) / 2 + template.logo.offsetY,
      width: logoWidth,
      height: logoHeight,
      opacity: template.logo.opacity,
    };
  }

  const divider = template.divider && !isRound(template.shape)
    ? {
        x1: borderWidth + template.borderGap + 2,
        y1: height / 2,
        x2: width - borderWidth - template.borderGap - 2,
        y2: height / 2,
      }
    : null;

  if (scale !== 1) {
    const scalePoint = (value: number): number => value * scale;
    return {
      ...{
        width: scalePoint(width),
        height: scalePoint(height),
      },
      shape: template.shape,
      color,
      borderWidth: scalePoint(borderWidth),
      doubleBorder: template.doubleBorder,
      borderGap: scalePoint(template.borderGap),
      cornerRadius: scalePoint(template.cornerRadius),
      opacity: template.opacity,
      backgroundColor: template.backgroundColor,
      divider: divider
        ? {
            x1: scalePoint(divider.x1),
            y1: scalePoint(divider.y1),
            x2: scalePoint(divider.x2),
            y2: scalePoint(divider.y2),
          }
        : null,
      frames: frames.map((frame) => ({
        ...frame,
        x: scalePoint(frame.x),
        y: scalePoint(frame.y),
        width: scalePoint(frame.width),
        height: scalePoint(frame.height),
        radius: scalePoint(frame.radius),
      })),
      lines: lines.map((line) => ({
        ...line,
        x: scalePoint(line.x),
        baseline: scalePoint(line.baseline),
        fontSize: scalePoint(line.fontSize),
        width: scalePoint(line.width),
        letterSpacing: scalePoint(line.letterSpacing),
      })),
      chars: chars.map((char) => ({
        ...char,
        x: scalePoint(char.x),
        y: scalePoint(char.y),
        fontSize: scalePoint(char.fontSize),
      })),
      logo: logo
        ? {
            ...logo,
            x: scalePoint(logo.x),
            y: scalePoint(logo.y),
            width: scalePoint(logo.width),
            height: scalePoint(logo.height),
          }
        : null,
    };
  }

  return {
    width,
    height,
    shape: template.shape,
    color,
    borderWidth,
    doubleBorder: template.doubleBorder,
    borderGap: template.borderGap,
    cornerRadius: template.cornerRadius,
    opacity: template.opacity,
    backgroundColor: template.backgroundColor,
    divider,
    frames,
    lines,
    chars,
    logo,
  };
}

/** Отрисовка рамки (прямоугольник/эллипс) на canvas. */
function paintFrame(
  ctx: CanvasRenderingContext2D,
  frame: StampLayout['frames'][number],
  color: string,
  lineWidth: number,
  innerOffset: number,
): void {
  if (lineWidth <= 0) return;
  const inset = innerOffset + lineWidth / 2;
  const x = frame.x + inset;
  const y = frame.y + inset;
  const width = frame.width - inset * 2;
  const height = frame.height - inset * 2;
  if (width <= 0 || height <= 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  if (frame.shape === 'rect') {
    const radius = Math.min(frame.radius, width / 2, height / 2);
    if (radius > 0.5 && typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, width, height, radius);
    } else {
      ctx.rect(x, y, width, height);
    }
  } else {
    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Отрисовка штампа на canvas 2D в локальных координатах штампа.
 * `logoImage` подгружается вызывающей стороной (см. renderStampToCanvas).
 */
export function paintStampLayout(
  ctx: CanvasRenderingContext2D,
  layout: StampLayout,
  options: { logoImage?: CanvasImageSource | null; alpha?: number } = {},
): void {
  const { logoImage = null, alpha = 1 } = options;
  ctx.save();
  // Умножаем прозрачность — сохраняем альфу, заданную Konva-узлом.
  ctx.globalAlpha *= Math.max(0, Math.min(1, layout.opacity * alpha));

  if (layout.backgroundColor) {
    ctx.save();
    ctx.fillStyle = layout.backgroundColor;
    ctx.beginPath();
    if (layout.shape === 'rect') {
      const radius = Math.min(layout.cornerRadius, layout.width / 2, layout.height / 2);
      if (radius > 0.5 && typeof ctx.roundRect === 'function') {
        ctx.roundRect(0, 0, layout.width, layout.height, radius);
      } else {
        ctx.rect(0, 0, layout.width, layout.height);
      }
    } else {
      ctx.ellipse(
        layout.width / 2,
        layout.height / 2,
        layout.width / 2,
        layout.height / 2,
        0,
        0,
        Math.PI * 2,
      );
    }
    ctx.fill();
    ctx.restore();
  }

  // Внешняя и внутренняя рамки.
  const offset = layout.doubleBorder ? layout.borderWidth + layout.borderGap : 0;
  if (layout.frames[1]) {
    paintFrame(ctx, layout.frames[1], layout.color, layout.borderWidth, offset);
  }
  if (layout.frames[0]) {
    paintFrame(ctx, layout.frames[0], layout.color, layout.borderWidth, 0);
  }

  // Разделитель.
  if (layout.divider) {
    ctx.save();
    ctx.strokeStyle = layout.color;
    ctx.lineWidth = Math.max(0.6, layout.borderWidth * 0.6);
    ctx.beginPath();
    ctx.moveTo(layout.divider.x1, layout.divider.y1);
    ctx.lineTo(layout.divider.x2, layout.divider.y2);
    ctx.stroke();
    ctx.restore();
  }

  // Прямые строки.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const line of layout.lines) {
    ctx.save();
    ctx.fillStyle = line.color;
    ctx.font = `${line.italic ? 'italic ' : ''}${line.bold ? '700' : '400'} ${line.fontSize}px "${line.family}"`;
    let cursor = line.x;
    if (line.letterSpacing) {
      for (const char of line.text) {
        ctx.fillText(char, cursor, line.baseline);
        cursor += ctx.measureText(char).width + line.letterSpacing;
      }
    } else {
      ctx.fillText(line.text, cursor, line.baseline);
    }
    ctx.restore();
  }

  // Круговой текст.
  for (const char of layout.chars) {
    ctx.save();
    ctx.translate(char.x, char.y);
    ctx.rotate((char.angle * Math.PI) / 180);
    ctx.fillStyle = char.color;
    ctx.font = `${char.italic ? 'italic ' : ''}${char.bold ? '700' : '400'} ${char.fontSize}px "${char.family}"`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(char.char, 0, 0);
    ctx.restore();
  }

  // Логотип.
  if (layout.logo && logoImage) {
    ctx.save();
    ctx.globalAlpha *= Math.max(0, Math.min(1, layout.logo.opacity));
    ctx.drawImage(logoImage, layout.logo.x, layout.logo.y, layout.logo.width, layout.logo.height);
    ctx.restore();
  }

  ctx.restore();
}

/** Отрисовка шаблона на canvas в локальных координатах (без масштабирования). */
export function paintStampTemplate(
  ctx: CanvasRenderingContext2D,
  template: StampTemplate,
  resolveFamily: StampFontResolver,
  options: {
    logoImage?: CanvasImageSource | null;
    textOverride?: string | null;
    colorOverride?: string | null;
    scale?: number;
    alpha?: number;
  } = {},
): StampLayout {
  const layout = computeStampLayout(template, resolveFamily, {
    textOverride: options.textOverride ?? null,
    colorOverride: options.colorOverride ?? null,
    scale: options.scale ?? 1,
  });
  paintStampLayout(ctx, layout, { logoImage: options.logoImage, alpha: options.alpha });
  return layout;
}

/** Итоговый размер штампа с учётом его собственного поворота. */
export function stampBoundingBox(template: StampTemplate): { width: number; height: number } {
  return { width: Math.max(8, template.width), height: Math.max(8, template.height) };
}

/** SVG-представление штампа (векторный экспорт). */
export function stampTemplateToSvg(
  template: StampTemplate,
  resolveFamily: StampFontResolver,
  options: { scale?: number; background?: string | null } = {},
): string {
  const { scale = 1, background = null } = options;
  const layout = computeStampLayout(template, resolveFamily);
  const width = layout.width * scale;
  const height = layout.height * scale;

  const parts: string[] = [];
  if (background) parts.push(`<rect width="100%" height="100%" fill="${background}" />`);

  const frameToSvg = (frame: StampLayout['frames'][number], innerOffset: number): string => {
    const inset = innerOffset + layout.borderWidth / 2;
    const w = frame.width - inset * 2;
    const h = frame.height - inset * 2;
    if (w <= 0 || h <= 0) return '';
    if (frame.shape === 'rect') {
      return `<rect x="${frame.x + inset}" y="${frame.y + inset}" width="${w}" height="${h}" rx="${
        frame.radius
      }" fill="none" stroke="${layout.color}" stroke-width="${layout.borderWidth}" />`;
    }
    return `<ellipse cx="${frame.x + frame.width / 2}" cy="${frame.y + frame.height / 2}" rx="${
      w / 2
    }" ry="${h / 2}" fill="none" stroke="${layout.color}" stroke-width="${layout.borderWidth}" />`;
  };

  const offset = layout.doubleBorder ? layout.borderWidth + layout.borderGap : 0;
  if (layout.frames[1]) parts.push(frameToSvg(layout.frames[1], offset));
  if (layout.frames[0]) parts.push(frameToSvg(layout.frames[0], 0));

  if (layout.divider) {
    parts.push(
      `<line x1="${layout.divider.x1}" y1="${layout.divider.y1}" x2="${layout.divider.x2}" y2="${layout.divider.y2}" stroke="${layout.color}" stroke-width="${Math.max(
        0.6,
        layout.borderWidth * 0.6,
      )}" />`,
    );
  }

  const escape = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  for (const line of layout.lines) {
    parts.push(
      `<text x="${line.x}" y="${line.baseline}" font-family="${escape(line.family)}" font-size="${
        line.fontSize
      }" font-weight="${line.bold ? 700 : 400}"${
        line.italic ? ' font-style="italic"' : ''
      } fill="${line.color}" letter-spacing="${line.letterSpacing}">${escape(line.text)}</text>`,
    );
  }

  for (const char of layout.chars) {
    parts.push(
      `<text x="0" y="0" transform="translate(${char.x} ${char.y}) rotate(${char.angle})" font-family="${escape(
        char.family,
      )}" font-size="${char.fontSize}" fill="${char.color}">${escape(char.char)}</text>`,
    );
  }

  if (layout.logo) {
    parts.push(
      `<image x="${layout.logo.x}" y="${layout.logo.y}" width="${layout.logo.width}" height="${
        layout.logo.height
      }" opacity="${layout.logo.opacity}" href="${layout.logo.src}" />`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${layout.width} ${layout.height}">
  ${parts.join('\n  ')}
</svg>`;
}

/** Копия шаблона с новым идентификатором (для «одноразовых» штампов). */
export function cloneStampTemplate(template: StampTemplate, patch: Partial<StampTemplate> = {}): StampTemplate {
  const now = new Date().toISOString();
  return {
    ...template,
    id: patch.id ?? createId('stamp'),
    createdAt: now,
    updatedAt: now,
    lines: template.lines.map((line) => ({ ...line, id: createId('line') })),
    circularText: { ...template.circularText },
    logo: template.logo ? { ...template.logo } : null,
    ...patch,
  };
}

/**
 * Подгонка шаблона под размеры объекта на странице.
 *
 * Используется и при векторном экспорте в PDF, и при отрисовке на канвасе,
 * поэтому предпросмотр и результат совпадают. «Физические» размеры
 * (толщина рамки, размеры шрифтов, отступы, логотип) масштабируются
 * единым коэффициентом, а габариты — по фактическим размерам объекта.
 */
export function fitStampTemplate(
  template: StampTemplate,
  width: number,
  height: number,
): StampTemplate {
  const sourceWidth = Math.max(1, template.width);
  const sourceHeight = Math.max(1, template.height);
  const targetWidth = Math.max(8, width);
  const targetHeight = Math.max(8, height);
  if (
    Math.abs(sourceWidth - targetWidth) < 0.01 &&
    Math.abs(sourceHeight - targetHeight) < 0.01
  ) {
    return template;
  }
  const scaleX = targetWidth / sourceWidth;
  const scaleY = targetHeight / sourceHeight;
  const uniform = (scaleX + scaleY) / 2;
  const scale = (value: number, by = uniform): number => Math.round(value * by * 100) / 100;

  return {
    ...template,
    width: targetWidth,
    height: targetHeight,
    borderWidth: scale(template.borderWidth),
    borderGap: scale(template.borderGap),
    cornerRadius: scale(template.cornerRadius),
    lines: template.lines.map((line) => ({
      ...line,
      fontSize: scale(line.fontSize),
      letterSpacing: scale(line.letterSpacing),
      offsetY: scale(line.offsetY, scaleY),
    })),
    circularText: {
      ...template.circularText,
      fontSize: scale(template.circularText.fontSize),
      radius: template.circularText.radius > 0 ? scale(template.circularText.radius) : 0,
      letterSpacing: scale(template.circularText.letterSpacing),
    },
    logo: template.logo
      ? {
          ...template.logo,
          width: scale(template.logo.width, scaleX),
          height: scale(template.logo.height, scaleY),
          offsetX: scale(template.logo.offsetX, scaleX),
          offsetY: scale(template.logo.offsetY, scaleY),
        }
      : null,
  };
}

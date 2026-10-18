/**
 * ============================================================================
 *  Экспорт в PDF (pdf-lib + fontkit).
 * ============================================================================
 *
 *  Пайплайн (без «кракозябр»):
 *   1. исходный PDF загружается как ArrayBuffer;
 *   2. документ открывается через pdf-lib (страницы сохраняются как есть);
 *   3. регистрируется fontkit и встраиваются TTF-шрифты с кириллицей
 *      (подмножествами — файл не раздувается);
 *   4. для каждой страницы объекты сортируются по z-index и рисуются
 *      настоящими PDF-операторами: текст остаётся текстом, фигуры —
 *      векторами, изображения встраиваются как XObject;
 *   5. прозрачность, поворот, поворот страницы (/Rotate) и смещение
 *      MediaBox учитываются (см. `@/utils/coordinates`);
 *   6. метаданные пишутся в Unicode;
 *   7. результат сохраняется как Blob.
 *
 *  Дополнительно поддерживается «плоский» режим (`rasterize`), когда каждая
 *  страница превращается в изображение высокого разрешения — например,
 *  чтобы исключить возможность правки аннотаций.
 */

import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import type {
  DrawingPayload,
  EditorObject,
  ExportResult,
  ExportSettings,
  HighlightPayload,
  ImagePayload,
  ShapePayload,
  SignaturePayload,
  StampPayload,
  TextPayload,
  WhiteoutPayload,
} from '@/types';
import type { PageGeometry } from '@/utils/coordinates';
import { getPdfObjectRotation, konvaToPdfCoordinates, localPointToPdf } from '@/utils/coordinates';
import { dataUrlMime, dataUrlToBytes } from '@/utils/encoding';
import { buildExportFileName, resolveExportScale, resolveSelectedPages } from '@/utils/export';
import { detectPdfEncryption, hexToRgb } from '@/utils/pdf';
import { canvasToBlob } from '@/utils/download';
import { dataUrlToImageBlob } from '@/utils/image';
import { fontService } from '@/services/fontService';
import { getStrokeOutline, outlineToPath } from '@/services/strokeService';
import { fitStampTemplate } from '@/services/stampRenderService';
import { drawStampToPdfPage } from '@/services/stampPdfRenderer';
import { computeTextBlockLayout } from '@/services/textRenderService';
import { justifyOffsets, measureTextWidth } from '@/utils/textLayout';
import { normalizeSides, polygonPath } from '@/utils/shapePath';
import { renderPageCanvas } from '@/services/imageExportService';

/** Наклон синтетического курсива (когда в шрифте нет italic-начертания). */
const ITALIC_SKEW_DEGREES = 12;

/** Входные данные экспорта PDF. */
export interface PdfExportInput {
  settings: ExportSettings;
  objects: EditorObject[];
  /** Оригинальные байты PDF (null — если документа нет). */
  originalBytes: Uint8Array | null;
  /** Геометрия страниц. */
  pageGeometry: PageGeometry[];
  /**
   * Повороты страниц, добавленные пользователем в редакторе (по индексу
   * страницы). Записываются в `/Rotate` выходного PDF поверх исходного.
   */
  pageViewRotations?: number[];
  /** Текущая страница (для режима «только текущая»). */
  currentPage?: number;
  /**
   * Рендер исходной страницы в canvas.
   * Нужен для «плоского» PDF и для отказа от исходного содержимого.
   */
  renderOriginalPage?: (
    pageIndex: number,
    scale: number,
    transparent: boolean,
  ) => Promise<HTMLCanvasElement | null>;
  /** Прогресс 0..1. */
  onProgress?: (value: number, label: string) => void;
  /** Проверять поддержку символов шрифтами (значение из настроек приложения). */
  checkGlyphs?: boolean;
}

/** Контекст отрисовки аннотаций. */
interface DrawContext {
  doc: PDFDocument;
  fontCache: Map<string, PDFFont>;
  imageCache: Map<string, PDFImage>;
  warnings: string[];
  checkGlyphs: boolean;
  compressImages: boolean;
  quality: number;
  familyFor: (fontId?: string) => string;
}

/** Кадр объекта: точка привязки и функция перевода локальных координат. */
interface ObjectFrame {
  /** Локальная точка (Y вниз) → PDF. */
  toPdf: (localX: number, localYDown: number) => { x: number; y: number };
  /** Точка привязки (левый верхний угол объекта) в PDF. */
  anchor: { x: number; y: number };
  /** Угол поворота для pdf-lib. */
  rotate: number;
}

/** Итог сборки PDF. */
export interface BuildPdfResult {
  bytes: Uint8Array;
  warnings: string[];
}

/** Геометрия страницы из уже загруженного pdf-lib документа. */
function geometryOfPdfPage(page: PDFPage): PageGeometry {
  const mediaBox = page.getMediaBox();
  return {
    width: mediaBox.width,
    height: mediaBox.height,
    rotation: ((page.getRotation().angle % 360) + 360) % 360,
    originX: mediaBox.x,
    originY: mediaBox.y,
  };
}

/** Создание кадра объекта. */
function frameOf(obj: EditorObject, geo: PageGeometry): ObjectFrame {
  const anchor = konvaToPdfCoordinates(obj.x, obj.y, geo);
  return {
    anchor,
    rotate: getPdfObjectRotation(geo, obj.rotation),
    toPdf: (localX: number, localYDown: number) => localPointToPdf(localX, localYDown, obj, geo),
  };
}

/** SVG-путь прямоугольника со скруглёнными углами (Y вниз). */
function roundedRectPath(width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r <= 0.01) {
    return `M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z`;
  }
  const c = r * 0.5523;
  return [
    `M ${r} 0`,
    `L ${width - r} 0`,
    `C ${width - r + c} 0 ${width} ${r - c} ${width} ${r}`,
    `L ${width} ${height - r}`,
    `C ${width} ${height - r + c} ${width - r + c} ${height} ${width - r} ${height}`,
    `L ${r} ${height}`,
    `C ${r - c} ${height} 0 ${height - r + c} 0 ${height - r}`,
    `L 0 ${r}`,
    `C 0 ${r - c} ${r - c} 0 ${r} 0`,
    'Z',
  ].join(' ');
}

/** Встраивание изображения с кэшированием. */
async function embedImage(
  ctx: DrawContext,
  src: string,
  mimeType: string,
): Promise<PDFImage | null> {
  if (!src) return null;
  const mime = mimeType || dataUrlMime(src);
  const cacheKey = `${mime}:${src.slice(-64)}:${src.length}`;
  const cached = ctx.imageCache.get(cacheKey);
  if (cached) return cached;

  try {
    let bytes = dataUrlToBytes(src);
    let effectiveMime = mime;

    if (ctx.compressImages && /png/i.test(mime)) {
      // Перекодирование PNG → JPEG (прозрачность при этом теряется).
      const { blob } = await dataUrlToImageBlob(src, 'image/jpeg', ctx.quality);
      bytes = new Uint8Array(await blob.arrayBuffer());
      effectiveMime = 'image/jpeg';
    }

    const image = /jpe?g/i.test(effectiveMime)
      ? await ctx.doc.embedJpg(bytes)
      : await ctx.doc.embedPng(bytes);
    ctx.imageCache.set(cacheKey, image);
    return image;
  } catch {
    ctx.warnings.push('Одно из изображений не удалось встроить в PDF и было пропущено.');
    return null;
  }
}

/**
 * Убирает из текста символы, которых нет в шрифте.
 *
 * pdf-lib бросает/обрывает `drawText` на первом неподдерживаемом символе, из-за
 * чего пропадал весь остаток строки (например, «№» в Montserrat). Пробелы и
 * переносы сохраняем, остальные отсутствующие символы выбрасываем.
 */
function stripMissingGlyphs(text: string, font: PDFFont): string {
  if (text.length === 0) return text;
  let result = '';
  for (const char of text) {
    if (char === ' ' || char === '\n' || char === '\t') {
      result += char;
      continue;
    }
    try {
      if (font.getCharacterSet().includes(char.codePointAt(0) ?? 0)) {
        result += char;
      }
    } catch {
      result += char;
    }
  }
  return result;
}

/** Разрешение шрифта с проверкой покрытия глифов. */
async function resolveFont(
  ctx: DrawContext,
  fontId: string,
  bold: boolean,
  italic: boolean,
  text: string,
): Promise<{ font: PDFFont; syntheticItalic: boolean }> {
  let effectiveId = fontId;
  const asset = fontService.get(effectiveId);
  if (!asset) {
    effectiveId = fontService.getCyrillicFont(effectiveId)?.id ?? effectiveId;
  }

  if (ctx.checkGlyphs && text.trim().length > 0) {
    const coverage = await fontService.checkCoverage(effectiveId, text, bold, italic);
    if (!coverage.supported) {
      const fallback = fontService
        .list()
        .find((font) => font.supportsCyrillic && font.id !== effectiveId);
      const missing = coverage.missing.slice(0, 24).join(' ');
      if (fallback) {
        ctx.warnings.push(
          `В шрифте «${fontService.get(effectiveId)?.name ?? effectiveId}» нет символов: ${missing}. ` +
            `Текст выведен шрифтом «${fallback.name}».`,
        );
        effectiveId = fallback.id;
      } else {
        ctx.warnings.push(`В шрифте нет символов: ${missing}. Часть текста может не отобразиться.`);
      }
    }
  }

  const assetFinal = fontService.get(effectiveId);
  const faceKey = assetFinal ? fontService.pickFaceKey(assetFinal, bold, italic) : '400-normal';
  const syntheticItalic = italic && !faceKey.endsWith('italic');

  const { font } = await fontService.embedFont(ctx.doc, ctx.fontCache, effectiveId, bold, italic);
  return { font, syntheticItalic };
}

/* ==========================================================================
 *  Отрисовка объектов
 * ========================================================================== */

/** Текстовый объект. */
async function drawTextObject(
  page: PDFPage,
  obj: EditorObject & { payload: TextPayload },
  geo: PageGeometry,
  ctx: DrawContext,
): Promise<void> {
  const payload = obj.payload;
  const frame = frameOf(obj, geo);
  const layout = computeTextBlockLayout(payload, obj.width, obj.height);
  const { font, syntheticItalic } = await resolveFont(
    ctx,
    payload.fontId,
    payload.bold,
    payload.italic,
    payload.text,
  );
  const color = hexToRgb(payload.color);
  const skew = syntheticItalic ? ITALIC_SKEW_DEGREES : 0;
  const opacity = Math.max(0, Math.min(1, obj.opacity));

  const drawLineAt = (
    text: string,
    localX: number,
    baseline: number,
    withSkew: number,
    fill: { r: number; g: number; b: number },
    lineOpacity: number,
  ): number => {
    // Убираем символы, которых нет в шрифте (например «№» в Montserrat):
    // pdf-lib на первом же таком символе обрывает строку, и весь остаток
    // текста пропадал из PDF.
    const safe = stripMissingGlyphs(text, font);
    if (safe.length === 0) return 0;
    const point = frame.toPdf(localX, baseline);
    page.drawText(safe, {
      x: point.x,
      y: point.y,
      size: payload.fontSize,
      font,
      color: rgb(fill.r, fill.g, fill.b),
      opacity: lineOpacity,
      rotate: degrees(frame.rotate),
      xSkew: degrees(withSkew),
    });
    return font.widthOfTextAtSize(safe, payload.fontSize);
  };

  // «Тень» (белый ореол) — делает текст читаемым поверх сканов.
  if (payload.shadow) {
    const offset = Math.max(0.5, payload.fontSize * 0.06);
    for (const line of layout.lines) {
      for (const [dx, dy] of [
        [-offset, 0],
        [offset, 0],
        [0, -offset],
        [0, offset],
      ]) {
        drawLineAt(
          line.text,
          line.x + dx,
          line.baseline + dy,
          0,
          { r: 1, g: 1, b: 1 },
          opacity * 0.6,
        );
      }
    }
  }

  const lastIndex = layout.lines.length - 1;
  layout.lines.forEach((line, index) => {
    if (payload.align === 'justify' && index !== lastIndex && line.text.trim().includes(' ')) {
      const { words, offsets } = justifyOffsets(line.text, {
        fontFamily: payload.fontFamily,
        fontSize: payload.fontSize,
        bold: payload.bold,
        italic: payload.italic,
        letterSpacing: payload.letterSpacing,
        lineHeight: payload.lineHeight,
      }, obj.width, payload.padding);
      words.forEach((word, wordIndex) => {
        drawLineAt(word, payload.padding + offsets[wordIndex], line.baseline, skew, color, opacity);
      });
    } else if (payload.letterSpacing > 0.01) {
      let advance = 0;
      for (const char of line.text) {
        advance +=
          drawLineAt(char, line.x + advance, line.baseline, skew, color, opacity) +
          payload.letterSpacing;
      }
    } else {
      drawLineAt(line.text, line.x, line.baseline, skew, color, opacity);
    }

    if (payload.underline) {
      const start = frame.toPdf(line.x, line.baseline + layout.descent * 0.45);
      const end = frame.toPdf(line.x + line.width, line.baseline + layout.descent * 0.45);
      page.drawLine({
        start,
        end,
        thickness: Math.max(0.5, payload.fontSize * 0.06),
        color: rgb(color.r, color.g, color.b),
        opacity,
        lineCap: LineCapStyle.Butt,
      });
    }
  });
}

/** Изображение. */
async function drawImageObject(
  page: PDFPage,
  obj: EditorObject & { payload: ImagePayload },
  geo: PageGeometry,
  ctx: DrawContext,
): Promise<void> {
  const payload = obj.payload;
  const image = await embedImage(ctx, payload.src, payload.mimeType);
  if (!image) return;
  const frame = frameOf(obj, geo);
  const bottomLeft = frame.toPdf(0, obj.height);
  if (payload.cornerRadius > 0.5) {
    ctx.warnings.push(
      'Скругление углов изображений не поддерживается в PDF — изображение выведено прямоугольным.',
    );
  }
  page.drawImage(image, {
    x: bottomLeft.x,
    y: bottomLeft.y,
    width: obj.width,
    height: obj.height,
    rotate: degrees(frame.rotate),
    opacity: Math.max(0, Math.min(1, obj.opacity)),
    blendMode: BlendMode.Normal,
  });
}

/** Фигуры: прямоугольник, эллипс, линия, стрелка. */
function drawShapeObject(
  page: PDFPage,
  obj: EditorObject & { payload: ShapePayload },
  geo: PageGeometry,
): void {
  const payload = obj.payload;
  const frame = frameOf(obj, geo);
  // Обводки может не быть вовсе: «без цвета» (stroke: null) или нулевая толщина.
  const strokeColor = payload.stroke ?? null;
  const stroke = strokeColor ? hexToRgb(strokeColor) : null;
  const hasStroke = Boolean(stroke) && payload.strokeWidth > 0;
  const fill = payload.fill ? hexToRgb(payload.fill) : null;
  const opacity = Math.max(0, Math.min(1, obj.opacity));
  const dash = payload.dash.length > 0 ? payload.dash : undefined;

  if (payload.kind === 'rect') {
    const path = roundedRectPath(obj.width, obj.height, payload.cornerRadius);
    page.drawSvgPath(path, {
      x: frame.anchor.x,
      y: frame.anchor.y,
      rotate: degrees(frame.rotate),
      color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
      opacity: fill ? opacity : undefined,
      borderColor: hasStroke && stroke ? rgb(stroke.r, stroke.g, stroke.b) : undefined,
      borderWidth: hasStroke ? payload.strokeWidth : 0,
      borderOpacity: opacity,
      borderDashArray: hasStroke ? dash : undefined,
      // Круглые концы штрихов — чтобы «Пунктир» был точками, как у линии.
      borderLineCap: LineCapStyle.Round,
    });
    return;
  }

  if (payload.kind === 'ellipse') {
    const center = frame.toPdf(obj.width / 2, obj.height / 2);
    page.drawEllipse({
      x: center.x,
      y: center.y,
      xScale: obj.width / 2,
      yScale: obj.height / 2,
      rotate: degrees(frame.rotate),
      color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
      opacity: fill ? opacity : undefined,
      borderColor: hasStroke && stroke ? rgb(stroke.r, stroke.g, stroke.b) : undefined,
      borderWidth: hasStroke ? payload.strokeWidth : 0,
      borderOpacity: opacity,
      borderDashArray: hasStroke ? dash : undefined,
      // Круглые концы штрихов — чтобы «Пунктир» был точками, как у линии.
      borderLineCap: LineCapStyle.Round,
    });
    return;
  }

  if (payload.kind === 'triangle' || payload.kind === 'polygon') {
    // Путь в тех же координатах, что и у прямоугольника: pdf-lib сам
    // переворачивает Y (scale(1,-1)), поэтому путь задаётся «как на экране».
    // С флагом flipY фигура выходила перевёрнутой.
    const sides = payload.kind === 'triangle' ? 3 : normalizeSides(payload.sides);
    const path = polygonPath(obj.width, obj.height, sides, payload.cornerRadius);
    page.drawSvgPath(path, {
      x: frame.anchor.x,
      y: frame.anchor.y,
      rotate: degrees(frame.rotate),
      color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
      opacity: fill ? opacity : undefined,
      borderColor: hasStroke && stroke ? rgb(stroke.r, stroke.g, stroke.b) : undefined,
      borderWidth: hasStroke ? payload.strokeWidth : 0,
      borderOpacity: opacity,
      borderDashArray: hasStroke ? dash : undefined,
      // Круглые концы штрихов — чтобы «Пунктир» был точками, как у линии.
      borderLineCap: LineCapStyle.Round,
    });
    return;
  }

  // Линия или стрелка: без обводки рисовать нечего.
  if (!hasStroke || !stroke) return;

  // Линия или стрелка: координаты заданы нормализованно внутри bbox.
  const [nx1, ny1, nx2, ny2] = payload.points;
  const start = frame.toPdf(nx1 * obj.width, ny1 * obj.height);
  const end = frame.toPdf(nx2 * obj.width, ny2 * obj.height);
  page.drawLine({
    start,
    end,
    thickness: payload.strokeWidth,
    color: rgb(stroke.r, stroke.g, stroke.b),
    opacity,
    dashArray: dash,
    lineCap: LineCapStyle.Round,
  });

  if (payload.kind === 'arrow') {
    const headLength = Math.max(7, payload.strokeWidth * 3.4);
    const headWidth = Math.max(5, payload.strokeWidth * 2.6);
    const arrowHead = payload.arrowHead ?? 'end';
    const startLocal: [number, number] = [nx1 * obj.width, ny1 * obj.height];
    const endLocal: [number, number] = [nx2 * obj.width, ny2 * obj.height];
    const color = rgb(stroke.r, stroke.g, stroke.b);

    /** Треугольный наконечник: вершина `tip`, основание — со стороны `from`. */
    const drawHead = (tip: [number, number], from: [number, number]): void => {
      const dx = tip[0] - from[0];
      const dy = tip[1] - from[1];
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const baseX = tip[0] - ux * headLength;
      const baseY = tip[1] - uy * headLength;
      const perpX = -uy;
      const perpY = ux;
      const headPath = [
        `M ${tip[0]} ${tip[1]}`,
        `L ${baseX + (perpX * headWidth) / 2} ${baseY + (perpY * headWidth) / 2}`,
        `L ${baseX - (perpX * headWidth) / 2} ${baseY - (perpY * headWidth) / 2}`,
        'Z',
      ].join(' ');
      page.drawSvgPath(headPath, {
        x: frame.anchor.x,
        y: frame.anchor.y,
        rotate: degrees(frame.rotate),
        color,
        opacity,
      });
    };

    if (arrowHead !== 'none') drawHead(endLocal, startLocal);
    if (arrowHead === 'both') drawHead(startLocal, endLocal);
  }
}

/** Закрашивание (корректор) и выделение. */
function drawFlatRect(
  page: PDFPage,
  obj: EditorObject & { payload: WhiteoutPayload | HighlightPayload },
  geo: PageGeometry,
  options: { color: string; opacity: number; blendMode: BlendMode },
): void {
  const frame = frameOf(obj, geo);
  const color = hexToRgb(options.color);
  const bottomLeft = frame.toPdf(0, obj.height);
  page.drawRectangle({
    x: bottomLeft.x,
    y: bottomLeft.y,
    width: obj.width,
    height: obj.height,
    rotate: degrees(frame.rotate),
    color: rgb(color.r, color.g, color.b),
    opacity: options.opacity,
    blendMode: options.blendMode,
  });
}

/** Рукописные штрихи (рисунки и подписи) — векторно. */
function drawStrokesObject(
  page: PDFPage,
  obj: EditorObject & { payload: DrawingPayload | SignaturePayload },
  geo: PageGeometry,
): void {
  const payload = obj.payload;
  const designWidth = payload.designWidth > 0 ? payload.designWidth : obj.width;
  const designHeight = payload.designHeight > 0 ? payload.designHeight : obj.height;
  const scaleX = obj.width / designWidth;
  const scaleY = obj.height / designHeight;
  const frame = frameOf(obj, geo);

  for (const stroke of payload.strokes) {
    const outline = getStrokeOutline(stroke);
    if (outline.length < 3) continue;
    const scaled = outline.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));
    const path = outlineToPath(scaled, true);
    const color = hexToRgb(stroke.color);
    page.drawSvgPath(path, {
      x: frame.anchor.x,
      y: frame.anchor.y,
      rotate: degrees(frame.rotate),
      color: rgb(color.r, color.g, color.b),
      opacity: Math.max(0, Math.min(1, stroke.opacity * obj.opacity)),
    });
  }
}

/** Штамп или печать. */
async function drawStampObject(
  page: PDFPage,
  obj: EditorObject & { payload: StampPayload },
  geo: PageGeometry,
  ctx: DrawContext,
): Promise<void> {
  const payload = obj.payload;
  const template = fitStampTemplate(payload.template, obj.width, obj.height);
  const frame = frameOf(obj, geo);

  let logoImage: PDFImage | null = null;
  if (template.logo?.src) {
    logoImage = await embedImage(ctx, template.logo.src, dataUrlMime(template.logo.src));
    if (!logoImage) {
      ctx.warnings.push('Логотип штампа (SVG) не удалось встроить — штамп выведен без логотипа.');
    }
  }

  await drawStampToPdfPage(page, template, {
    toPdf: frame.toPdf,
    rotate: frame.rotate,
    resolveFamily: (fontId?: string) => ctx.familyFor(fontId),
    embedFont: async (fontId: string, bold: boolean, italic: boolean) => {
      const { font } = await resolveFont(ctx, fontId, bold, italic, '');
      return font;
    },
    logoImage,
    textOverride: payload.overrides.textOverride ?? null,
    colorOverride: payload.overrides.color ?? null,
    alpha: Math.max(0, Math.min(1, obj.opacity * (payload.overrides.opacity ?? 1))),
  });
}

/** Диспетчер отрисовки одного объекта. */
async function drawObject(
  page: PDFPage,
  obj: EditorObject,
  geo: PageGeometry,
  ctx: DrawContext,
): Promise<void> {
  if (!obj.visible) return;
  switch (obj.type) {
    case 'text':
      await drawTextObject(page, obj as EditorObject & { payload: TextPayload }, geo, ctx);
      break;
    case 'image':
      await drawImageObject(page, obj as EditorObject & { payload: ImagePayload }, geo, ctx);
      break;
    case 'shape':
      drawShapeObject(page, obj as EditorObject & { payload: ShapePayload }, geo);
      break;
    case 'whiteout':
      drawFlatRect(page, obj as EditorObject & { payload: WhiteoutPayload }, geo, {
        color: obj.payload.color || '#ffffff',
        opacity: Math.max(0, Math.min(1, obj.opacity)),
        blendMode: BlendMode.Normal,
      });
      break;
    case 'highlight':
      drawFlatRect(page, obj as EditorObject & { payload: HighlightPayload }, geo, {
        color: obj.payload.color || '#facc15',
        opacity: Math.max(0, Math.min(1, obj.opacity * 0.4)),
        blendMode: obj.payload.blend === 'multiply' ? BlendMode.Multiply : BlendMode.Normal,
      });
      break;
    case 'drawing':
    case 'signature':
      drawStrokesObject(page, obj as EditorObject & { payload: DrawingPayload | SignaturePayload }, geo);
      break;
    case 'stamp':
      await drawStampObject(page, obj as EditorObject & { payload: StampPayload }, geo, ctx);
      break;
    default:
      break;
  }
}

/* ==========================================================================
 *  Сборка документа
 * ========================================================================== */

/** Векторная сборка PDF (основной путь, без растеризации страниц). */
export async function buildAnnotatedPdf(input: PdfExportInput): Promise<BuildPdfResult> {
  const { settings, objects, originalBytes, pageGeometry } = input;
  const warnings: string[] = [];
  const progress = input.onProgress ?? ((): void => undefined);
  const total = pageGeometry.length;
  const selected = resolveSelectedPages(settings, total, input.currentPage ?? 0);

  if (originalBytes && detectPdfEncryption(originalBytes)) {
    warnings.push(
      'Документ зашифрован. Экспорт в PDF может быть неполным — при проблемах используйте экспорт в изображения (PNG/JPEG).',
    );
  }

  await fontService.loadAll();
  progress(0.05, 'Подготовка документа');

  let doc: PDFDocument;
  let targetPages: PDFPage[] = [];

  const useOriginal = Boolean(originalBytes) && settings.includeOriginalContent;
  if (useOriginal && originalBytes) {
    try {
      doc = await PDFDocument.load(originalBytes, {
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Не удалось открыть исходный PDF для экспорта: ${message}`);
    }

    const allPages = doc.getPages();
    if (selected.length !== allPages.length) {
      // Переносим только выбранные страницы в новый документ.
      const copied = await PDFDocument.create();
      const pages = await copied.copyPages(
        doc,
        selected.filter((index) => index < allPages.length),
      );
      pages.forEach((page) => copied.addPage(page));
      doc = copied;
      targetPages = doc.getPages();
    } else {
      targetPages = allPages;
    }
  } else {
    // Аннотации на чистых листах нужного размера.
    doc = await PDFDocument.create();
    for (const index of selected) {
      const geo = pageGeometry[index];
      if (!geo) continue;
      const page = doc.addPage([geo.width, geo.height]);
      if (geo.rotation) page.setRotation(degrees(geo.rotation));
      page.drawRectangle({
        x: geo.originX ?? 0,
        y: geo.originY ?? 0,
        width: geo.width,
        height: geo.height,
        color: rgb(1, 1, 1),
      });
      targetPages.push(page);
    }
  }

  fontService.registerFontkit(doc);

  const ctx: DrawContext = {
    doc,
    fontCache: new Map<string, PDFFont>(),
    imageCache: new Map<string, PDFImage>(),
    warnings,
    checkGlyphs: input.checkGlyphs ?? true,
    compressImages: settings.compressImages,
    quality: settings.quality,
    familyFor: (fontId?: string) => fontService.getCyrillicFont(fontId)?.family ?? 'PT Sans',
  };

  const byPage = new Map<number, EditorObject[]>();
  if (settings.includeAnnotations) {
    for (const obj of objects) {
      const list = byPage.get(obj.page) ?? [];
      list.push(obj);
      byPage.set(obj.page, list);
    }
  }

  const sourceIndices = selected;
  for (let position = 0; position < targetPages.length; position += 1) {
    const page = targetPages[position];
    const sourceIndex = sourceIndices[position] ?? sourceIndices[sourceIndices.length - 1] ?? 0;

    // Пользовательский поворот страницы записываем в PDF до расчёта координат:
    // аннотации уже пересчитаны в систему координат этого поворота.
    // Для созданных «с нуля» страниц поворот уже выставлен при создании.
    const viewRotation = useOriginal ? input.pageViewRotations?.[sourceIndex] ?? 0 : 0;
    if (viewRotation) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((((current + viewRotation) % 360) + 360) % 360));
    }

    const geo = geometryOfPdfPage(page);
    const pageObjects = (byPage.get(sourceIndex) ?? []).slice().sort((a, b) => a.zIndex - b.zIndex);

    for (const obj of pageObjects) {
      try {
        await drawObject(page, obj, geo, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Объект не удалось вывести в PDF: ${message}`);
      }
    }

    progress(0.1 + (0.7 * (position + 1)) / Math.max(1, targetPages.length), 'Отрисовка объектов');
  }

  applyMetadata(doc, settings);
  progress(0.9, 'Сохранение файла');

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes, warnings };
}

/** Растеризованный («плоский») PDF: страницы становятся изображениями. */
async function buildRasterizedPdf(input: PdfExportInput): Promise<BuildPdfResult> {
  const { settings, objects, pageGeometry } = input;
  const warnings = [
    'Выбран режим «плоский PDF»: содержимое страниц растеризовано, текст больше не является текстом.',
  ];
  const progress = input.onProgress ?? ((): void => undefined);
  const selected = resolveSelectedPages(settings, pageGeometry.length, input.currentPage ?? 0);
  const scale = resolveExportScale(settings);
  const doc = await PDFDocument.create();

  for (let position = 0; position < selected.length; position += 1) {
    const index = selected[position];
    const geo = pageGeometry[index];
    if (!geo) continue;

    const background = input.renderOriginalPage
      ? await input.renderOriginalPage(index, scale, false)
      : null;

    const canvas = await renderPageCanvas({
      pageIndex: index,
      scale,
      geometry: geo,
      objects: settings.includeAnnotations ? objects : [],
      backgroundCanvas: settings.includeOriginalContent ? background : null,
      transparent: false,
      whiteBackground: true,
    });

    const blob = await canvasToBlob(canvas, 'image/png');
    const pngBytes = new Uint8Array(await blob.arrayBuffer());
    const image = await doc.embedPng(pngBytes);

    // Размер страницы — отображаемый (с учётом /Rotate), поворот уже в растре.
    const displayWidth = geo.rotation === 90 || geo.rotation === 270 ? geo.height : geo.width;
    const displayHeight = geo.rotation === 90 || geo.rotation === 270 ? geo.width : geo.height;
    const page = doc.addPage([displayWidth, displayHeight]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: displayWidth,
      height: displayHeight,
    });
    progress(0.1 + (0.8 * (position + 1)) / Math.max(1, selected.length), 'Растеризация страниц');
  }

  applyMetadata(doc, settings);
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes, warnings };
}

/** Запись метаданных (Unicode). */
function applyMetadata(doc: PDFDocument, settings: ExportSettings): void {
  const meta = settings.metadata;
  try {
    if (meta.title.trim()) doc.setTitle(meta.title.trim());
    if (meta.author.trim()) doc.setAuthor(meta.author.trim());
    if (meta.subject.trim()) doc.setSubject(meta.subject.trim());
    if (meta.keywords.trim()) {
      doc.setKeywords(
        meta.keywords
          .split(/[,;]+/)
          .map((item) => item.trim())
          .filter(Boolean),
      );
    }
    doc.setCreator(meta.creator.trim() || 'PDF Редактор');
    doc.setProducer(meta.producer.trim() || 'PDF Редактор (pdf-lib)');
    doc.setModificationDate(new Date());
  } catch {
    /* метаданные не критичны */
  }
}

/** Основная точка входа: экспорт PDF. */
export async function exportPdf(input: PdfExportInput): Promise<ExportResult> {
  const fileName = buildExportFileName(input.settings, 'pdf');
  try {
    if (input.pageGeometry.length === 0) {
      throw new Error('Документ не содержит страниц');
    }
    const result = input.settings.rasterize
      ? await buildRasterizedPdf(input)
      : await buildAnnotatedPdf(input);

    const copy = new Uint8Array(result.bytes.byteLength);
    copy.set(result.bytes);
    const blob = new Blob([copy.buffer as ArrayBuffer], { type: 'application/pdf' });
    return {
      ok: true,
      fileName,
      size: blob.size,
      blob,
      warnings: result.warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      fileName,
      size: 0,
      blob: new Blob([], { type: 'application/pdf' }),
      warnings: [],
      error: message,
    };
  }
}

/** Проверка: останется ли текст текстом (для подсказок в интерфейсе). */
export function willKeepTextVector(settings: ExportSettings): boolean {
  return !settings.rasterize;
}

/** Подсчёт количества объектов, которые будут экспортированы. */
export function countExportableObjects(objects: EditorObject[]): number {
  return objects.filter((obj) => obj.visible).length;
}

/** Проверка покрытия глифов для всех текстов документа (предупреждения до экспорта). */
export async function collectFontWarnings(objects: EditorObject[]): Promise<string[]> {
  const warnings: string[] = [];
  const byFont = new Map<string, { text: string; bold: boolean; italic: boolean }>();
  const add = (fontId: string, text: string, bold: boolean, italic: boolean): void => {
    const key = `${fontId}|${bold ? 'b' : 'n'}|${italic ? 'i' : 'n'}`;
    const existing = byFont.get(key);
    if (existing) existing.text += text;
    else byFont.set(key, { text, bold, italic });
  };

  for (const obj of objects) {
    if (!obj.visible) continue;
    if (obj.type === 'text') {
      add(obj.payload.fontId, obj.payload.text, obj.payload.bold, obj.payload.italic);
    } else if (obj.type === 'stamp') {
      const template = obj.payload.template;
      for (const line of template.lines) {
        add(line.fontId ?? template.fontId, line.text, line.bold, line.italic);
      }
      if (template.circularText.enabled) {
        add(template.fontId, template.circularText.text, false, false);
        add(template.fontId, template.circularText.bottomText, false, false);
      }
    }
  }

  for (const [key, value] of byFont) {
    const [fontId] = key.split('|');
    const coverage = await fontService.checkCoverage(fontId, value.text, value.bold, value.italic);
    if (!coverage.supported) {
      const name = fontService.get(fontId)?.name ?? fontId;
      warnings.push(
        `Шрифт «${name}»: отсутствуют символы ${coverage.missing.slice(0, 24).join(' ')}. ` +
          'При экспорте будет подобран шрифт с поддержкой этих символов.',
      );
    }
  }
  return warnings;
}

/** Утилита: ширина текста встроенным шрифтом (для отладки и тестов). */
export function measureWithFont(font: PDFFont, text: string, size: number): number {
  return font.widthOfTextAtSize(text, size);
}

/** Утилита: измерение текста средствами канваса (совпадает с превью). */
export function measureWithCanvas(payload: TextPayload, text: string): number {
  return measureTextWidth(text, {
    fontFamily: payload.fontFamily,
    fontSize: payload.fontSize,
    bold: payload.bold,
    italic: payload.italic,
    letterSpacing: payload.letterSpacing,
    lineHeight: payload.lineHeight,
  });
}

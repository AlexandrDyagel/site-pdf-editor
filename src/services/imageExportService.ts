/**
 * ============================================================================
 *  Растровый экспорт: PNG / JPEG / WebP, ZIP-архивы, «плоский» PDF,
 *  а также изображения страниц для DOCX.
 * ============================================================================
 *
 *  Отрисовка выполняется на «невидимой» Konva-сцене через ту же фабрику
 *  объектов, что используется в редакторе. Поэтому растровый экспорт
 *  выглядит точно так же, как предпросмотр, и учитывает кириллицу
 *  (шрифты подключаются через FontFace API).
 */

import Konva from 'konva';
import JSZip from 'jszip';
import type {
  DrawingTemplate,
  EditorObject,
  ExportResult,
  ExportSettings,
  SignatureTemplate,
  StampTemplate,
} from '@/types';
import type { PageGeometry } from '@/utils/coordinates';
import { getTransformForPage } from '@/utils/coordinates';
import { canvasToBlob } from '@/utils/download';
import {
  buildExportFileName,
  describeSelectedPages,
  extensionFor,
  imageMimeFor,
  pageFileLabel,
  resolveExportScale,
  resolveSelectedPages,
} from '@/utils/export';
import { createCanvas, getContext2d, loadImage } from '@/utils/image';
import {
  collectImageSources,
  createObjectNode,
  preloadImages,
  resolveFamily,
} from '@/services/konvaObjectFactory';
import { computeStampLayout, paintStampLayout } from '@/services/stampRenderService';
import { paintStrokes } from '@/services/strokeService';

/** Запрос на отрисовку страницы. */
export interface PageCanvasRequest {
  pageIndex: number;
  /** Пикселей на PDF point. */
  scale: number;
  geometry: PageGeometry;
  objects: EditorObject[];
  /** Уже отрисованная страница PDF. */
  backgroundCanvas?: HTMLCanvasElement | null;
  /** Прозрачный фон. */
  transparent?: boolean;
  /** Залить белым (например, для JPEG). */
  whiteBackground?: boolean;
}

/**
 * Отрисовка одной страницы (фон + аннотации) в canvas.
 * Используется для изображений, плоского PDF и DOCX.
 */
export async function renderPageCanvas(request: PageCanvasRequest): Promise<HTMLCanvasElement> {
  const {
    scale,
    geometry,
    objects,
    backgroundCanvas = null,
    transparent = false,
    whiteBackground = false,
  } = request;

  const transform = getTransformForPage(geometry, scale);
  const width = Math.max(1, Math.round(transform.displayWidth * scale));
  const height = Math.max(1, Math.round(transform.displayHeight * scale));

  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-100000px';
  container.style.top = '0';

  const stage = new Konva.Stage({ container, width, height });
  const layer = new Konva.Layer({ listening: false });
  stage.add(layer);

  try {
    if (backgroundCanvas) {
      layer.add(
        new Konva.Image({
          image: backgroundCanvas,
          x: 0,
          y: 0,
          width,
          height,
          listening: false,
        }),
      );
    } else if (!transparent || whiteBackground) {
      layer.add(
        new Konva.Rect({ x: 0, y: 0, width, height, fill: '#ffffff', listening: false }),
      );
    }

    const pending: Promise<unknown>[] = [];
    const visibleObjects = objects
      .filter((obj) => obj.visible)
      .slice()
      .sort((a, b) => a.zIndex - b.zIndex);

    for (const obj of visibleObjects) {
      const node = createObjectNode(obj, { pending });
      node.listening(false);
      layer.add(node);
    }

    if (pending.length > 0) await Promise.all(pending);
    layer.draw();

    const canvas = stage.toCanvas({ pixelRatio: 1 }) as HTMLCanvasElement;
    return canvas;
  } finally {
    stage.destroy();
    container.remove();
  }
}

/** Готовое изображение страницы. */
export interface RenderedPageImage {
  index: number;
  canvas: HTMLCanvasElement;
  blob: Blob;
  width: number;
  height: number;
}

/** Входные данные растрового экспорта. */
export interface ImageExportInput {
  settings: ExportSettings;
  objects: EditorObject[];
  pageGeometry: PageGeometry[];
  currentPage?: number;
  /** Рендер исходной страницы PDF в canvas. */
  renderOriginalPage?: (
    pageIndex: number,
    scale: number,
    transparent: boolean,
  ) => Promise<HTMLCanvasElement | null>;
  onProgress?: (value: number, label: string) => void;
}

/** Отрисовка списка страниц в изображения (без упаковки). */
export async function renderPagesImageList(
  input: ImageExportInput,
): Promise<{ pages: RenderedPageImage[]; warnings: string[]; fileName: string }> {
  const { settings, objects, pageGeometry } = input;
  const warnings: string[] = [];
  const progress = input.onProgress ?? ((): void => undefined);
  const selected = resolveSelectedPages(settings, pageGeometry.length, input.currentPage ?? 0);
  const scale = resolveExportScale(settings);
  const mime = imageMimeFor(settings.format);
  const transparent = settings.transparentBackground && mime !== 'image/jpeg';

  if (selected.length === 0) throw new Error('Не выбрано ни одной страницы');
  if (pageGeometry.some((geo) => geo.width * geo.height * scale * scale > 80_000_000)) {
    warnings.push('Очень высокое разрешение экспорта — процесс может занять много времени.');
  }

  // Предзагрузка изображений, чтобы они гарантированно попали в растр.
  if (settings.includeAnnotations) {
    await preloadImages(collectImageSources(objects));
  }

  const pages: RenderedPageImage[] = [];
  for (let position = 0; position < selected.length; position += 1) {
    const index = selected[position];
    const geo = pageGeometry[index];
    if (!geo) continue;

    let background: HTMLCanvasElement | null = null;
    if (settings.includeOriginalContent && input.renderOriginalPage) {
      background = await input.renderOriginalPage(index, scale, transparent);
    }

    const canvas = await renderPageCanvas({
      pageIndex: index,
      scale,
      geometry: geo,
      objects: settings.includeAnnotations ? objects : [],
      backgroundCanvas: background,
      transparent,
      whiteBackground: mime === 'image/jpeg',
    });

    const blob = await canvasToBlob(canvas, mime, settings.quality);
    pages.push({ index, canvas, blob, width: canvas.width, height: canvas.height });
    progress(0.1 + (0.8 * (position + 1)) / Math.max(1, selected.length), 'Отрисовка страниц');
  }

  const fileName = buildExportFileName(
    settings,
    extensionFor(settings.format),
    selected.length === 1 && !settings.zip ? { pageLabel: pageFileLabel(selected[0], pageGeometry.length) } : {},
  );

  return { pages, warnings, fileName };
}

/** Склейка страниц в одно вертикальное изображение. */
export function composeVerticalImage(
  pages: readonly RenderedPageImage[],
  options: { gap?: number; background?: string; transparent?: boolean } = {},
): HTMLCanvasElement {
  const { gap = 16, background = '#ffffff', transparent = false } = options;
  const width = pages.reduce((max, page) => Math.max(max, page.width), 1);
  const height = pages.reduce((sum, page) => sum + page.height, 0) + gap * Math.max(0, pages.length - 1);
  const canvas = createCanvas(width, height);
  const ctx = getContext2d(canvas);
  if (!transparent) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  let cursor = 0;
  for (const page of pages) {
    ctx.drawImage(page.canvas, Math.round((width - page.width) / 2), cursor);
    cursor += page.height + gap;
  }
  return canvas;
}

/** Экспорт страниц в изображения (один файл или ZIP-архив). */
export async function exportPagesToImages(input: ImageExportInput): Promise<ExportResult> {
  const { settings } = input;
  const mime = imageMimeFor(settings.format);
  const ext = extensionFor(settings.format);
  try {
    const { pages, warnings, fileName } = await renderPagesImageList(input);

    if (pages.length === 0) {
      return {
        ok: false,
        fileName,
        size: 0,
        blob: new Blob([], { type: mime }),
        warnings,
        error: 'Не удалось отрисовать ни одной страницы',
      };
    }

    // Одно длинное изображение со всеми страницами.
    if (settings.singleImage && pages.length > 1) {
      const canvas = composeVerticalImage(pages, {
        transparent: settings.transparentBackground && mime !== 'image/jpeg',
      });
      const blob = await canvasToBlob(canvas, mime, settings.quality);
      const name = buildExportFileName(settings, ext, { pageLabel: 'all' });
      return { ok: true, fileName: name, size: blob.size, blob, warnings };
    }

    // Одна страница — отдаём файл напрямую.
    if (pages.length === 1) {
      return {
        ok: true,
        fileName,
        size: pages[0].blob.size,
        blob: pages[0].blob,
        warnings,
      };
    }

    // Несколько страниц — всегда ZIP: браузер не даст скачать 10 файлов подряд.
    if (!settings.zip) {
      warnings.push('Для нескольких страниц файлы упакованы в ZIP-архив (так надёжнее для браузера).');
    }
    const zip = new JSZip();
    for (const page of pages) {
      zip.file(`${pageFileLabel(page.index, input.pageGeometry.length)}.${ext}`, page.blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const zipName = buildExportFileName(settings, 'zip', {
      pageLabel: `${pages.length}-pages`,
    });
    return { ok: true, fileName: zipName, size: zipBlob.size, blob: zipBlob, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      fileName: buildExportFileName(settings, ext),
      size: 0,
      blob: new Blob([], { type: mime }),
      warnings: [],
      error: message,
    };
  }
}

/** Описание выбранных страниц (для интерфейса). */
export function describeImageExport(settings: ExportSettings, totalPages: number): string {
  const selected = resolveSelectedPages(settings, totalPages);
  return describeSelectedPages(selected, totalPages);
}

/* ==========================================================================
 *  Превью шаблонов (штампы, подписи, рисунки)
 * ========================================================================== */

/** Превью штампа/печати в PNG (прозрачный фон). */
export async function renderStampPreview(
  template: StampTemplate,
  pixelRatio = 2,
): Promise<string> {
  const width = Math.max(8, template.width);
  const height = Math.max(8, template.height);
  const canvas = createCanvas(width * pixelRatio, height * pixelRatio);
  const ctx = getContext2d(canvas);
  const layout = computeStampLayout(template, resolveFamily);
  let logoImage: HTMLImageElement | null = null;
  if (template.logo?.src) {
    try {
      logoImage = await loadImage(template.logo.src);
    } catch {
      logoImage = null;
    }
  }
  ctx.save();
  ctx.scale(pixelRatio, pixelRatio);
  paintStampLayout(ctx, layout, { logoImage });
  ctx.restore();
  return canvas.toDataURL('image/png');
}

/** Превью подписи/рисунка в PNG (прозрачный фон). */
export function renderStrokesPreview(
  strokes: SignatureTemplate['strokes'] | DrawingTemplate['strokes'],
  designWidth: number,
  designHeight: number,
  pixelRatio = 2,
): string {
  const width = Math.max(8, designWidth);
  const height = Math.max(8, designHeight);
  const canvas = createCanvas(width * pixelRatio, height * pixelRatio);
  const ctx = getContext2d(canvas);
  ctx.save();
  ctx.scale(pixelRatio, pixelRatio);
  paintStrokes(ctx, strokes);
  ctx.restore();
  return canvas.toDataURL('image/png');
}

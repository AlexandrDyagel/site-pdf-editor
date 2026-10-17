/**
 * ============================================================================
 *  Сервис работы с PDF (pdf.js).
 * ============================================================================
 *
 *  Отвечает за:
 *   - загрузку документа (в том числе защищённого паролем);
 *   - чтение метаданных в Unicode;
 *   - рендер страниц в canvas с произвольным масштабом (для зума и экспорта);
 *   - извлечение текстового слоя (для режима «корректурного слоя»);
 *   - миниатюры страниц;
 *   - определение геометрии страниц с учётом /Rotate.
 */

import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
// Воркер подключается как отдельный файл — тяжёлый парсинг не блокирует UI.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { LIMITS } from '@/constants';
import type { PdfMetadata, PdfPageState } from '@/types';
import { getDisplaySize, type PageGeometry } from '@/utils/coordinates';
import { describePdfError, detectPdfEncryption, isPasswordError } from '@/utils/pdf';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Базовый URL статических ресурсов pdf.js (cmaps и стандартные шрифты). */
function assetBase(): string {
  const base = import.meta.env.BASE_URL || '/';
  return base.endsWith('/') ? base : `${base}/`;
}

/** Параметры рендера страницы. */
export interface RenderPageOptions {
  /** Масштаб (1 = 72 dpi). */
  scale?: number;
  /** Дополнительный поворот поверх /Rotate. */
  rotation?: number;
  /** Готовый canvas (иначе будет создан новый). */
  canvas?: HTMLCanvasElement;
  /** 'transparent' или CSS-цвет фона. */
  background?: string;
  /** Защита от гигантских полотен (пикселей). */
  maxPixels?: number;
}

/** Результат рендера страницы. */
export interface RenderedPage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  scale: number;
}

/** Результат загрузки документа. */
export interface PdfLoadResult {
  numPages: number;
  fingerprint: string | null;
  metadata: PdfMetadata;
  pages: PdfPageState[];
  isEncrypted: boolean;
  isRestricted: boolean;
  needsPassword: boolean;
}

/** Блок текста из текстового слоя (в координатах редактора). */
export interface PdfTextBlock {
  id: string;
  text: string;
  /** Левый верхний угол, pt. */
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
  /** Базовая линия, pt от верха страницы. */
  baseline: number;
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
}

export class PdfService {
  private doc: PDFDocumentProxy | null = null;
  private bytes: Uint8Array | null = null;
  private password: string | undefined;
  private fileName = '';
  private geometry = new Map<number, PageGeometry>();
  private textCache = new Map<number, PdfTextBlock[]>();
  private renderCache = new Map<string, HTMLCanvasElement>();
  private renderCacheLimit: number = LIMITS.pageCache;

  /** Текущий документ pdf.js. */
  getDocument(): PDFDocumentProxy | null {
    return this.doc;
  }

  /** Оригинальные байты файла (для pdf-lib при экспорте). */
  getOriginalBytes(): Uint8Array | null {
    return this.bytes ? new Uint8Array(this.bytes) : null;
  }

  /** Имя исходного файла. */
  getFileName(): string {
    return this.fileName;
  }

  /** Задан ли пароль. */
  getPassword(): string | undefined {
    return this.password;
  }

  /** Ограничение кэша отрендеренных страниц. */
  setCacheLimit(limit: number): void {
    this.renderCacheLimit = Math.max(1, Math.floor(limit));
    this.trimCache();
  }

  /**
   * Загрузка PDF из байтов.
   * Бросает ошибку с понятным русским текстом при повреждённом файле.
   */
  async load(
    data: ArrayBuffer | Uint8Array,
    options: { password?: string; fileName?: string } = {},
  ): Promise<PdfLoadResult> {
    await this.destroy();
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.bytes = bytes;
    this.password = options.password;
    this.fileName = options.fileName ?? 'document.pdf';
    this.geometry.clear();
    this.textCache.clear();
    this.renderCache.clear();

    const encrypted = detectEncryption(bytes);

    const loadingTask = pdfjs.getDocument({
      data: bytes.slice(0),
      password: options.password,
      cMapUrl: `${assetBase()}pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assetBase()}pdfjs/standard_fonts/`,
      // Безопасность: не выполняем встроенный JS и не тянем внешние шрифты.
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: false,
    });

    try {
      this.doc = await loadingTask.promise;
    } catch (error) {
      if (isPasswordError(error)) {
        await loadingTask.destroy().catch(() => undefined);
        return {
          numPages: 0,
          fingerprint: null,
          metadata: emptyMetadata(),
          pages: [],
          isEncrypted: true,
          isRestricted: false,
          needsPassword: true,
        };
      }
      throw new Error(describePdfError(error));
    }

    const doc = this.doc;
    const metadata = await this.readMetadata(doc);
    const pages: PdfPageState[] = [];
    for (let index = 0; index < doc.numPages; index += 1) {
      const page = await doc.getPage(index + 1);
      const unrotated = page.getViewport({ scale: 1, rotation: 0 });
      const rotation = ((page.rotate % 360) + 360) % 360;
      const { width, height } = getDisplaySize(unrotated.width, unrotated.height, rotation);
      // MediaBox может быть смещён относительно (0,0) — учитываем это,
      // чтобы координаты объектов совпадали с реальным положением на странице.
      const viewBox = unrotated.viewBox;
      this.geometry.set(index, {
        width: unrotated.width,
        height: unrotated.height,
        rotation,
        originX: viewBox?.[0] ?? 0,
        originY: viewBox?.[1] ?? 0,
      });
      pages.push({
        index,
        width: unrotated.width,
        height: unrotated.height,
        rotation,
        displayWidth: width,
        displayHeight: height,
        status: 'idle',
        thumbnail: null,
        thumbnailStatus: 'idle',
        hasTextLayer: false,
        error: null,
        renderScale: 1,
      });
    }

    return {
      numPages: doc.numPages,
      fingerprint: Array.isArray(doc.fingerprints) ? doc.fingerprints[0] ?? null : null,
      metadata,
      pages,
      isEncrypted: encrypted,
      isRestricted: encrypted,
      needsPassword: false,
    };
  }

  /** Чтение метаданных в Unicode. */
  private async readMetadata(doc: PDFDocumentProxy): Promise<PdfMetadata> {
    try {
      const { info } = await doc.getMetadata();
      const record = (info ?? {}) as Record<string, unknown>;
      const str = (value: unknown): string => (typeof value === 'string' ? value : '');
      return {
        title: str(record.Title),
        author: str(record.Author),
        subject: str(record.Subject),
        keywords: str(record.Keywords),
        creator: str(record.Creator),
        producer: str(record.Producer),
      };
    } catch {
      return emptyMetadata();
    }
  }

  /** Геометрия страницы. */
  getPageGeometry(index: number): PageGeometry {
    const cached = this.geometry.get(index);
    if (cached) return cached;
    throw new Error(`Страница ${index + 1} не найдена`);
  }

  /** Все размеры страниц (для экспорта). */
  getAllGeometry(): PageGeometry[] {
    return Array.from(this.geometry.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value);
  }

  private async getPage(index: number): Promise<PDFPageProxy> {
    if (!this.doc) throw new Error('Документ не загружен');
    return this.doc.getPage(index + 1);
  }

  /**
   * Кэш отрендеренных страниц: ключ «страница@масштаб@фон@поворот».
   * Поворот обязан быть частью ключа: иначе после поворота страницы из кэша
   * возвращался бы старый растр в прежней ориентации, и содержимое страницы
   * выглядело бы растянутым.
   */
  private cacheKey(
    index: number,
    scale: number,
    background: string,
    rotation: number,
  ): string {
    const normalized = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
    return `${index}@${scale.toFixed(3)}@${background}@${normalized}`;
  }

  private trimCache(): void {
    while (this.renderCache.size > this.renderCacheLimit) {
      const firstKey = this.renderCache.keys().next().value;
      if (firstKey === undefined) break;
      this.renderCache.delete(firstKey);
    }
  }

  /** Отрисовка страницы в canvas. */
  async renderPage(index: number, options: RenderPageOptions = {}): Promise<RenderedPage> {
    const {
      scale: requestedScale = 1.5,
      rotation,
      canvas: providedCanvas,
      background = '#ffffff',
      maxPixels = 32_000_000,
    } = options;

    const page = await this.getPage(index);
    const viewport = page.getViewport({
      scale: requestedScale,
      rotation: rotation === undefined ? undefined : (page.rotate + rotation) % 360,
    });

    let scale = requestedScale;
    if (viewport.width * viewport.height > maxPixels) {
      scale = requestedScale * Math.sqrt(maxPixels / (viewport.width * viewport.height));
    }
    const finalViewport =
      scale === requestedScale
        ? viewport
        : page.getViewport({
            scale,
            rotation: rotation === undefined ? undefined : (page.rotate + rotation) % 360,
          });

    const canvas = providedCanvas ?? document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(finalViewport.width));
    canvas.height = Math.max(1, Math.floor(finalViewport.height));
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Браузер не поддерживает Canvas 2D');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (background !== 'transparent') {
      ctx.save();
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    await page.render({
      canvasContext: ctx,
      viewport: finalViewport,
      background: background === 'transparent' ? 'rgba(0,0,0,0)' : background,
    }).promise;

    return { canvas, width: canvas.width, height: canvas.height, scale };
  }

  /** Отрисовка страницы с кэшированием (для предпросмотра). */
  async renderPageCached(index: number, options: RenderPageOptions = {}): Promise<RenderedPage> {
    const scale = options.scale ?? 1.5;
    const background = options.background ?? '#ffffff';
    const rotation = options.rotation ?? 0;
    const key = this.cacheKey(index, scale, background, rotation);
    const cached = this.renderCache.get(key);
    if (cached && !options.canvas) {
      return { canvas: cached, width: cached.width, height: cached.height, scale };
    }
    const rendered = await this.renderPage(index, options);
    if (!options.canvas) {
      this.renderCache.delete(key);
      this.renderCache.set(key, rendered.canvas);
      this.trimCache();
    }
    return rendered;
  }

  /**
   * Миниатюра страницы (JPEG data:URL).
   * `extraRotation` — поворот, добавленный пользователем в редакторе.
   */
  async renderThumbnail(
    index: number,
    maxWidth = 150,
    maxHeight = 210,
    extraRotation = 0,
  ): Promise<string> {
    const page = await this.getPage(index);
    const base = page.getViewport({ scale: 1, rotation: (page.rotate + extraRotation) % 360 });
    const scale = Math.min(maxWidth / base.width, maxHeight / base.height, 1) || 0.2;
    const { canvas } = await this.renderPage(index, { scale, rotation: extraRotation });
    const thumb = document.createElement('canvas');
    const ctx = thumb.getContext('2d');
    if (!ctx) return '';
    thumb.width = canvas.width;
    thumb.height = canvas.height;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, thumb.width, thumb.height);
    ctx.drawImage(canvas, 0, 0);
    return thumb.toDataURL('image/jpeg', 0.8);
  }

  /**
   * Отрисовка первой страницы произвольного PDF из памяти.
   *
   * Нужна, чтобы проверить результат встраивания шрифта (подмножество против
   * полного встраивания) ещё до первого экспорта: документ создаётся временно
   * и сразу закрывается, открытый файл пользователя не затрагивается.
   */
  async renderBytesToCanvas(
    bytes: Uint8Array,
    scale = 2,
    maxPixels = 4_000_000,
  ): Promise<HTMLCanvasElement> {
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      cMapUrl: `${assetBase()}pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assetBase()}pdfjs/standard_fonts/`,
    });
    const doc = await task.promise;
    try {
      const page = await doc.getPage(1);
      let viewport = page.getViewport({ scale });
      if (viewport.width * viewport.height > maxPixels) {
        viewport = page.getViewport({
          scale: scale * Math.sqrt(maxPixels / (viewport.width * viewport.height)),
        });
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Браузер не поддерживает Canvas 2D');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
      return canvas;
    } finally {
      await doc.destroy();
    }
  }

  /**
   * Извлечение текстового слоя страницы, сгруппированного в блоки.
   * Используется для режима «корректурного слоя»: пользователь может заменить
   * существующий текст — старый закрывается закрашиванием, новый добавляется
   * отдельным текстовым объектом.
   */
  async getTextBlocks(index: number): Promise<PdfTextBlock[]> {
    const cached = this.textCache.get(index);
    if (cached) return cached;
    const page = await this.getPage(index);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = (content.items as unknown[]).filter(
      (item): item is TextItemLike =>
        typeof item === 'object' &&
        item !== null &&
        'str' in item &&
        typeof (item as TextItemLike).str === 'string' &&
        Array.isArray((item as TextItemLike).transform),
    );
    if (items.length === 0) {
      this.textCache.set(index, []);
      return [];
    }

    interface Line {
      parts: { text: string; x: number; y: number; width: number; height: number; fontSize: number; fontName: string }[];
      baseline: number;
    }
    const lines = new Map<number, Line>();
    for (const item of items) {
      if (!item.str) continue;
      const transformed = pdfjs.Util.transform(viewport.transform, item.transform);
      const x = transformed[4];
      const baseline = transformed[5];
      const fontSize = Math.hypot(transformed[2], transformed[3]) || item.height;
      const width = item.width;
      const key = Math.round(baseline / 2) * 2;
      const line: Line = lines.get(key) ?? { parts: [], baseline };
      line.parts.push({
        text: item.str,
        x,
        y: baseline - fontSize * 0.8,
        width,
        height: fontSize,
        fontSize,
        fontName: item.fontName ?? '',
      });
      lines.set(key, line);
    }

    const blocks: PdfTextBlock[] = [];
    for (const [key, line] of lines) {
      const parts = line.parts.sort((a, b) => a.x - b.x);
      let text = '';
      let cursor = 0;
      let minX = Number.POSITIVE_INFINITY;
      let maxX = 0;
      for (const part of parts) {
        if (cursor > 0 && part.x - cursor > part.fontSize * 0.25) text += ' ';
        text += part.text;
        cursor = part.x + part.width;
        minX = Math.min(minX, part.x);
        maxX = Math.max(maxX, cursor);
      }
      const fontSize = Math.max(...parts.map((p) => p.fontSize), 8);
      blocks.push({
        id: `t${key}`,
        text: text.trim(),
        x: minX,
        y: Math.max(0, line.baseline - fontSize * 0.82),
        width: Math.max(4, maxX - minX),
        height: fontSize * 1.05,
        fontSize,
        baseline: line.baseline,
        fontName: parts[0]?.fontName ?? '',
      });
    }

    const result = blocks
      .filter((block) => block.text.length > 0)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    this.textCache.set(index, result);
    return result;
  }

  /** Требуется ли пароль для документа (проверка по байтам). */
  static isEncryptedBytes(bytes: Uint8Array): boolean {
    return detectEncryption(bytes);
  }

  /** Количество страниц. */
  get numPages(): number {
    return this.doc?.numPages ?? 0;
  }

  /** Освобождение ресурсов документа. */
  async destroy(): Promise<void> {
    this.renderCache.clear();
    this.textCache.clear();
    this.geometry.clear();
    const doc = this.doc;
    this.doc = null;
    if (doc) {
      await doc.destroy().catch(() => undefined);
    }
  }

  /** Полная очистка, включая исходные байты. */
  async reset(): Promise<void> {
    await this.destroy();
    this.bytes = null;
    this.password = undefined;
    this.fileName = '';
  }
}

/** Метаданные по умолчанию. */
function emptyMetadata(): PdfMetadata {
  return { title: '', author: '', subject: '', keywords: '', creator: '', producer: '' };
}

/**
 * Эвристическое определение шифрования PDF (см. `detectPdfEncryption`).
 * Оставлено для обратной совместимости вызовов.
 */
export function detectEncryption(bytes: Uint8Array): boolean {
  return detectPdfEncryption(bytes);
}

/** Единственный экземпляр сервиса PDF. */
export const pdfService = new PdfService();

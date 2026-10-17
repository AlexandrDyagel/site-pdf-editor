/**
 * Работа с изображениями: загрузка, конвертация, кадрирование, превью.
 */

import { canvasToBlob, canvasToDataUrl } from '@/utils/download';
import type { Rect } from '@/utils/geometry';

/** Создаёт canvas нужного размера (с учётом devicePixelRatio при необходимости). */
export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** 2D-контекст с настройками для качественной отрисовки. */
export function getContext2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Браузер не поддерживает Canvas 2D');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Загрузка изображения из URL/data:URL. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Не удалось загрузить изображение'));
    image.src = src;
  });
}

/** SVG → Image (для отрисовки SVG в canvas/PDF). */
export function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  return loadImage(url).finally(() => {
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
}

/** Размеры изображения по data:URL/URL. */
export async function getImageSize(src: string): Promise<{ width: number; height: number }> {
  const image = await loadImage(src);
  return { width: image.naturalWidth, height: image.naturalHeight };
}

/** Чтение файла изображения в data:URL. */
export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    reader.readAsDataURL(file);
  });
}

export interface PreparedImage {
  src: string;
  mimeType: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Изображение было уменьшено при импорте. */
  downscaled: boolean;
}

/**
 * Подготовка изображения к вставке: при необходимости уменьшает слишком
 * большие изображения (экономия памяти) и приводит SVG к PNG.
 */
export async function prepareImageFile(
  file: File | Blob,
  maxDimension = 3000,
): Promise<PreparedImage> {
  const mime = file.type || 'image/png';
  const rawDataUrl = await readFileAsDataUrl(file);

  if (mime.includes('svg')) {
    const svgText = await file.text();
    const image = await loadSvgImage(svgText);
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = createCanvas(image.naturalWidth * scale, image.naturalHeight * scale);
    getContext2d(canvas).drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      src: canvasToDataUrl(canvas, 'image/png'),
      mimeType: 'image/png',
      naturalWidth: canvas.width,
      naturalHeight: canvas.height,
      downscaled: scale < 1,
    };
  }

  const image = await loadImage(rawDataUrl);
  const maxSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (maxSide <= maxDimension) {
    return {
      src: rawDataUrl,
      mimeType: mime,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      downscaled: false,
    };
  }

  const scale = maxDimension / maxSide;
  const canvas = createCanvas(image.naturalWidth * scale, image.naturalHeight * scale);
  getContext2d(canvas).drawImage(image, 0, 0, canvas.width, canvas.height);
  const useJpeg = mime === 'image/jpeg';
  return {
    src: canvasToDataUrl(canvas, useJpeg ? 'image/jpeg' : 'image/png', 0.92),
    mimeType: useJpeg ? 'image/jpeg' : 'image/png',
    naturalWidth: canvas.width,
    naturalHeight: canvas.height,
    downscaled: true,
  };
}

/** Отрисовка изображения в прямоугольник с учётом режима вписывания. */
export function drawImageFit(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  naturalWidth: number,
  naturalHeight: number,
  target: Rect,
  fit: 'contain' | 'cover' | 'fill' = 'contain',
): void {
  if (naturalWidth <= 0 || naturalHeight <= 0) return;
  if (fit === 'fill') {
    ctx.drawImage(image, target.x, target.y, target.width, target.height);
    return;
  }
  const scaleX = target.width / naturalWidth;
  const scaleY = target.height / naturalHeight;
  const scale = fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  const x = target.x + (target.width - width) / 2;
  const y = target.y + (target.height - height) / 2;
  ctx.drawImage(image, x, y, width, height);
}

/**
 * Рендер произвольного Konva-узла в PNG data:URL с прозрачным фоном.
 * Используется для превью штампов и подписей.
 */
export function konvaNodeToDataUrl(
  node: { toDataURL: (config?: Record<string, unknown>) => string },
  pixelRatio = 2,
): string {
  return node.toDataURL({ pixelRatio, mimeType: 'image/png' });
}

/** Изменение размера data:URL изображения. */
export async function resizeDataUrl(
  src: string,
  maxWidth: number,
  maxHeight: number,
  mime: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png',
  quality = 0.92,
): Promise<string> {
  const image = await loadImage(src);
  const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
  if (scale >= 1) return src;
  const canvas = createCanvas(image.naturalWidth * scale, image.naturalHeight * scale);
  const ctx = getContext2d(canvas);
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvasToDataUrl(canvas, mime, quality);
}

/** Создание миниатюры страницы. */
export async function makeThumbnail(
  source: HTMLCanvasElement | HTMLImageElement,
  maxWidth = 160,
  maxHeight = 220,
): Promise<string> {
  const sourceWidth = source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
  const sourceHeight = source instanceof HTMLCanvasElement ? source.height : source.naturalHeight;
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1);
  const canvas = createCanvas(sourceWidth * scale, sourceHeight * scale);
  const ctx = getContext2d(canvas);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvasToDataUrl(canvas, 'image/jpeg', 0.82);
}

/** Скруглённый прямоугольник (путь). */
export function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  ctx.beginPath();
  ctx.moveTo(rect.x + r, rect.y);
  ctx.lineTo(rect.x + rect.width - r, rect.y);
  ctx.quadraticCurveTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + r);
  ctx.lineTo(rect.x + rect.width, rect.y + rect.height - r);
  ctx.quadraticCurveTo(
    rect.x + rect.width,
    rect.y + rect.height,
    rect.x + rect.width - r,
    rect.y + rect.height,
  );
  ctx.lineTo(rect.x + r, rect.y + rect.height);
  ctx.quadraticCurveTo(rect.x, rect.y + rect.height, rect.x, rect.y + rect.height - r);
  ctx.lineTo(rect.x, rect.y + r);
  ctx.quadraticCurveTo(rect.x, rect.y, rect.x + r, rect.y);
  ctx.closePath();
}

/** Обрезка/заполнение прозрачных пикселей (для экспорта JPEG). */
export async function flattenTransparency(src: string, background = '#ffffff'): Promise<string> {
  const image = await loadImage(src);
  const canvas = createCanvas(image.naturalWidth, image.naturalHeight);
  const ctx = getContext2d(canvas);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  return canvasToDataUrl(canvas, 'image/png');
}

/** Проверка, является ли файл изображением. */
export function isImageFile(file: File): boolean {
  return /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name);
}

/** Blob изображения в data:URL (для библиотеки). */
export async function fileToImageDataUrl(file: File): Promise<string> {
  return readFileAsDataUrl(file);
}

/** Извлечь пиксели data:URL в Blob (для встраивания в PDF). */
export async function dataUrlToImageBlob(
  src: string,
  mime: 'image/png' | 'image/jpeg' = 'image/png',
  quality = 0.92,
): Promise<{ blob: Blob; mime: string }> {
  const image = await loadImage(src);
  const canvas = createCanvas(image.naturalWidth, image.naturalHeight);
  const ctx = getContext2d(canvas);
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(image, 0, 0);
  const blob = await canvasToBlob(canvas, mime, quality);
  return { blob, mime };
}

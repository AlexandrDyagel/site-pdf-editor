/**
 * ============================================================================
 *  Фабрика Konva-узлов для объектов редактора.
 * ============================================================================
 *
 *  Один и тот же код создаёт объекты:
 *    - на сцене редактора (с возможностью выделения и трансформации);
 *    - на «невидимой» сцене при растровом экспорте (PNG/JPEG/WebP, плоский PDF,
 *      картинки для DOCX).
 *
 *  Поэтому предпросмотр и растровый экспорт гарантированно совпадают.
 *
 *  Локальная система координат каждого объекта: (0,0) — левый верхний угол,
 *  Y направлен вниз, единицы — PDF points. Позиция, поворот и прозрачность
 *  задаются на группе-обёртке.
 */

import Konva from 'konva';
import type {
  DrawingPayload,
  EditorObject,
  HighlightPayload,
  ImagePayload,
  ShapePayload,
  SignaturePayload,
  StampPayload,
  TextPayload,
  WhiteoutPayload,
} from '@/types';
import { loadImage } from '@/utils/image';
import { hashString } from '@/utils/id';
import { computeStampLayout, fitStampTemplate, paintStampLayout } from '@/services/stampRenderService';
import { getStrokeOutline, paintStrokes } from '@/services/strokeService';
import { ensureTextMetrics, hasTextMetrics, paintTextObject } from '@/services/textRenderService';
import { computeTextBlockLayout } from '@/services/textRenderService';
import { fontService } from '@/services/fontService';

/** Опции сборки узла. */
export interface ObjectBuildOptions {
  /** Вызывается, когда асинхронный ресурс (картинка, шрифт) догрузился. */
  onReady?: () => void;
  /** Список промисов ожидания — используется при растровом экспорте. */
  pending?: Promise<unknown>[];
}

/** Имя атрибута, в котором хранится подпись структуры узла. */
const SIGNATURE_ATTR = 'structureSignature';

const imageCache = new Map<string, HTMLImageElement>();
const pendingImageLoads = new Map<string, Promise<HTMLImageElement>>();
/** Картинки, которые не удалось загрузить (чтобы не пытаться бесконечно). */
const failedImages = new Set<string>();

/**
 * Готовность битмапов объекта.
 *
 * Входит в подпись структуры: когда изображение догрузилось, подпись меняется,
 * узел пересобирается и битмап подставляется. Без этого `Konva.Image`
 * создавался с `image: undefined` и оставался пустым — пользователь видел
 * только рамку выделения вместо картинки.
 */
function resourcesSignature(obj: EditorObject): string {
  const sources: string[] = [];
  if (obj.type === 'image') sources.push(obj.payload.src);
  if (obj.type === 'stamp' && obj.payload.template.logo?.src) {
    sources.push(obj.payload.template.logo.src);
  }
  if (obj.type === 'signature' && obj.payload.png) sources.push(obj.payload.png);
  const list = sources.filter(Boolean);
  if (list.length === 0) return '';
  return list
    .map((src) => {
      if (failedImages.has(src)) return 'fail';
      const cached = imageCache.get(src);
      return cached && cached.complete && cached.naturalWidth > 0 ? 'ok' : 'load';
    })
    .join(',');
}

/** Получение (и при необходимости загрузка) изображения по data:URL. */
export function ensureImage(src: string, options: ObjectBuildOptions = {}): HTMLImageElement | null {
  if (!src) return null;
  const cached = imageCache.get(src);
  if (cached) {
    if (cached.complete && cached.naturalWidth > 0) return cached;
    const pending = pendingImageLoads.get(src);
    if (pending && options.pending) options.pending.push(pending);
    return null;
  }
  const existing = pendingImageLoads.get(src);
  if (existing) {
    options.pending?.push(existing);
    return null;
  }
  const promise = loadImage(src)
    .then((image) => {
      imageCache.set(src, image);
      options.onReady?.();
      return image;
    })
    .catch(() => {
      const empty = new Image();
      imageCache.set(src, empty);
      failedImages.add(src);
      return empty;
    })
    .finally(() => {
      pendingImageLoads.delete(src);
    });
  pendingImageLoads.set(src, promise);
  options.pending?.push(promise);
  return null;
}

/** Предзагрузка набора изображений (для экспорта). */
export async function preloadImages(sources: readonly string[]): Promise<void> {
  await Promise.all(sources.filter(Boolean).map((src) => loadImage(src).catch(() => null)));
}

/** Сырой canvas-контекст внутри Konva sceneFunc. */
function rawContext(context: Konva.Context): CanvasRenderingContext2D {
  return (context as unknown as { _context: CanvasRenderingContext2D })._context;
}

/** Резолвер семейства шрифта по fontId. */
export function resolveFamily(fontId?: string): string {
  return fontService.getCyrillicFont(fontId)?.family ?? 'PT Sans';
}

/* ==========================================================================
 *  Подписи структуры: понять, нужно ли пересобирать дочерние узлы
 * ========================================================================== */

/** Короткая подпись содержимого объекта (без координат и трансформаций). */
export function objectStructureSignature(obj: EditorObject): string {
  const base = `${obj.type}|${obj.width.toFixed(2)}|${obj.height.toFixed(2)}`;
  let body = '';
  switch (obj.type) {
    case 'text': {
      const p = obj.payload;
      body = [
        p.text,
        p.fontId,
        p.fontSize,
        p.bold,
        p.italic,
        p.underline,
        p.align,
        p.verticalAlign,
        p.lineHeight,
        p.letterSpacing,
        p.padding,
        p.color,
        p.backgroundColor,
        p.backgroundOpacity,
        p.borderColor,
        p.borderWidth,
        p.shadow,
        p.autoHeight,
      ].join('|');
      break;
    }
    case 'image': {
      const p = obj.payload;
      body = `${hashString(p.src)}|${p.fit}|${p.cornerRadius}|${p.borderColor}|${p.borderWidth}|${p.naturalWidth}x${p.naturalHeight}`;
      break;
    }
    case 'shape': {
      const p = obj.payload;
      body = `${p.kind}|${p.stroke}|${p.strokeWidth}|${p.fill}|${p.dash.join(',')}|${p.cornerRadius}|${p.arrowHead}|${p.points.join(',')}`;
      break;
    }
    case 'whiteout': {
      body = obj.payload.color;
      break;
    }
    case 'highlight': {
      body = `${obj.payload.color}|${obj.payload.blend}`;
      break;
    }
    case 'drawing':
    case 'signature': {
      const p = obj.payload as DrawingPayload | SignaturePayload;
      const points = p.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
      // Точки не сериализуем: подпись строится по количеству и последней точке.
      const last = p.strokes[p.strokes.length - 1];
      const lastPoint = last?.points[last.points.length - 1];
      body = `${p.strokes.length}|${points}|${p.designWidth.toFixed(1)}|${p.designHeight.toFixed(1)}|${
        lastPoint ? `${lastPoint.x.toFixed(1)},${lastPoint.y.toFixed(1)}` : ''
      }|${(p as SignaturePayload).color ?? ''}`;
      break;
    }
    case 'stamp': {
      const p = obj.payload;
      body = `${hashString(JSON.stringify({ ...p.template, preview: null }))}|${
        p.overrides.textOverride ?? ''
      }|${p.overrides.color ?? ''}|${p.overrides.opacity ?? 1}`;
      break;
    }
    default:
      body = '';
      break;
  }
  return `${base}|${body}`;
}

/* ==========================================================================
 *  Сборка дочерних узлов
 * ========================================================================== */

/** Прямоугольник попадания (для выделения объектов нестандартной формы). */
function rectHitFunc(context: Konva.Context, shape: Konva.Shape): void {
  context.beginPath();
  context.rect(0, 0, shape.width(), shape.height());
  context.closePath();
  context.fillStrokeShape(shape);
}

/** Расчёт прямоугольника изображения с учётом режима вписывания. */
function imageLayout(
  payload: ImagePayload,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number; crop?: { x: number; y: number; width: number; height: number } } {
  const naturalWidth = payload.naturalWidth || width;
  const naturalHeight = payload.naturalHeight || height;
  if (payload.fit === 'fill') return { x: 0, y: 0, width, height };
  const scaleX = width / naturalWidth;
  const scaleY = height / naturalHeight;
  const scale = payload.fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  if (payload.fit === 'cover') {
    const cropWidth = width / scale;
    const cropHeight = height / scale;
    return {
      x: 0,
      y: 0,
      width,
      height,
      crop: {
        x: Math.max(0, (naturalWidth - cropWidth) / 2),
        y: Math.max(0, (naturalHeight - cropHeight) / 2),
        width: cropWidth,
        height: cropHeight,
      },
    };
  }
  const drawWidth = naturalWidth * scale;
  const drawHeight = naturalHeight * scale;
  return {
    x: (width - drawWidth) / 2,
    y: (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  };
}

/** Пересборка содержимого группы под конкретный объект. */
function buildChildren(group: Konva.Group, obj: EditorObject, options: ObjectBuildOptions): void {
  switch (obj.type) {
    case 'text': {
      const payload = obj.payload as TextPayload;
      // Для текста с автовысотой фактическая высота вычисляется по содержимому —
      // именно она используется и для отрисовки, и для рамки выделения.
      const layout = computeTextBlockLayout(payload, obj.width, obj.height);
      const shape = new Konva.Shape({
        width: obj.width,
        height: layout.boxHeight,
        sceneFunc: (context, node) => {
          paintTextObject(rawContext(context), payload, node.width(), node.height());
        },
        hitFunc: rectHitFunc,
      });
      group.add(shape);
      if (!hasTextMetrics(payload.fontId, payload.bold, payload.italic)) {
        const promise = ensureTextMetrics(payload).then(() => options.onReady?.());
        options.pending?.push(promise);
      }
      break;
    }

    case 'image': {
      const payload = obj.payload as ImagePayload;
      const image = ensureImage(payload.src, options);
      const layout = imageLayout(payload, obj.width, obj.height);
      const node = new Konva.Image({
        image: image ?? undefined,
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: layout.height,
        cornerRadius: payload.cornerRadius,
        crop: layout.crop,
        // Узел должен участвовать в hit-тесте, иначе изображение нельзя
        // выбрать и перетащить (группа-обёртка ловит события только через детей).
        listening: true,
      });
      group.add(node);
      if (payload.borderColor && payload.borderWidth > 0) {
        group.add(
          new Konva.Rect({
            x: 0,
            y: 0,
            width: obj.width,
            height: obj.height,
            stroke: payload.borderColor,
            strokeWidth: payload.borderWidth,
            cornerRadius: payload.cornerRadius,
            listening: false,
          }),
        );
      }
      break;
    }

    case 'shape': {
      const payload = obj.payload as ShapePayload;
      const dash = payload.dash.length > 0 ? payload.dash : undefined;
      // Нулевая толщина или «без цвета» — обводки нет. Минимум не подставляем:
      // иначе при толщине 0 оставалась тонкая линия «по умолчанию».
      const strokeWidth = Math.max(0, payload.strokeWidth);
      const strokeColor = payload.stroke ?? null;
      const stroke = strokeColor !== null && strokeWidth > 0 ? strokeColor : undefined;
      const effectiveWidth = stroke ? strokeWidth : 0;
      const fill = payload.fill ?? undefined;

      if (payload.kind === 'rect') {
        group.add(
          new Konva.Rect({
            x: 0,
            y: 0,
            width: obj.width,
            height: obj.height,
            fill,
            stroke,
            strokeWidth,
            dash,
            cornerRadius: payload.cornerRadius,
          }),
        );
      } else if (payload.kind === 'ellipse') {
        group.add(
          new Konva.Ellipse({
            x: obj.width / 2,
            y: obj.height / 2,
            radiusX: Math.max(0.5, obj.width / 2),
            radiusY: Math.max(0.5, obj.height / 2),
            fill,
            stroke,
            strokeWidth,
            dash,
          }),
        );
      } else {
        const [nx1, ny1, nx2, ny2] = payload.points;
        const points = [nx1 * obj.width, ny1 * obj.height, nx2 * obj.width, ny2 * obj.height];
        if (payload.kind === 'arrow') {
          // Наконечники: 'none' — просто линия, 'end' — на конце,
          // 'both' — с двух сторон. Konva умеет оба наконечника.
          const arrowHead = payload.arrowHead ?? 'end';
          group.add(
            new Konva.Arrow({
              points,
              stroke,
              fill: stroke,
              strokeWidth: effectiveWidth,
              dash,
              pointerAtBeginning: arrowHead === 'both',
              pointerAtEnding: arrowHead !== 'none',
              pointerLength: Math.max(6, strokeWidth * 3.4),
              pointerWidth: Math.max(5, strokeWidth * 2.6),
              lineCap: 'round',
            }),
          );
        } else {
          group.add(
            new Konva.Line({
              points,
              stroke,
              strokeWidth: effectiveWidth,
              dash,
              lineCap: 'round',
              hitStrokeWidth: 14,
            }),
          );
        }
      }
      break;
    }

    case 'whiteout': {
      const payload = obj.payload as WhiteoutPayload;
      group.add(
        new Konva.Rect({
          x: 0,
          y: 0,
          width: obj.width,
          height: obj.height,
          fill: payload.color || '#ffffff',
        }),
      );
      break;
    }

    case 'highlight': {
      const payload = obj.payload as HighlightPayload;
      group.add(
        new Konva.Rect({
          x: 0,
          y: 0,
          width: obj.width,
          height: obj.height,
          fill: payload.color || '#facc15',
          opacity: 0.4,
        }),
      );
      break;
    }

    case 'drawing':
    case 'signature': {
      const payload = obj.payload as DrawingPayload | SignaturePayload;
      const designWidth = payload.designWidth > 0 ? payload.designWidth : obj.width;
      const designHeight = payload.designHeight > 0 ? payload.designHeight : obj.height;
      const shape = new Konva.Shape({
        width: obj.width,
        height: obj.height,
        sceneFunc: (context, node) => {
          const raw = rawContext(context);
          const scaleX = node.width() / (designWidth || node.width() || 1);
          const scaleY = node.height() / (designHeight || node.height() || 1);
          raw.save();
          raw.scale(scaleX, scaleY);
          paintStrokes(raw, payload.strokes);
          raw.restore();
        },
        hitFunc: rectHitFunc,
      });
      group.add(shape);
      break;
    }

    case 'stamp': {
      const payload = obj.payload as StampPayload;
      const shape = new Konva.Shape({
        width: obj.width,
        height: obj.height,
        sceneFunc: (context, node) => {
          const raw = rawContext(context);
          const template = fitStampTemplate(payload.template, node.width(), node.height());
          const layout = computeStampLayout(template, resolveFamily, {
            textOverride: payload.overrides.textOverride ?? null,
            colorOverride: payload.overrides.color ?? null,
          });
          const logoImage = template.logo?.src ? ensureImage(template.logo.src, options) : null;
          paintStampLayout(raw, layout, {
            logoImage,
            alpha: payload.overrides.opacity ?? 1,
          });
        },
        hitFunc: rectHitFunc,
      });
      group.add(shape);
      break;
    }

    default:
      break;
  }
}

/* ==========================================================================
 *  Публичный API
 * ========================================================================== */

/** Создание узла объекта. */
export function createObjectNode(obj: EditorObject, options: ObjectBuildOptions = {}): Konva.Group {
  const group = new Konva.Group({ name: 'editor-object' });
  group.setAttr('objectId', obj.id);
  syncObjectNode(group, obj, options);
  return group;
}

/** Синхронизация узла с данными объекта. */
export function syncObjectNode(
  group: Konva.Group,
  obj: EditorObject,
  options: ObjectBuildOptions = {},
): void {
  group.setAttrs({
    x: obj.x,
    y: obj.y,
    rotation: obj.rotation,
    opacity: obj.opacity,
    visible: obj.visible,
    listening: obj.visible && !obj.locked,
  });
  group.setAttr('objectId', obj.id);
  group.setAttr('objectLocked', obj.locked);

  const signature = `${objectStructureSignature(obj)}|${resourcesSignature(obj)}`;
  if (group.getAttr(SIGNATURE_ATTR) !== signature) {
    group.destroyChildren();
    buildChildren(group, obj, options);
    group.setAttr(SIGNATURE_ATTR, signature);
  }
  group.getLayer()?.batchDraw();
}

/** Обход всех узлов сцены для быстрого поиска по id объекта. */
export function findNodeByObjectId(root: Konva.Container, objectId: string): Konva.Group | null {
  const nodes = root.find('.editor-object');
  for (const node of nodes) {
    if (node.getAttr('objectId') === objectId && node instanceof Konva.Group) return node;
  }
  return null;
}

/** Сброс кэша изображений (при закрытии документа). */
export function clearImageCache(): void {
  imageCache.clear();
  pendingImageLoads.clear();
  failedImages.clear();
}

/** Предзагрузка ресурсов всех объектов страницы (нужно для экспорта). */
export function collectImageSources(objects: readonly EditorObject[]): string[] {
  const sources: string[] = [];
  for (const obj of objects) {
    if (!obj.visible) continue;
    if (obj.type === 'image') sources.push(obj.payload.src);
    if (obj.type === 'stamp' && obj.payload.template.logo?.src) {
      sources.push(obj.payload.template.logo.src);
    }
    if (obj.type === 'signature' && obj.payload.png) sources.push(obj.payload.png);
  }
  return sources.filter(Boolean);
}

/** Экспорт вспомогательной функции для тестов: контур штриха. */
export { getStrokeOutline };

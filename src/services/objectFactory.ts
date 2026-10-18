/**
 * ============================================================================
 *  Фабрика объектов редактора.
 * ============================================================================
 *
 *  Единая точка создания объектов: используется инструментами редактора,
 *  дублированием, вставкой из буфера, импортом проекта и библиотеками.
 *  Благодаря этому структура данных всегда одинаковая (и корректно
 *  сериализуется в JSON-проект).
 */

import type {
  ArrowHead,
  DrawingPayload,
  DrawingObject,
  EditorObject,
  HighlightObject,
  ImageObject,
  ObjectPayload,
  ShapeKind,
  ShapeObject,
  ShiftObjectType,
  SignatureObject,
  StampObject,
  StampTemplate,
  StrokeData,
  TextAlign,
  TextObject,
  WhiteoutObject,
} from '@/types';
import { createId } from '@/utils/id';
import { normalizeStrokePoints } from '@/services/strokeService';
import { cloneStampTemplate } from '@/services/stampRenderService';
import { round2 } from '@/utils/geometry';

/** Базовые параметры создания объекта. */
export interface BaseCreateOptions {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number;
  rotation?: number;
  opacity?: number;
  name?: string;
}

/** Настройки текста по умолчанию (берутся из настроек приложения). */
export interface TextDefaults {
  fontId: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  bold?: boolean;
  italic?: boolean;
  align?: TextAlign;
  lineHeight?: number;
  letterSpacing?: number;
}

/** Настройки фигур по умолчанию. */
export interface ShapeDefaults {
  /** Цвет обводки; null — «без цвета». */
  stroke: string | null;
  strokeWidth: number;
  fill?: string | null;
}

/** Настройки рукописных штрихов по умолчанию. */
export interface StrokeDefaults {
  color: string;
  width: number;
  opacity: number;
}

/** Общие поля объекта. */
function baseFields(options: BaseCreateOptions): {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  zIndex: number;
  name?: string;
  createdAt: string;
  updatedAt: string;
} {
  const now = new Date().toISOString();
  return {
    id: createId('obj'),
    page: options.page,
    x: round2(options.x),
    y: round2(options.y),
    width: round2(Math.max(1, options.width)),
    height: round2(Math.max(1, options.height)),
    rotation: options.rotation ?? 0,
    opacity: options.opacity ?? 1,
    visible: true,
    locked: false,
    zIndex: options.zIndex ?? 1,
    name: options.name,
    createdAt: now,
    updatedAt: now,
  };
}

/** Текстовый объект. */
export function createTextObject(
  options: BaseCreateOptions & { text: string; defaults: TextDefaults; autoHeight?: boolean },
): TextObject {
  const { defaults } = options;
  return {
    ...baseFields(options),
    type: 'text',
    payload: {
      text: options.text,
      fontId: defaults.fontId,
      fontFamily: defaults.fontFamily,
      fontSize: defaults.fontSize,
      color: defaults.color,
      bold: defaults.bold ?? false,
      italic: defaults.italic ?? false,
      underline: false,
      align: defaults.align ?? 'left',
      verticalAlign: 'top',
      lineHeight: defaults.lineHeight ?? 1.25,
      letterSpacing: defaults.letterSpacing ?? 0,
      padding: 2,
      autoHeight: options.autoHeight ?? true,
      backgroundColor: null,
      backgroundOpacity: 0.85,
      borderColor: null,
      borderWidth: 0,
      strokeColor: null,
      strokeWidth: 0,
      shadow: false,
    },
  };
}

/** Объект-изображение. */
export function createImageObject(
  options: BaseCreateOptions & {
    src: string;
    mimeType: string;
    naturalWidth: number;
    naturalHeight: number;
    alt?: string;
  },
): ImageObject {
  return {
    ...baseFields(options),
    type: 'image',
    payload: {
      src: options.src,
      mimeType: options.mimeType,
      naturalWidth: options.naturalWidth,
      naturalHeight: options.naturalHeight,
      fit: 'contain',
      cornerRadius: 0,
      borderColor: null,
      borderWidth: 0,
      alt: options.alt,
    },
  };
}

/** Фигура. */
export function createShapeObject(
  kind: ShapeKind,
  options: BaseCreateOptions & {
    defaults: ShapeDefaults;
    arrowHead?: ArrowHead;
    dash?: number[];
    cornerRadius?: number;
    points?: [number, number, number, number];
  },
): ShapeObject {
  return {
    ...baseFields(options),
    type: 'shape',
    payload: {
      kind,
      stroke: options.defaults.stroke,
      strokeWidth: options.defaults.strokeWidth,
      fill: options.defaults.fill ?? null,
      dash: options.dash ?? [],
      cornerRadius: options.cornerRadius ?? 0,
      arrowHead: options.arrowHead ?? (kind === 'arrow' ? 'end' : 'none'),
      points: options.points ?? [0, 0, 1, 1],
    },
  };
}

/**
 * Рукописный рисунок.
 * Точки переводятся в локальную систему объекта, поэтому объект можно
 * свободно перемещать и масштабировать без потери качества (векторно).
 */
export function createDrawingObject(
  strokes: readonly StrokeData[],
  options: {
    page: number;
    zIndex?: number;
    name?: string;
    /** Если true — «стирание»: штрихи закрашивают область цветом фона. */
    eraser?: boolean;
  },
): DrawingObject | null {
  const allPoints = strokes.flatMap((stroke) => stroke.points);
  if (allPoints.length === 0) return null;
  const normalized = normalizeStrokePoints(allPoints);
  const offsetX = Math.min(...strokes.flatMap((stroke) => stroke.points.map((p) => p.x)));
  const offsetY = Math.min(...strokes.flatMap((stroke) => stroke.points.map((p) => p.y)));

  const payload: DrawingPayload = {
    strokes: strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ ...point, x: point.x - offsetX, y: point.y - offsetY })),
    })),
    designWidth: Math.max(1, normalized.width),
    designHeight: Math.max(1, normalized.height),
    erasable: Boolean(options.eraser),
  };

  return {
    ...baseFields({
      page: options.page,
      x: offsetX,
      y: offsetY,
      width: payload.designWidth,
      height: payload.designHeight,
      zIndex: options.zIndex ?? 1,
      name: options.name,
      // Небольшой запас, чтобы сглаженные края не обрезались.
      opacity: 1,
    }),
    type: 'drawing',
    payload,
  };
}

/** Подпись. */
export function createSignatureObject(
  options: BaseCreateOptions & {
    strokes: StrokeData[];
    color: string;
    strokeWidth: number;
    svg?: string | null;
    png?: string | null;
    modelId?: string | null;
    source?: 'draw' | 'library' | 'image';
  },
): SignatureObject {
  const designWidth = Math.max(1, options.width);
  const designHeight = Math.max(1, options.height);
  return {
    ...baseFields(options),
    type: 'signature',
    payload: {
      strokes: options.strokes,
      designWidth,
      designHeight,
      color: options.color,
      strokeWidth: options.strokeWidth,
      svg: options.svg ?? null,
      png: options.png ?? null,
      source: options.source ?? 'library',
      modelId: options.modelId ?? null,
    },
  };
}

/** Штамп или печать. */
export function createStampObject(
  template: StampTemplate,
  options: {
    page: number;
    x: number;
    y: number;
    width?: number;
    height?: number;
    zIndex?: number;
    rotation?: number;
    name?: string;
    templateId?: string | null;
    textOverride?: string | null;
  },
): StampObject {
  const width = options.width ?? template.width;
  const height = options.height ?? template.height;
  return {
    ...baseFields({
      page: options.page,
      x: options.x,
      y: options.y,
      width,
      height,
      zIndex: options.zIndex ?? 1,
      rotation: options.rotation ?? 0,
      name: options.name,
    }),
    type: 'stamp',
    payload: {
      templateId: options.templateId ?? template.id,
      template: cloneStampTemplate(template),
      overrides: {
        textOverride: options.textOverride ?? null,
      },
    },
  };
}

/** Закрашивание (корректор). */
export function createWhiteoutObject(
  options: BaseCreateOptions & { color: string },
): WhiteoutObject {
  return {
    ...baseFields(options),
    type: 'whiteout',
    payload: { color: options.color, solid: true },
  };
}

/** Выделение (хайлайтер). */
export function createHighlightObject(
  options: BaseCreateOptions & { color: string },
): HighlightObject {
  return {
    ...baseFields(options),
    type: 'highlight',
    payload: { color: options.color, blend: 'multiply' },
  };
}

/** Копия объекта с новым идентификатором. */
export function duplicateObject(obj: EditorObject, patch: Partial<EditorObject> = {}): EditorObject {
  const now = new Date().toISOString();
  const payload = JSON.parse(JSON.stringify(obj.payload)) as ObjectPayload;
  if (obj.type === 'stamp') {
    const stampPayload = payload as { template: StampTemplate };
    stampPayload.template = cloneStampTemplate(stampPayload.template);
  }
  return {
    ...obj,
    ...patch,
    id: createId('obj'),
    payload,
    createdAt: now,
    updatedAt: now,
  } as EditorObject;
}

/** Значения payload по умолчанию (для миграции старых проектов). */
export function defaultPayloadFor(type: ShiftObjectType): ObjectPayload {
  switch (type) {
    case 'text':
      return createTextObject({
        page: 0,
        x: 0,
        y: 0,
        width: 120,
        height: 20,
        text: '',
        defaults: { fontId: 'pt-sans', fontFamily: 'PT Sans', fontSize: 14, color: '#111827' },
      }).payload;
    case 'image':
      return {
        src: '',
        mimeType: 'image/png',
        naturalWidth: 1,
        naturalHeight: 1,
        fit: 'contain',
        cornerRadius: 0,
        borderColor: null,
        borderWidth: 0,
      };
    case 'shape':
      return {
        kind: 'rect',
        stroke: '#dc2626',
        strokeWidth: 2,
        fill: null,
        dash: [],
        cornerRadius: 0,
        arrowHead: 'none',
        points: [0, 0, 1, 1],
      };
    case 'drawing':
      return { strokes: [], designWidth: 1, designHeight: 1, erasable: false };
    case 'signature':
      return {
        strokes: [],
        designWidth: 1,
        designHeight: 1,
        color: '#111827',
        strokeWidth: 2,
        svg: null,
        png: null,
        source: 'draw',
        modelId: null,
      };
    case 'stamp':
      return {
        templateId: null,
        template: {
          id: 'placeholder',
          name: 'Штамп',
          kind: 'stamp',
          shape: 'rect',
          width: 150,
          height: 60,
          color: '#1d4ed8',
          borderWidth: 2,
          doubleBorder: false,
          borderGap: 4,
          cornerRadius: 4,
          opacity: 1,
          rotation: 0,
          fontId: 'pt-sans',
          lines: [],
          circularText: {
            enabled: false,
            text: '',
            fontSize: 11,
            radius: 0,
            startAngle: 270,
            direction: 'cw',
            letterSpacing: 0,
            color: null,
            splitBottom: false,
            bottomText: '',
          },
          logo: null,
          backgroundColor: null,
          divider: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: [],
        },
        overrides: {},
      };
    case 'whiteout':
      return { color: '#ffffff', solid: true };
    case 'highlight':
      return { color: '#facc15', blend: 'multiply' };
    default:
      return { color: '#ffffff', solid: true };
  }
}

/**
 * Приведение импортированного объекта к актуальной схеме.
 * Возвращает null, если объект восстановить невозможно.
 */
export function normalizeImportedObject(raw: unknown): EditorObject | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<EditorObject> & { type?: string };
  const type = source.type as ShiftObjectType | undefined;
  if (!type) return null;
  const allowed: ShiftObjectType[] = [
    'text',
    'image',
    'shape',
    'drawing',
    'signature',
    'stamp',
    'whiteout',
    'highlight',
  ];
  if (!allowed.includes(type)) return null;

  const now = new Date().toISOString();
  const defaults = defaultPayloadFor(type);
  const payload = { ...defaults, ...(source.payload ?? {}) } as ObjectPayload;

  return {
    id: source.id ?? createId('obj'),
    type,
    page: Number.isFinite(source.page) ? Number(source.page) : 0,
    x: Number.isFinite(source.x) ? Number(source.x) : 0,
    y: Number.isFinite(source.y) ? Number(source.y) : 0,
    width: Number.isFinite(source.width) ? Math.max(1, Number(source.width)) : 50,
    height: Number.isFinite(source.height) ? Math.max(1, Number(source.height)) : 20,
    rotation: Number.isFinite(source.rotation) ? Number(source.rotation) : 0,
    opacity: Number.isFinite(source.opacity) ? Number(source.opacity) : 1,
    visible: source.visible !== false,
    locked: Boolean(source.locked),
    zIndex: Number.isFinite(source.zIndex) ? Number(source.zIndex) : 1,
    name: source.name,
    groupId: source.groupId ?? null,
    createdAt: source.createdAt ?? now,
    updatedAt: source.updatedAt ?? now,
    payload,
  } as EditorObject;
}

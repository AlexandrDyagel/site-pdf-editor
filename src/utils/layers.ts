/**
 * ============================================================================
 *  Подписи слоёв и цветовые индикаторы.
 * ============================================================================
 *
 *  В панели «Слои» объект называется по инструменту, которым он создан
 *  («Эллипс», «Прямоугольник», «Текст»…), а одинаковые названия нумеруются
 *  снизу вверх: самый нижний слой — «Прямоугольник 1». Нумерация зависит от
 *  порядка отрисовки, поэтому добавление нового объекта сверху не сбивает
 *  номера у остальных.
 *
 *  Функции чистые (только данные объекта) и покрыты тестами в `pnpm verify`.
 */

import type { EditorObject, ShapeKind } from '@/types';

/** Названия фигур по виду инструмента. */
const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: 'Прямоугольник',
  ellipse: 'Эллипс',
  triangle: 'Треугольник',
  polygon: 'Многоугольник',
  line: 'Линия',
  arrow: 'Стрелка',
};

/** Базовое название слоя — по инструменту, которым создан объект. */
export function layerBaseName(obj: EditorObject): string {
  switch (obj.type) {
    case 'shape':
      return SHAPE_LABELS[obj.payload.kind] ?? 'Фигура';
    case 'text':
      return 'Текст';
    case 'image':
      return 'Изображение';
    case 'stamp':
      return obj.payload.template.kind === 'seal' ? 'Печать' : 'Штамп';
    case 'signature':
      return 'Подпись';
    case 'drawing':
      return 'Рисунок';
    case 'whiteout':
      return 'Закрашивание';
    case 'highlight':
      return 'Выделение';
    default:
      return 'Объект';
  }
}

/**
 * Название слоя с учётом пользовательского имени.
 *
 * Имя из раздела «Служебное» главнее названия инструмента: иначе
 * переименование сохранялось в объект, но нигде не было видно.
 */
export function layerName(obj: EditorObject): string {
  const custom = obj.name?.trim();
  return custom && custom.length > 0 ? custom : layerBaseName(obj);
}

/**
 * Подписи всех объектов страницы.
 *
 * `ordered` — объекты в порядке отрисовки (снизу вверх, как отдаёт `forPage`):
 * первому снизу достаётся номер 1. Если название единственное, номер не
 * добавляется.
 */
export function layerLabels(ordered: readonly EditorObject[]): Map<string, string> {
  const groups = new Map<string, EditorObject[]>();
  for (const obj of ordered) {
    const base = layerName(obj);
    const list = groups.get(base);
    if (list) list.push(obj);
    else groups.set(base, [obj]);
  }

  const labels = new Map<string, string>();
  for (const [base, list] of groups) {
    list.forEach((obj, index) => {
      labels.set(obj.id, list.length > 1 ? `${base} ${index + 1}` : base);
    });
  }
  return labels;
}

/** Прозрачные цвета, которые не должны попадать в индикатор. */
const TRANSPARENT = /^(transparent|none|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/i;

function normalizeColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const value = color.trim();
  if (!value || TRANSPARENT.test(value)) return null;
  return value;
}

/**
 * Основной цвет объекта для индикатора слева от названия.
 * У фигур — заливка, а если её нет — обводка.
 */
export function layerAccentColor(obj: EditorObject): string | null {
  switch (obj.type) {
    case 'shape':
      return normalizeColor(obj.payload.fill) ?? normalizeColor(obj.payload.stroke);
    case 'text':
      return normalizeColor(obj.payload.color);
    case 'whiteout':
    case 'highlight':
      return normalizeColor(obj.payload.color);
    case 'stamp':
      return normalizeColor(obj.payload.overrides.color) ?? normalizeColor(obj.payload.template.color);
    case 'signature':
      return normalizeColor(obj.payload.strokes[0]?.color) ?? normalizeColor(obj.payload.color);
    case 'drawing':
      return normalizeColor(obj.payload.strokes[0]?.color);
    case 'image':
      return normalizeColor(obj.payload.borderColor);
    default:
      return null;
  }
}

/** Дополнительная подпись для подсказки: текст объекта, название штампа и т. п. */
export function layerDetail(obj: EditorObject): string {
  switch (obj.type) {
    case 'text':
      return (obj.payload.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    case 'stamp':
      return obj.payload.template.name || obj.payload.overrides.textOverride || '';
    case 'image':
      return obj.payload.alt ?? '';
    default:
      // У фигур и рисунков название уже совпадает с типом — дублировать нечего.
      return '';
  }
}

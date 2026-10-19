/**
 * «Закрашенные» участки: штрихи корректора и умного корректора.
 *
 * Они ведут себя как часть страницы, а не как объект: на холсте их нельзя
 * выделить ни кликом, ни рамкой, ни Ctrl+A — иначе корректор «залипал» бы при
 * каждом следующем клике по закрашенному месту. Выбрать их можно только в
 * панели «Слои» — тогда появляется рамка и доступны перенос/масштаб.
 */

import type { EditorObject } from '@/types';

/** Является ли объект закрашенным участком (корректор/умный корректор). */
export function isMaskingStroke(obj: EditorObject | null | undefined): boolean {
  if (!obj || obj.type !== 'drawing') return false;
  return Boolean(obj.payload.erasable || obj.payload.smart);
}

/**
 * ============================================================================
 *  Поворот страниц PDF.
 * ============================================================================
 *
 *  Поворот, добавленный пользователем, хранится отдельно от исходного
 *  `/Rotate` страницы (`PdfPageState.viewRotation`), а итоговый поворот
 *  страницы равен их сумме. Такой подход:
 *    - не разрушает исходный документ: содержимое страницы не перезаписывается,
 *      в PDF меняется только `/Rotate`, как это делают все просмотрщики;
 *    - позволяет в любой момент вернуть исходную ориентацию;
 *    - корректно переносит аннотации: объекты пересчитываются в систему
 *      координат нового поворота и остаются на своих местах относительно
 *      содержимого страницы.
 *
 *  Поворот участвует в истории (undo/redo) вместе с объектами.
 */

import { useObjectsStore } from '@/stores/objects';
import { usePdfStore } from '@/stores/pdf';
import { useEditorStore } from '@/stores/editor';
import { useUiStore } from '@/stores/ui';
import {
  extraPageRotation,
  normalizePdfRotation,
  quarterTurns,
  remapObjectsForPageRotation,
  type PageGeometry,
} from '@/utils/coordinates';
import { normalizeAngle } from '@/utils/geometry';

// Чистая математика поворота живёт в утилитах и покрыта тестами.
export { remapObjectsForPageRotation, quarterTurns };

export function usePageRotation(): {
  rotatePage: (index: number, delta: number) => void;
  rotateCurrentPage: (delta: number) => void;
  rotateAllPages: (delta: number) => void;
  setPageRotation: (index: number, rotation: number) => void;
  resetPageRotation: (index?: number) => void;
  pageRotation: (index: number) => number;
  hasCustomRotation: (index: number) => boolean;
  customRotationCount: () => number;
} {
  const pdf = usePdfStore();
  const objects = useObjectsStore();
  const editor = useEditorStore();
  const ui = useUiStore();

  /** Итоговый поворот страницы (исходный + пользовательский). */
  function pageRotation(index: number): number {
    const page = pdf.pages[index];
    if (!page) return 0;
    return quarterTurns(page.rotation + extraPageRotation(page));
  }

  /** Есть ли у страницы пользовательский поворот. */
  function hasCustomRotation(index: number): boolean {
    return extraPageRotation(pdf.pages[index] ?? {}) !== 0;
  }

  function customRotationCount(): number {
    return pdf.pages.filter((_, index) => hasCustomRotation(index)).length;
  }

  /**
   * Применяет новый пользовательский поворот к странице и переносит объекты.
   * Снимок истории должен быть сделан вызывающей стороной до вызова.
   */
  function applyViewRotation(index: number, nextView: number): void {
    const page = pdf.pages[index];
    if (!page) return;

    const from = pdf.geometry(index);
    const to: PageGeometry = {
      ...from,
      rotation: quarterTurns(page.rotation + nextView),
    };
    if (normalizePdfRotation(from.rotation) === normalizePdfRotation(to.rotation)) return;

    const patches = remapObjectsForPageRotation(objects.forPage(index), from, to);
    pdf.setViewRotation(index, nextView);
    for (const item of patches) objects.patchSilent(item.id, item.patch);
  }

  /**
   * Поворот одной страницы на `delta` градусов (обычно ±90).
   * Объекты страницы переносятся вместе с содержимым, действие целиком
   * попадает в историю.
   */
  function rotatePage(index: number, delta: number): void {
    const page = pdf.pages[index];
    if (!page || !delta) return;
    const nextView = quarterTurns(extraPageRotation(page) + delta);
    if (nextView === extraPageRotation(page)) return;

    objects.commit(delta % 180 === 0 ? 'Поворот страницы на 180°' : 'Поворот страницы');
    applyViewRotation(index, nextView);
    if (index === editor.currentPage) editor.centerPage();
  }

  /** Поворот текущей страницы. */
  function rotateCurrentPage(delta: number): void {
    rotatePage(editor.currentPage, delta);
  }

  /** Поворот всех страниц документа. */
  function rotateAllPages(delta: number): void {
    if (!delta || pdf.pageCount === 0) return;
    const targets = pdf.pages.map((page, index) => ({
      index,
      nextView: quarterTurns(extraPageRotation(page) + delta),
    }));
    if (!targets.some((target) => target.nextView !== extraPageRotation(pdf.pages[target.index]))) {
      return;
    }
    objects.commit('Поворот всех страниц');
    for (const target of targets) applyViewRotation(target.index, target.nextView);
    editor.centerPage();
  }

  /** Установка конкретного поворота (0/90/180/270). */
  function setPageRotation(index: number, rotation: number): void {
    const page = pdf.pages[index];
    if (!page) return;
    const target = quarterTurns(rotation);
    const current = pageRotation(index);
    const delta = normalizeAngle(target - current);
    if (delta === 0) return;
    rotatePage(index, delta);
  }

  /**
   * Возврат исходной ориентации: для одной страницы или для всего документа.
   */
  function resetPageRotation(index?: number): void {
    if (index === undefined) {
      const count = customRotationCount();
      if (count === 0) {
        ui.notify.info('Поворот уже исходный', 'Ни одна страница не повёрнута вручную.');
        return;
      }
      objects.commit('Сброс поворотов страниц');
      for (let pageIndex = 0; pageIndex < pdf.pageCount; pageIndex += 1) {
        if (hasCustomRotation(pageIndex)) applyViewRotation(pageIndex, 0);
      }
      editor.centerPage();
      ui.notify.info('Повороты сброшены', `Страниц: ${count}`);
      return;
    }

    if (!hasCustomRotation(index)) return;
    objects.commit('Сброс поворота страницы');
    applyViewRotation(index, 0);
    if (index === editor.currentPage) editor.centerPage();
  }

  return {
    rotatePage,
    rotateCurrentPage,
    rotateAllPages,
    setPageRotation,
    resetPageRotation,
    pageRotation,
    hasCustomRotation,
    customRotationCount,
  };
}

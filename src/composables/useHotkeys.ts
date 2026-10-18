/**
 * Горячие клавиши редактора.
 * Клавиши внутри полей ввода не перехватываются (кроме Escape).
 */

import { useRouter } from 'vue-router';
import { useEditorStore } from '@/stores/editor';
import { useObjectsStore } from '@/stores/objects';
import { usePdfStore } from '@/stores/pdf';
import { useUiStore } from '@/stores/ui';
import { useExportStore } from '@/stores/export';
import { useUndoRedo } from '@/composables/useUndoRedo';
import { usePdfDocument } from '@/composables/usePdfDocument';
import { usePageRotation } from '@/composables/usePageRotation';
import { TOOL_DEFINITIONS, ZOOM_STEP } from '@/constants';

/** Проверка, что фокус в поле ввода. */
function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable
  );
}

/**
 * Логическая клавиша горячего сочетания, не зависящая от раскладки.
 *
 * `event.key` при русской раскладке для физической клавиши Z возвращает «я»,
 * поэтому Ctrl+Z (а также буквенные сокращения инструментов и «[» / «]») не
 * срабатывал. Берём латинскую букву или цифру из `event.key`, а если раскладка
 * не латинская — переводим физический код клавиши (`event.code`).
 * Стрелки, Escape, Delete, Home, End, PageUp/PageDown от раскладки не зависят,
 * их оставляем как есть.
 */
export function logicalKey(event: KeyboardEvent): string {
  const key = event.key;

  // Латинская буква, цифра или символ из раскладки — берём как есть:
  // это верно и для нестандартных латинских раскладок (например, Dvorak).
  if (/^[a-z0-9]$/i.test(key)) return key.toLowerCase();
  if (key === '[' || key === ']' || key === '+' || key === '=' || key === '-' || key === '/') {
    return key;
  }

  const code = event.code ?? '';
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  if (code === 'Minus' || code === 'NumpadSubtract') return '-';
  if (code === 'Equal') return '=';
  if (code === 'NumpadAdd') return '+';
  if (code === 'Slash') return '/';

  return key.toLowerCase();
}

export function useHotkeys(): { dispose: () => void } {
  const editor = useEditorStore();
  const objects = useObjectsStore();
  const pdf = usePdfStore();
  const ui = useUiStore();
  const exporter = useExportStore();
  const history = useUndoRedo();
  const documents = usePdfDocument();
  const rotation = usePageRotation();
  const router = useRouter();

  /** Действия с документом (экспорт, сохранение) имеют смысл только в редакторе. */
  function inEditor(): boolean {
    return router.currentRoute.value.name === 'editor';
  }

  const toolByKey = new Map<string, string>();
  for (const tool of TOOL_DEFINITIONS) {
    if (tool.shortcut) toolByKey.set(tool.shortcut.toLowerCase(), tool.id);
  }

  async function onKeyDown(event: KeyboardEvent): Promise<void> {
    const target = isEditingTarget(event.target);
    const mod = event.ctrlKey || event.metaKey;
    // Клавиша с учётом раскладки: Ctrl+Z работает и на русской раскладке.
    const key = logicalKey(event);

    // Escape работает всегда: отмена черновиков и снятие выделения.
    if (event.key === 'Escape') {
      if (ui.confirmState.open) {
        ui.resolveConfirm(false);
        return;
      }
      if (ui.anyModalOpen) {
        ui.closeAllModals();
        return;
      }
      if (editor.activeStroke || editor.shapeDraft || editor.marquee) {
        editor.cancelDrafts();
        return;
      }
      editor.stopTextEditing();
      objects.clearSelection();
      return;
    }

    if (target) return;
    if (ui.confirmState.open) return;

    // Alt + стрелки — поворот страницы (частая операция для сканов).
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      rotation.rotateCurrentPage(event.key === 'ArrowLeft' ? -90 : 90);
      return;
    }

    // Пробел — временная панорама.
    if (event.code === 'Space') {
      editor.spacePressed = true;
      event.preventDefault();
      return;
    }
    if (event.key === 'Shift') {
      editor.shiftPressed = true;
      return;
    }

    // Модификаторы + клавиши.
    if (mod) {
      switch (key) {
        case 'z':
          event.preventDefault();
          if (event.shiftKey) history.redo();
          else history.undo();
          return;
        case 'y':
          event.preventDefault();
          history.redo();
          return;
        case 's':
          event.preventDefault();
          if (event.shiftKey) {
            if (inEditor()) ui.openModal('export');
          } else if (inEditor()) {
            void exporter.run();
          }
          return;
        case 'o':
          event.preventDefault();
          await documents.openFromDialog();
          return;
        case 'e':
          event.preventDefault();
          if (inEditor()) ui.openModal('export');
          return;
        case 'f':
          // Ctrl+Shift+F — управление шрифтами (доступно с любой страницы).
          if (event.shiftKey) {
            event.preventDefault();
            ui.openModal('fonts');
          }
          return;
        case 'a':
          event.preventDefault();
          objects.selectAll(editor.currentPage);
          return;
        case 'c':
          if (editor.tool !== 'select') return;
          event.preventDefault();
          objects.copy();
          ui.notify.info('Скопировано', `${objects.clipboard.length} объектов`);
          return;
        case 'x':
          if (editor.tool !== 'select') return;
          event.preventDefault();
          objects.cut();
          return;
        case 'v':
          if (editor.tool !== 'select') return;
          event.preventDefault();
          objects.paste(editor.currentPage);
          return;
        case 'd':
          event.preventDefault();
          objects.duplicate();
          return;
        case 'g':
          event.preventDefault();
          if (event.shiftKey) objects.ungroup();
          else objects.group();
          return;
        case '=':
        case '+':
          event.preventDefault();
          editor.zoomIn();
          return;
        case '-':
          event.preventDefault();
          editor.zoomOut();
          return;
        case '0':
          event.preventDefault();
          if (event.shiftKey) editor.fitToPage();
          else editor.fitToWidth();
          return;
        case '1':
          event.preventDefault();
          editor.actualSize();
          return;
        case 'l':
          event.preventDefault();
          objects.setLocked(objects.selectedIds, !objects.selectedObjects.every((o) => o.locked));
          return;
        default:
          return;
      }
    }

    // Навигация по страницам.
    if (event.key === 'PageDown') {
      event.preventDefault();
      editor.nextPage();
      return;
    }
    if (event.key === 'PageUp') {
      event.preventDefault();
      editor.previousPage();
      return;
    }
    if (event.key === 'Home' && pdf.pageCount > 0) {
      event.preventDefault();
      editor.firstPage();
      return;
    }
    if (event.key === 'End' && pdf.pageCount > 0) {
      event.preventDefault();
      editor.lastPage();
      return;
    }

    // Удаление.
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!objects.hasSelection) return;
      event.preventDefault();
      const count = objects.selectionCount;
      if (count > 4) {
        const confirmed = await ui.askConfirm({
          title: 'Удалить объекты?',
          text: `Будет удалено объектов: ${count}.`,
          confirmLabel: 'Удалить',
          danger: true,
        });
        if (!confirmed) return;
      }
      objects.remove(objects.selectedIds);
      return;
    }

    // Сдвиг стрелками.
    if (event.key.startsWith('Arrow') && objects.hasSelection) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      objects.nudge(dx, dy);
      return;
    }

    // Z-index.
    if (key === ']') {
      objects.bringForward();
      return;
    }
    if (key === '[') {
      objects.sendBackward();
      return;
    }

    // Инструменты.
    const tool = toolByKey.get(key);
    if (tool) {
      event.preventDefault();
      editor.setTool(tool as never);
      return;
    }

    // Масштаб по "=" без Ctrl.
    if (key === '+' || key === '=') {
      editor.setZoom(editor.zoom * ZOOM_STEP);
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.code === 'Space') editor.spacePressed = false;
    if (event.key === 'Shift') editor.shiftPressed = false;
  }

  function onBlur(): void {
    editor.spacePressed = false;
    editor.shiftPressed = false;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
  }

  function dispose(): void {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  }

  return { dispose };
}

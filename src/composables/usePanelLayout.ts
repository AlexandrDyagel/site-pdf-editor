/**
 * ============================================================================
 *  Ширина боковых панелей редактора.
 * ============================================================================
 *
 *  Панели «Страницы/Библиотека/Текст» и «Инструмент/Свойства/Слои/Страница»
 *  можно растянуть, потянув за их внутреннюю границу (к центру рабочей области).
 *  Ширина сохраняется в localStorage, поэтому раскладка не сбрасывается при
 *  перезагрузке. Двойной клик по границе возвращает ширину по умолчанию,
 *  стрелки на границе меняют её с клавиатуры.
 */

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/** Сторона панели. */
export type PanelSide = 'left' | 'right';

/** Ключ хранения раскладки. */
const STORAGE_KEY = 'pdf-editor:panel-widths';

/** Минимальная и максимальная ширина панели, px. */
const MIN_WIDTH = 220;
const MAX_WIDTH = 720;

/** Ширина по умолчанию, px. */
const DEFAULTS: Record<PanelSide, number> = { left: 252, right: 320 };

/** Ограничение ширины: не меньше минимума и не больше допустимого. */
function clampWidth(value: number): number {
  const viewport = typeof window === 'undefined' ? 1440 : window.innerWidth;
  // Панель не должна занимать больше ~45% окна, иначе не останется холста.
  const limit = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(viewport * 0.45)));
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return MIN_WIDTH;
  return Math.min(limit, Math.max(MIN_WIDTH, rounded));
}

export function usePanelLayout(): {
  leftWidth: Ref<number>;
  rightWidth: Ref<number>;
  resizing: Ref<PanelSide | null>;
  startResize: (side: PanelSide, event: PointerEvent) => void;
  resetWidth: (side: PanelSide) => void;
  nudgeWidth: (side: PanelSide, delta: number) => void;
} {
  const leftWidth = ref<number>(DEFAULTS.left);
  const rightWidth = ref<number>(DEFAULTS.right);
  const resizing = ref<PanelSide | null>(null);
  let cleanup: (() => void) | null = null;

  /** Чтение сохранённой ширины. */
  function load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { left?: number; right?: number };
      if (typeof parsed.left === 'number') leftWidth.value = clampWidth(parsed.left);
      if (typeof parsed.right === 'number') rightWidth.value = clampWidth(parsed.right);
    } catch {
      /* localStorage может быть недоступен (приватный режим) */
    }
  }

  /** Сохранение ширины. */
  function save(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ left: leftWidth.value, right: rightWidth.value }),
      );
    } catch {
      /* не критично */
    }
  }

  /** Перетаскивание границы панели. */
  function startResize(side: PanelSide, event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const handle = event.currentTarget as HTMLElement | null;
    const startX = event.clientX;
    const startWidth = side === 'left' ? leftWidth.value : rightWidth.value;
    resizing.value = side;

    try {
      handle?.setPointerCapture?.(event.pointerId);
    } catch {
      /* захват недоступен — работаем через window */
    }

    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientX - startX;
      // Левую панель тянем вправо, правую — влево (к центру рабочей области).
      const value = side === 'left' ? startWidth + delta : startWidth - delta;
      if (side === 'left') leftWidth.value = clampWidth(value);
      else rightWidth.value = clampWidth(value);
    };

    const finish = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      try {
        handle?.releasePointerCapture?.(event.pointerId);
      } catch {
        /* уже отпущен */
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      resizing.value = null;
      save();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    cleanup = finish;
  }

  /** Возврат ширины по умолчанию. */
  function resetWidth(side: PanelSide): void {
    if (side === 'left') leftWidth.value = clampWidth(DEFAULTS.left);
    else rightWidth.value = clampWidth(DEFAULTS.right);
    save();
  }

  /** Изменение ширины с клавиатуры. */
  function nudgeWidth(side: PanelSide, delta: number): void {
    const current = side === 'left' ? leftWidth.value : rightWidth.value;
    const next = clampWidth(current + delta);
    if (side === 'left') leftWidth.value = next;
    else rightWidth.value = next;
    save();
  }

  /** При изменении размера окна ширина не должна «съесть» холст. */
  function onWindowResize(): void {
    leftWidth.value = clampWidth(leftWidth.value);
    rightWidth.value = clampWidth(rightWidth.value);
  }

  onMounted(() => {
    load();
    window.addEventListener('resize', onWindowResize);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('resize', onWindowResize);
    cleanup?.();
    cleanup = null;
  });

  return { leftWidth, rightWidth, resizing, startResize, resetWidth, nudgeWidth };
}

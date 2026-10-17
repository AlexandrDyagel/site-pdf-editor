/**
 * ============================================================================
 *  История операций (undo/redo).
 * ============================================================================
 *
 *  Объекты редактора неизменяемы: любая правка создаёт новые экземпляры,
 *  поэтому снимок — это просто копия массива ссылок (очень дешёво).
 *
 *  Стор намеренно «глупый»: он лишь хранит снимки. Оркестрацию выполняет
 *  `useObjectsStore` (см. `undo`/`redo`), что исключает циклические импорты.
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { HISTORY_LIMIT } from '@/constants';
import type { EditorObject, HistorySnapshot } from '@/types';

export const useHistoryStore = defineStore('history', () => {
  const past = ref<HistorySnapshot[]>([]);
  const future = ref<HistorySnapshot[]>([]);
  const limit = ref(HISTORY_LIMIT);

  /**
   * Мост к состоянию страниц: поворот страницы тоже участвует в истории,
   * иначе после отмены объекты оказались бы в системе координат другого
   * поворота и «уехали» бы. Функции регистрирует приложение при запуске.
   */
  let readPageRotations: (() => number[]) | null = null;
  let writePageRotations: ((rotations: readonly number[]) => void) | null = null;

  function setRotationBridge(bridge: {
    read: () => number[];
    write: (rotations: readonly number[]) => void;
  }): void {
    readPageRotations = bridge.read;
    writePageRotations = bridge.write;
  }

  function snapshotRotations(): number[] | undefined {
    return readPageRotations ? readPageRotations() : undefined;
  }

  const canUndo = computed(() => past.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const depth = computed(() => past.value.length);
  const nextUndoLabel = computed(() => past.value[past.value.length - 1]?.label ?? '');
  const nextRedoLabel = computed(() => future.value[future.value.length - 1]?.label ?? '');

  /** Записать состояние перед изменением. */
  function record(label: string, objects: readonly EditorObject[]): void {
    past.value.push({
      label,
      at: Date.now(),
      objects: objects.slice(),
      pageRotations: snapshotRotations(),
    });
    if (past.value.length > limit.value) past.value.shift();
    // Любое новое действие обнуляет «будущее».
    future.value = [];
  }

  /** Шаг назад: возвращает снимок, который нужно применить. */
  function undo(current: readonly EditorObject[]): HistorySnapshot | null {
    const snapshot = past.value.pop();
    if (!snapshot) return null;
    future.value.push({
      label: snapshot.label,
      at: Date.now(),
      objects: current.slice(),
      pageRotations: snapshotRotations(),
    });
    // Возвращаем повороты страниц вместе с объектами.
    if (snapshot.pageRotations && writePageRotations) {
      writePageRotations(snapshot.pageRotations);
    }
    return snapshot;
  }

  /** Шаг вперёд. */
  function redo(current: readonly EditorObject[]): HistorySnapshot | null {
    const snapshot = future.value.pop();
    if (!snapshot) return null;
    past.value.push({
      label: snapshot.label,
      at: Date.now(),
      objects: current.slice(),
      pageRotations: snapshotRotations(),
    });
    if (snapshot.pageRotations && writePageRotations) {
      writePageRotations(snapshot.pageRotations);
    }
    return snapshot;
  }

  /** Очистка истории (при закрытии документа). */
  function clear(): void {
    past.value = [];
    future.value = [];
  }

  /** Ограничение глубины истории. */
  function setLimit(value: number): void {
    limit.value = Math.max(10, Math.min(500, Math.floor(value)));
    while (past.value.length > limit.value) past.value.shift();
  }

  return {
    past,
    future,
    limit,
    canUndo,
    canRedo,
    depth,
    nextUndoLabel,
    nextRedoLabel,
    record,
    undo,
    redo,
    clear,
    setLimit,
    setRotationBridge,
  };
});

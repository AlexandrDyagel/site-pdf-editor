/**
 * История операций: удобная обёртка над стором истории и объектами
 * (используется горячими клавишами и панелью инструментов).
 */

import { computed } from 'vue';
import { useObjectsStore } from '@/stores/objects';
import { useHistoryStore } from '@/stores/history';
import { useUiStore } from '@/stores/ui';

export function useUndoRedo() {
  const objects = useObjectsStore();
  const history = useHistoryStore();
  const ui = useUiStore();

  const canUndo = computed(() => history.canUndo);
  const canRedo = computed(() => history.canRedo);
  const depth = computed(() => history.depth);
  const undoLabel = computed(() => history.nextUndoLabel || 'Действие');
  const redoLabel = computed(() => history.nextRedoLabel || 'Действие');

  function undo(): void {
    const label = history.nextUndoLabel;
    if (!objects.undo()) {
      ui.notify.info('Отменять нечего');
      return;
    }
    ui.notify.info('Отменено', label);
  }

  function redo(): void {
    const label = history.nextRedoLabel;
    if (!objects.redo()) {
      ui.notify.info('Повторять нечего');
      return;
    }
    ui.notify.info('Повторено', label);
  }

  function remember(label: string): void {
    objects.commit(label);
  }

  function clear(): void {
    history.clear();
  }

  return { canUndo, canRedo, undoLabel, redoLabel, depth, undo, redo, remember, clear };
}

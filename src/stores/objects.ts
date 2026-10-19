/**
 * ============================================================================
 *  Хранилище объектов редактора.
 * ============================================================================
 *
 *  Правила:
 *   - объекты неизменяемы (immutable): любая правка создаёт новый массив;
 *   - перед изменением пишется снимок в `useHistoryStore`;
 *   - выделение, буфер обмена, z-index и выравнивание живут здесь же.
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { EditorObject, ObjectTransform, ShiftObjectType } from '@/types';
import { normalizeObjectToPage, type PageGeometry } from '@/utils/coordinates';
import { boundsOfTransforms, type Rect } from '@/utils/geometry';
import { isMaskingStroke } from '@/utils/masking';
import { duplicateObject } from '@/services/objectFactory';
import { useHistoryStore } from '@/stores/history';

/** Частичное изменение свойств объекта. */
export type ObjectPatch = Partial<Omit<EditorObject, 'id' | 'type' | 'payload'>> & {
  payload?: Record<string, unknown>;
};

export const useObjectsStore = defineStore('objects', () => {
  const history = useHistoryStore();

  const objects = ref<EditorObject[]>([]);
  const selectedIds = ref<string[]>([]);
  const clipboard = ref<EditorObject[]>([]);
  /** Счётчик для генерации z-index. */
  const zCounter = ref(1);

  /* ======================== Геттеры ======================== */

  const all = computed(() => objects.value);

  const selectedObjects = computed(() =>
    objects.value.filter((obj) => selectedIds.value.includes(obj.id)),
  );

  const hasSelection = computed(() => selectedIds.value.length > 0);
  const selectionCount = computed(() => selectedIds.value.length);

  const selectionBounds = computed<Rect | null>(() => {
    const items = selectedObjects.value;
    if (items.length === 0) return null;
    return boundsOfTransforms(items);
  });

  /** Объекты страницы, отсортированные по z-index. */
  function forPage(page: number): EditorObject[] {
    return objects.value
      .filter((obj) => obj.page === page)
      .sort((a, b) => a.zIndex - b.zIndex);
  }

  /** Количество объектов на странице. */
  function countForPage(page: number): number {
    return objects.value.reduce((sum, obj) => sum + (obj.page === page ? 1 : 0), 0);
  }

  function byId(id: string): EditorObject | undefined {
    return objects.value.find((obj) => obj.id === id);
  }

  function byType(type: ShiftObjectType): EditorObject[] {
    return objects.value.filter((obj) => obj.type === type);
  }

  const pagesWithObjects = computed(() => {
    const set = new Set<number>();
    for (const obj of objects.value) set.add(obj.page);
    return Array.from(set).sort((a, b) => a - b);
  });

  const totalVisible = computed(() => objects.value.filter((obj) => obj.visible).length);

  /* ======================== История ======================== */

  /** Записать снимок перед изменением. */
  function commit(label: string): void {
    history.record(label, objects.value);
  }

  function undo(): boolean {
    const snapshot = history.undo(objects.value);
    if (!snapshot) return false;
    objects.value = snapshot.objects.slice();
    pruneSelection();
    return true;
  }

  function redo(): boolean {
    const snapshot = history.redo(objects.value);
    if (!snapshot) return false;
    objects.value = snapshot.objects.slice();
    pruneSelection();
    return true;
  }

  const canUndo = computed(() => history.canUndo);
  const canRedo = computed(() => history.canRedo);

  /** Убрать из выделения исчезнувшие объекты. */
  function pruneSelection(): void {
    const existing = new Set(objects.value.map((obj) => obj.id));
    selectedIds.value = selectedIds.value.filter((id) => existing.has(id));
  }

  /* ======================== Изменения ======================== */

  /** Добавить объекты (с записью в историю). */
  function add(items: EditorObject[], label = 'Добавление объекта'): void {
    if (items.length === 0) return;
    commit(label);
    // Новым объектам всегда выдаём свежий z-index: у объектов из фабрики
    // он одинаковый, из-за чего ломался порядок слоёв и «поверх/вниз».
    const prepared = items.map((item, index) => ({
      ...item,
      zIndex: nextZIndex(item.page) + index,
    }));
    objects.value = [...objects.value, ...prepared];
    selectedIds.value = prepared.map((item) => item.id);
    zCounter.value = Math.max(zCounter.value, ...prepared.map((item) => item.zIndex + 1));
  }

  /** Следующий z-index для страницы. */
  function nextZIndex(page: number): number {
    const max = objects.value.reduce(
      (value, obj) => (obj.page === page ? Math.max(value, obj.zIndex) : value),
      0,
    );
    return max + 1;
  }

  /** Обновить один объект. */
  function update(id: string, patch: ObjectPatch, label = 'Изменение объекта'): void {
    const existing = byId(id);
    if (!existing) return;
    commit(label);
    applyPatch(id, patch);
  }

  /** Обновить несколько объектов одним действием истории. */
  function updateMany(
    updates: readonly { id: string; patch: ObjectPatch }[],
    label = 'Изменение объектов',
  ): void {
    if (updates.length === 0) return;
    commit(label);
    for (const item of updates) applyPatch(item.id, item.patch);
  }

  /** Внутренняя правка без записи в историю. */
  function applyPatch(id: string, patch: ObjectPatch): void {
    const now = new Date().toISOString();
    objects.value = objects.value.map((obj) => {
      if (obj.id !== id) return obj;
      const { payload, ...rest } = patch;
      const next = { ...obj, ...rest, updatedAt: now } as EditorObject;
      if (payload) {
        next.payload = { ...obj.payload, ...payload } as EditorObject['payload'];
      }
      return next;
    });
  }

  /**
   * Правка без записи в историю — для «живых» изменений (набор текста,
   * перетаскивание ползунка). Панель свойств сама решает, когда записать снимок.
   */
  function patchSilent(id: string, patch: ObjectPatch): void {
    applyPatch(id, patch);
  }

  /** Правка payload конкретного объекта. */
  function updatePayload(
    id: string,
    payload: Record<string, unknown>,
    label = 'Изменение свойств',
  ): void {
    update(id, { payload }, label);
  }

  /** Удалить объекты. */
  function remove(ids: readonly string[], label = 'Удаление объекта'): void {
    if (ids.length === 0) return;
    commit(label);
    const set = new Set(ids);
    objects.value = objects.value.filter((obj) => !set.has(obj.id));
    selectedIds.value = selectedIds.value.filter((id) => !set.has(id));
  }

  /** Удалить все объекты страницы. */
  function removePage(page: number): void {
    const ids = objects.value.filter((obj) => obj.page === page).map((obj) => obj.id);
    remove(ids, 'Очистка страницы');
  }

  /** Полная очистка (новая страница/документ). */
  function clearAll(withHistory = true): void {
    if (withHistory) commit('Очистка документа');
    objects.value = [];
    selectedIds.value = [];
    zCounter.value = 1;
  }

  /** Заменить весь список (импорт проекта, восстановление истории). */
  function replaceAll(items: EditorObject[], withHistory = false, label = 'Загрузка данных'): void {
    if (withHistory) commit(label);
    objects.value = items.slice();
    pruneSelection();
    zCounter.value =
      items.reduce((max, obj) => Math.max(max, obj.zIndex), 0) + 1;
  }

  /* ======================== Выделение ======================== */

  /**
   * Выделение ровно переданных объектов.
   *
   * Группа целиком выделяется только явно — кликом по строке группы в
   * «Слоях» (там передаётся весь список объектов). Клик по одному объекту
   * группы (на холсте или в списке) выделяет именно его.
   */
  function select(ids: readonly string[]): void {
    selectedIds.value = Array.from(new Set(ids));
  }

  function selectOne(id: string, additive = false): void {
    if (!additive) {
      selectedIds.value = [id];
      return;
    }
    selectedIds.value = selectedIds.value.includes(id)
      ? selectedIds.value.filter((value) => value !== id)
      : [...selectedIds.value, id];
  }

  function selectAll(page?: number): void {
    selectedIds.value = objects.value
      .filter((obj) => (page === undefined ? true : obj.page === page) && obj.visible)
      // Закрашенные участки выбираются только в панели «Слои».
      .filter((obj) => !isMaskingStroke(obj))
      .map((obj) => obj.id);
  }

  function clearSelection(): void {
    selectedIds.value = [];
  }

  /* ======================== Z-index ======================== */

  /** Страницы, на которых есть указанные объекты. */
  function pagesOf(ids: readonly string[]): Set<number> {
    return new Set(
      objects.value.filter((obj) => ids.includes(obj.id)).map((obj) => obj.page),
    );
  }

  /** Объекты страницы в порядке отрисовки: снизу вверх. */
  function orderedPageObjects(page: number): EditorObject[] {
    return objects.value
      .filter((obj) => obj.page === page)
      .sort((a, b) => a.zIndex - b.zIndex);
  }

  /**
   * Перенумерация слоёв страницы (1…N) по переданному порядку.
   *
   * Нумерация обязательна: старые проекты могли сохранить одинаковые zIndex
   * (например, у всех объектов z=1), и тогда обмен значениями «Выше/Ниже»
   * ничего не менял — порядок на экране оставался прежним.
   */
  function applyLayerOrder(page: number, ordered: readonly EditorObject[]): void {
    const positions = new Map(ordered.map((obj, index) => [obj.id, index + 1]));
    objects.value = objects.value.map((obj) => {
      const zIndex = positions.get(obj.id);
      return typeof zIndex === 'number' && zIndex !== obj.zIndex ? { ...obj, zIndex } : obj;
    });
  }

  function bringToFront(ids: readonly string[] = selectedIds.value): void {
    if (ids.length === 0) return;
    commit('Поверх всех');
    for (const page of pagesOf(ids)) {
      const list = orderedPageObjects(page);
      const targets = list.filter((obj) => ids.includes(obj.id));
      if (targets.length === 0) continue;
      const rest = list.filter((obj) => !ids.includes(obj.id));
      applyLayerOrder(page, [...rest, ...targets]);
    }
  }

  function sendToBack(ids: readonly string[] = selectedIds.value): void {
    if (ids.length === 0) return;
    commit('Позади всех');
    for (const page of pagesOf(ids)) {
      const list = orderedPageObjects(page);
      const targets = list.filter((obj) => ids.includes(obj.id));
      if (targets.length === 0) continue;
      const rest = list.filter((obj) => !ids.includes(obj.id));
      applyLayerOrder(page, [...targets, ...rest]);
    }
  }

  /**
   * Сдвиг объектов на один слой в пределах страницы.
   * Работает с упорядоченным списком, а не со значениями zIndex.
   */
  function stepZIndex(ids: readonly string[], direction: 1 | -1): void {
    if (ids.length === 0) return;
    commit(direction > 0 ? 'Выше' : 'Ниже');

    for (const page of pagesOf(ids)) {
      const list = orderedPageObjects(page);
      if (list.length < 2) continue;
      if (direction > 0) {
        // Сверху вниз: поднимаем самый верхний из выделенных первым.
        for (let i = list.length - 2; i >= 0; i -= 1) {
          if (ids.includes(list[i].id) && !ids.includes(list[i + 1].id)) {
            [list[i], list[i + 1]] = [list[i + 1], list[i]];
          }
        }
      } else {
        for (let i = 1; i < list.length; i += 1) {
          if (ids.includes(list[i].id) && !ids.includes(list[i - 1].id)) {
            [list[i], list[i - 1]] = [list[i - 1], list[i]];
          }
        }
      }
      applyLayerOrder(page, list);
    }
  }

  function bringForward(ids: readonly string[] = selectedIds.value): void {
    stepZIndex(ids, 1);
  }

  function sendBackward(ids: readonly string[] = selectedIds.value): void {
    stepZIndex(ids, -1);
  }

  /* ======================== Копирование ======================== */

  function copy(ids: readonly string[] = selectedIds.value): number {
    const items = objects.value.filter((obj) => ids.includes(obj.id));
    clipboard.value = items.map((obj) => duplicateObject(obj));
    return items.length;
  }

  function cut(ids: readonly string[] = selectedIds.value): number {
    const count = copy(ids);
    remove(ids, 'Вырезание');
    return count;
  }

  /** Дублирование на месте (со сдвигом). */
  function duplicate(ids: readonly string[] = selectedIds.value, offset = 10): EditorObject[] {
    const items = objects.value.filter((obj) => ids.includes(obj.id));
    if (items.length === 0) return [];
    const copies = items.map((obj) => {
      const copyObj = duplicateObject(obj, {
        x: obj.x + offset,
        y: obj.y + offset,
        zIndex: nextZIndex(obj.page),
      });
      return copyObj;
    });
    add(copies, 'Дублирование');
    return copies;
  }

  /** Вставка из буфера на указанную страницу. */
  function paste(page: number, offset = 12): EditorObject[] {
    if (clipboard.value.length === 0) return [];
    const items = clipboard.value.map((obj) =>
      duplicateObject(obj, {
        page,
        x: obj.x + offset,
        y: obj.y + offset,
        zIndex: nextZIndex(page),
      }),
    );
    add(items, 'Вставка');
    clipboard.value = items.map((obj) => duplicateObject(obj));
    return items;
  }

  const hasClipboard = computed(() => clipboard.value.length > 0);

  /* ======================== Трансформации ======================== */

  /** Сдвиг выделенных объектов. */
  function nudge(dx: number, dy: number, label = 'Перемещение'): void {
    const items = selectedObjects.value.filter((obj) => !obj.locked);
    if (items.length === 0) return;
    updateMany(
      items.map((obj) => ({ id: obj.id, patch: { x: obj.x + dx, y: obj.y + dy } })),
      label,
    );
  }

  /** Перемещение объектов на другую страницу. */
  function moveToPage(ids: readonly string[], page: number, geometry?: PageGeometry): void {
    const items = objects.value.filter((obj) => ids.includes(obj.id) && obj.page !== page);
    if (items.length === 0) return;
    commit('Перенос на другую страницу');
    objects.value = objects.value.map((obj) => {
      if (!ids.includes(obj.id) || obj.page === page) return obj;
      const moved: EditorObject = {
        ...obj,
        page,
        zIndex: nextZIndex(page),
        updatedAt: new Date().toISOString(),
      };
      return geometry ? (normalizeObjectToPage(moved, geometry, { clampToPage: true }) as EditorObject) : moved;
    });
  }

  /** Применить трансформацию к объектам (после перетаскивания/масштабирования). */
  function applyTransforms(
    transforms: readonly { id: string; patch: Partial<ObjectTransform & { width: number; height: number }> }[],
    label = 'Преобразование',
  ): void {
    updateMany(
      transforms.map((item) => ({ id: item.id, patch: item.patch })),
      label,
    );
  }

  /** Удержать объекты в границах страницы. */
  function clampToPage(page: number, geometry: PageGeometry): void {
    const items = objects.value.filter((obj) => obj.page === page);
    if (items.length === 0) return;
    const clamped = items.map((obj) => ({
      id: obj.id,
      patch: normalizeObjectToPage(obj, geometry, { clampToPage: true }) as ObjectPatch,
    }));
    const changed = clamped.some((item, index) => {
      const before = items[index];
      return (
        Math.abs((item.patch.x ?? before.x) - before.x) > 0.01 ||
        Math.abs((item.patch.y ?? before.y) - before.y) > 0.01
      );
    });
    if (changed) updateMany(clamped, 'Выравнивание по странице');
  }

  /* ======================== Группировка ======================== */

  function group(ids: readonly string[] = selectedIds.value): void {
    if (ids.length < 2) return;
    commit('Группировка');
    const groupId = `group_${Date.now().toString(36)}`;
    objects.value = objects.value.map((obj) =>
      ids.includes(obj.id) ? { ...obj, groupId } : obj,
    );
  }

  function ungroup(ids: readonly string[] = selectedIds.value): void {
    if (ids.length === 0) return;
    commit('Разгруппировка');
    objects.value = objects.value.map((obj) =>
      ids.includes(obj.id) ? { ...obj, groupId: null } : obj,
    );
  }

  /** Найти все объекты группы. */
  function groupMembers(id: string): string[] {
    const target = byId(id);
    if (!target?.groupId) return [id];
    return objects.value.filter((obj) => obj.groupId === target.groupId).map((obj) => obj.id);
  }

  /* ======================== Массовые операции ======================== */

  function setVisible(ids: readonly string[], visible: boolean): void {
    if (ids.length === 0) return;
    commit(visible ? 'Показать' : 'Скрыть');
    objects.value = objects.value.map((obj) =>
      ids.includes(obj.id) ? { ...obj, visible } : obj,
    );
  }

  function setLocked(ids: readonly string[], locked: boolean): void {
    if (ids.length === 0) return;
    commit(locked ? 'Заблокировать' : 'Разблокировать');
    objects.value = objects.value.map((obj) =>
      ids.includes(obj.id) ? { ...obj, locked } : obj,
    );
  }

  function setOpacity(ids: readonly string[], opacity: number): void {
    if (ids.length === 0) return;
    commit('Прозрачность');
    const value = Math.max(0, Math.min(1, opacity));
    objects.value = objects.value.map((obj) =>
      ids.includes(obj.id) ? { ...obj, opacity: value } : obj,
    );
  }

  function rename(id: string, name: string): void {
    update(id, { name }, 'Переименование');
  }

  /* ======================== Выравнивание ======================== */

  type AlignKind = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

  function align(kind: AlignKind, ids: readonly string[] = selectedIds.value): void {
    const items = objects.value.filter((obj) => ids.includes(obj.id));
    if (items.length < 2) return;
    const bounds = boundsOfTransforms(items);
    commit('Выравнивание');
    const patches = items.map((obj) => {
      switch (kind) {
        case 'left':
          return { id: obj.id, patch: { x: bounds.x } };
        case 'center':
          return { id: obj.id, patch: { x: bounds.x + bounds.width / 2 - obj.width / 2 } };
        case 'right':
          return { id: obj.id, patch: { x: bounds.x + bounds.width - obj.width } };
        case 'top':
          return { id: obj.id, patch: { y: bounds.y } };
        case 'middle':
          return { id: obj.id, patch: { y: bounds.y + bounds.height / 2 - obj.height / 2 } };
        case 'bottom':
        default:
          return { id: obj.id, patch: { y: bounds.y + bounds.height - obj.height } };
      }
    });
    updateMany(patches, 'Выравнивание');
  }

  /** Равномерное распределение по горизонтали/вертикали. */
  function distribute(axis: 'horizontal' | 'vertical', ids: readonly string[] = selectedIds.value): void {
    const items = objects.value.filter((obj) => ids.includes(obj.id));
    if (items.length < 3) return;
    const sorted = [...items].sort((a, b) => (axis === 'horizontal' ? a.x - b.x : a.y - b.y));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const totalSize = sorted.reduce(
      (sum, obj) => sum + (axis === 'horizontal' ? obj.width : obj.height),
      0,
    );
    const span =
      axis === 'horizontal'
        ? last.x + last.width - first.x
        : last.y + last.height - first.y;
    const gap = (span - totalSize) / (sorted.length - 1);
    let cursor = axis === 'horizontal' ? first.x : first.y;
    const patches: { id: string; patch: ObjectPatch }[] = [];
    for (const obj of sorted) {
      patches.push({
        id: obj.id,
        patch: axis === 'horizontal' ? { x: cursor } : { y: cursor },
      });
      cursor += (axis === 'horizontal' ? obj.width : obj.height) + gap;
    }
    updateMany(patches, 'Распределение');
  }

  return {
    // state
    objects,
    selectedIds,
    clipboard,
    // getters
    all,
    selectedObjects,
    hasSelection,
    selectionCount,
    selectionBounds,
    pagesWithObjects,
    totalVisible,
    hasClipboard,
    canUndo,
    canRedo,
    forPage,
    countForPage,
    byId,
    byType,
    nextZIndex,
    groupMembers,
    // history
    commit,
    undo,
    redo,
    // mutations
    add,
    update,
    updateMany,
    updatePayload,
    patchSilent,
    remove,
    removePage,
    clearAll,
    replaceAll,
    applyTransforms,
    clampToPage,
    // selection
    select,
    selectOne,
    selectAll,
    clearSelection,
    // z-index
    bringToFront,
    sendToBack,
    bringForward,
    sendBackward,
    // clipboard
    copy,
    cut,
    duplicate,
    paste,
    // transforms
    nudge,
    moveToPage,
    // groups
    group,
    ungroup,
    // bulk
    setVisible,
    setLocked,
    setOpacity,
    rename,
    align,
    distribute,
  };
});

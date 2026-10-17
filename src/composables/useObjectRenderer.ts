/**
 * ============================================================================
 *  Синхронизация объектов редактора с Konva-слоем.
 * ============================================================================
 *
 *  Узлы переиспользуются по id (создаются/обновляются/удаляются по мере
 *  необходимости), поэтому перетаскивание и трансформация не пересобирают
 *  слой целиком. Данные в стор попадают только по завершении жеста — это
 *  важно и для производительности, и для корректной истории (undo/redo).
 */

import Konva from 'konva';
import type { ShallowRef } from 'vue';
import type { EditorObject } from '@/types';
import type { Point } from '@/utils/geometry';
import { displayToLocal } from '@/utils/coordinates';
import { createObjectNode, syncObjectNode } from '@/services/konvaObjectFactory';
import { computeTextBlockLayout } from '@/services/textRenderService';
import { useEditorStore } from '@/stores/editor';
import { useObjectsStore } from '@/stores/objects';
import { useSettingsStore } from '@/stores/settings';

/** Публичный интерфейс рендера объектов. */
export interface ObjectRendererApi {
  sync: () => void;
  attachTransformer: () => void;
  /** Поиск объекта под точкой страницы (сверху вниз). */
  hitTest: (pagePoint: Point) => string | null;
  /** Выделение объекта под точкой. */
  selectAt: (pagePoint: Point, additive: boolean) => string | null;
  /** Начать жест (записывает снимок истории). */
  beginInteraction: (label: string) => void;
  /** Завершить трансформацию и записать данные в стор. */
  commitTransform: () => void;
  /** Завершить перетаскивание. */
  commitDrag: () => void;
  /** Узел по id объекта (для дополнительных сценариев). */
  nodeOf: (id: string) => Konva.Group | null;
}

export function useObjectRenderer(deps: {
  objectLayer: ShallowRef<Konva.Layer | null>;
  transformer: ShallowRef<Konva.Transformer | null>;
  screenToPage: (clientX: number, clientY: number) => Point;
}): ObjectRendererApi {
  const editor = useEditorStore();
  const objects = useObjectsStore();
  const settings = useSettingsStore();

  const nodes = new Map<string, Konva.Group>();

  interface DragState {
    id: string;
    start: Map<string, Point>;
    started: boolean;
  }
  let dragState: DragState | null = null;
  let transformSnapshot = new Map<string, { width: number; height: number }>();
  let transformerBound = false;

  /* ======================== Вспомогательные ======================== */

  function layer(): Konva.Layer | null {
    return deps.objectLayer.value;
  }

  function redraw(): void {
    layer()?.batchDraw();
  }

  /** Запись снимка истории перед жестом. */
  function beginInteraction(label: string): void {
    objects.commit(label);
  }

  /** Точка внутри объекта (с учётом поворота). */
  function pointInside(obj: EditorObject, pagePoint: Point): boolean {
    const local = displayToLocal(pagePoint, obj);
    return local.x >= 0 && local.x <= obj.width && local.y >= 0 && local.y <= obj.height;
  }

  /** Поиск объекта под точкой: сверху вниз по z-index. */
  function hitTest(pagePoint: Point): string | null {
    const list = objects
      .forPage(editor.currentPage)
      .filter((obj) => obj.visible)
      .slice()
      .reverse();
    for (const obj of list) {
      if (pointInside(obj, pagePoint)) return obj.id;
    }
    return null;
  }

  function selectAt(pagePoint: Point, additive: boolean): string | null {
    const id = hitTest(pagePoint);
    if (!id) {
      if (!additive) objects.clearSelection();
      return null;
    }
    const obj = objects.byId(id);
    if (!obj) return null;
    // Объекты одной группы выделяются вместе.
    const ids = obj.groupId ? objects.groupMembers(id) : [id];
    if (additive) {
      const next = new Set(objects.selectedIds);
      for (const item of ids) {
        if (next.has(item)) next.delete(item);
        else next.add(item);
      }
      objects.select(Array.from(next));
    } else {
      objects.select(ids);
    }
    return id;
  }

  /* ======================== Привязка событий узла ======================== */

  function bindNodeEvents(node: Konva.Group, objectId: string): void {
    node.on('pointerdown', () => {
      if (editor.tool !== 'select' || editor.viewOnly) return;
      // При клике вне текущего выделения — выделяем этот объект.
      if (!objects.selectedIds.includes(objectId)) {
        const obj = objects.byId(objectId);
        if (!obj) return;
        const ids = obj.groupId ? objects.groupMembers(objectId) : [objectId];
        objects.select(ids);
      }
    });

    node.on('mouseenter', () => {
      editor.hoveredObjectId = objectId;
    });
    node.on('mouseleave', () => {
      if (editor.hoveredObjectId === objectId) editor.hoveredObjectId = null;
    });

    node.on('dragstart', () => {
      if (editor.tool !== 'select' || editor.viewOnly) return;
      const selected = objects.selectedObjects.filter((obj) => !obj.locked);
      const ids = selected.length > 0 && selected.some((obj) => obj.id === objectId)
        ? selected.map((obj) => obj.id)
        : [objectId];
      beginInteraction('Перемещение');
      const start = new Map<string, Point>();
      for (const id of ids) {
        const target = nodes.get(id);
        if (target) start.set(id, { x: target.x(), y: target.y() });
      }
      dragState = { id: objectId, start, started: true };
    });

    node.on('dragmove', () => {
      const state = dragState;
      if (!state) return;
      const source = nodes.get(state.id);
      const initial = state.start.get(state.id);
      if (!source || !initial) return;

      // Konva каждый кадр выставляет позицию узла по указателю, поэтому
      // дельта считается от исходной позиции — накопления ошибки нет.
      let dx = source.x() - initial.x;
      let dy = source.y() - initial.y;

      // Прилипание к другим объектам, центру страницы и полям.
      if (settings.settings.snapToObjects || settings.settings.snapToGrid) {
        const snapped = computeSnap(state.id, initial, dx, dy);
        dx = snapped.dx;
        dy = snapped.dy;
        editor.setGuides(snapped.guides);
      }

      for (const [id, start] of state.start) {
        const target = nodes.get(id);
        if (!target) continue;
        target.position({ x: start.x + dx, y: start.y + dy });
      }
      redraw();
    });

    node.on('dragend', () => {
      if (!dragState) return;
      commitDrag();
    });
  }

  /** Проверка, применено ли уже прилипание (чтобы не зациклиться). */
  function snappedApplied(id: string, dx: number, dy: number): boolean {
    const node = nodes.get(id);
    const state = dragState;
    if (!node || !state) return false;
    const initial = state.start.get(id);
    if (!initial) return false;
    return Math.abs(node.x() - (initial.x + dx)) < 0.01 && Math.abs(node.y() - (initial.y + dy)) < 0.01;
  }
  void snappedApplied;

  /** Расчёт прилипания перетаскиваемого объекта. */
  function computeSnap(
    id: string,
    initial: Point,
    dx: number,
    dy: number,
  ): { dx: number; dy: number; guides: { x: number[]; y: number[] } } {
    const obj = objects.byId(id);
    const tolerance = 6 / Math.max(editor.zoom, 0.2);
    if (!obj) return { dx, dy, guides: { x: [], y: [] } };

    const pageSize = editor.pageSize;
    const candidatesX: number[] = [0, pageSize.width / 2, pageSize.width];
    const candidatesY: number[] = [0, pageSize.height / 2, pageSize.height];

    if (settings.settings.snapToObjects) {
      for (const other of objects.forPage(editor.currentPage)) {
        if (other.id === id || objects.selectedIds.includes(other.id)) continue;
        candidatesX.push(other.x, other.x + other.width / 2, other.x + other.width);
        candidatesY.push(other.y, other.y + other.height / 2, other.y + other.height);
      }
    }

    const x = initial.x + dx;
    const y = initial.y + dy;
    const width = obj.width * 1;
    const height = obj.height * 1;
    const edgesX = [x, x + width / 2, x + width];
    const edgesY = [y, y + height / 2, y + height];

    const guides: { x: number[]; y: number[] } = { x: [], y: [] };
    let bestDx = dx;
    let bestDistX = tolerance;
    edgesX.forEach((edge, index) => {
      for (const candidate of candidatesX) {
        const distance = Math.abs(edge - candidate);
        if (distance <= bestDistX) {
          bestDistX = distance;
          bestDx = dx + (candidate - edge);
          guides.x = [candidate];
          void index;
        }
      }
    });

    let bestDy = dy;
    let bestDistY = tolerance;
    edgesY.forEach((edge) => {
      for (const candidate of candidatesY) {
        const distance = Math.abs(edge - candidate);
        if (distance <= bestDistY) {
          bestDistY = distance;
          bestDy = dy + (candidate - edge);
          guides.y = [candidate];
        }
      }
    });

    if (settings.settings.snapToGrid && !guides.x.length && !guides.y.length) {
      const step = Math.max(1, settings.settings.gridSize);
      bestDx = Math.round(x / step) * step - initial.x;
      bestDy = Math.round(y / step) * step - initial.y;
    }

    return { dx: bestDx, dy: bestDy, guides };
  }

  /** Завершение перетаскивания: применяем позиции в стор. */
  function commitDrag(): void {
    const state = dragState;
    dragState = null;
    editor.clearGuides();
    if (!state) return;
    const patches: { id: string; patch: { x: number; y: number } }[] = [];
    for (const [id] of state.start) {
      const node = nodes.get(id);
      if (!node) continue;
      patches.push({ id, patch: { x: node.x(), y: node.y() } });
    }
    objects.updateMany(patches, 'Перемещение');
  }

  /** Завершение трансформации (масштаб/поворот). */
  function commitTransform(): void {
    const tr = deps.transformer.value;
    if (!tr) return;
    const patches: {
      id: string;
      patch: { x: number; y: number; rotation: number; width: number; height: number };
    }[] = [];

    for (const node of tr.nodes()) {
      if (!(node instanceof Konva.Group)) continue;
      const id = String(node.getAttr('objectId') ?? '');
      const obj = objects.byId(id);
      if (!obj) continue;
      const scaleX = node.scaleX();
      const scaleY = node.scaleY();
      const snapshot = transformSnapshot.get(id) ?? { width: obj.width, height: obj.height };
      node.scaleX(1);
      node.scaleY(1);
      patches.push({
        id,
        patch: {
          x: node.x(),
          y: node.y(),
          rotation: node.rotation(),
          width: Math.max(2, snapshot.width * scaleX),
          height: Math.max(2, snapshot.height * scaleY),
        },
      });
    }
    transformSnapshot = new Map();
    if (patches.length > 0) objects.updateMany(patches, 'Преобразование');
    // Дети пересобираются синхронизацией с новыми размерами.
    sync();
  }

  /* ======================== Синхронизация ======================== */

  function attachTransformer(): void {
    const tr = deps.transformer.value;
    if (!tr) return;

    if (!transformerBound) {
      tr.on('transformstart', () => {
        transformSnapshot = new Map(
          objects.selectedObjects.map((obj) => [obj.id, { width: obj.width, height: obj.height }]),
        );
        beginInteraction('Преобразование');
      });
      tr.on('transformend', () => commitTransform());
      transformerBound = true;
    }

    const selected = objects.selectedObjects.filter(
      (obj) => obj.page === editor.currentPage && !obj.locked,
    );
    const selectedNodes = selected
      .map((obj) => nodes.get(obj.id))
      .filter((node): node is Konva.Group => Boolean(node));
    tr.nodes(selectedNodes);
    tr.visible(selectedNodes.length > 0 && !editor.viewOnly);
    tr.rotateEnabled(selectedNodes.length > 0 && !editor.viewOnly);
    const keepRatio =
      selected.length > 0 &&
      selected.every((obj) => ['image', 'stamp', 'signature'].includes(obj.type));
    tr.keepRatio(keepRatio);
    // Ручки трансформации не должны перехватывать события инструментов рисования.
    tr.listening(editor.tool === 'select' && !editor.viewOnly);
    tr.forceUpdate();
  }

  function sync(): void {
    const currentLayer = layer();
    if (!currentLayer) return;
    const list = objects.forPage(editor.currentPage);
    const seen = new Set<string>();
    // Когда догрузился асинхронный ресурс (битмап картинки, метрики шрифта),
    // пересобираем узлы: просто перерисовать недостаточно — у Konva.Image
    // битмап хранится в атрибуте узла, а не разрешается при отрисовке.
    const onReady = (): void => sync();
    /** Тексты с автовысотой: подгоняем высоту объекта под содержимое. */
    const autoHeightFixes: { id: string; patch: { height: number } }[] = [];

    for (const obj of list) {
      seen.add(obj.id);
      let node = nodes.get(obj.id);
      if (!node || !node.getParent()) {
        node = createObjectNode(obj, { onReady });
        node.setAttr('objectId', obj.id);
        bindNodeEvents(node, obj.id);
        nodes.set(obj.id, node);
        currentLayer.add(node);
      } else {
        syncObjectNode(node, obj, { onReady });
      }
      node.draggable(editor.tool === 'select' && !obj.locked && !editor.viewOnly);
      node.listening(!editor.viewOnly || editor.tool === 'select');

      if (obj.type === 'text' && obj.payload.autoHeight) {
        const layout = computeTextBlockLayout(obj.payload, obj.width, obj.height);
        if (Math.abs(layout.boxHeight - obj.height) > 0.5) {
          autoHeightFixes.push({ id: obj.id, patch: { height: layout.boxHeight } });
        }
      }
    }

    for (const [id, node] of Array.from(nodes.entries())) {
      if (!seen.has(id)) {
        node.destroy();
        nodes.delete(id);
      }
    }

    // Порядок слоёв: узлы Konva рисуются в порядке добавления, поэтому после
    // изменения z-index («Поверх», «Вниз», «Выше», «Ниже», [ и ]) их нужно
    // переставить, иначе на экране ничего не меняется.
    const ordered = list
      .map((obj) => nodes.get(obj.id))
      .filter((node): node is Konva.Group => Boolean(node && node.getParent()));
    ordered.forEach((node, index) => {
      if (node.zIndex() !== index) node.zIndex(index);
    });

    // Тихая правка: не засоряет историю, но синхронизирует высоту объекта.
    for (const fix of autoHeightFixes) objects.patchSilent(fix.id, fix.patch);

    attachTransformer();
    deps.transformer.value?.moveToTop();
    redraw();
  }

  return {
    sync,
    attachTransformer,
    hitTest,
    selectAt,
    beginInteraction,
    commitTransform,
    commitDrag,
    nodeOf: (id: string) => nodes.get(id) ?? null,
  };
}

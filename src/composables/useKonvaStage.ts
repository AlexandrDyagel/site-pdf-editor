/**
 * ============================================================================
 *  Konva-сцена редактора: слои, зум/панорама, фон страницы, черновики.
 * ============================================================================
 *
 *  Слои:
 *   1. `backgroundLayer` — отрисованная страница PDF + подложка;
 *   2. `objectLayer`     — объекты редактора и Transformer (выделение);
 *   3. `overlayLayer`    — черновики: текущий штрих, резиновая рамка,
 *                          выделение области, направляющие, сетка.
 *
 *  Зум и панорама применяются к самой сцене (stage.scale/position), поэтому
 *  координаты объектов всегда остаются в PDF points.
 */

import Konva from 'konva';
import { onBeforeUnmount, ref, shallowRef, watch, type Ref, type ShallowRef } from 'vue';
import { useEditorStore } from '@/stores/editor';
import { useSettingsStore } from '@/stores/settings';
import type { Point } from '@/utils/geometry';
import {
  equilateralTriangleBox,
  normalizeRect,
  rectFromPoints,
  snapPointToAngle,
  squareFromPoints,
} from '@/utils/geometry';
import { ROTATE_CURSOR } from '@/utils/cursors';
import { normalizeSides, polygonPath } from '@/utils/shapePath';
import { paintStroke, paintStrokeFast } from '@/services/strokeService';

/** Публичный интерфейс сцены (все узлы — реактивные ссылки). */
export interface KonvaStageApi {
  stage: ShallowRef<Konva.Stage | null>;
  backgroundLayer: ShallowRef<Konva.Layer | null>;
  objectLayer: ShallowRef<Konva.Layer | null>;
  overlayLayer: ShallowRef<Konva.Layer | null>;
  transformer: ShallowRef<Konva.Transformer | null>;
  isReady: Ref<boolean>;
  size: Ref<{ width: number; height: number }>;
  pageSize: Ref<{ width: number; height: number }>;
  init: () => void;
  destroy: () => void;
  applyView: () => void;
  setBackground: (image: CanvasImageSource | null, width: number, height: number) => void;
  setBackgroundVisible: (visible: boolean) => void;
  screenToPage: (clientX: number, clientY: number) => Point;
  pageToScreen: (point: Point) => Point;
  requestDraw: () => void;
}

export function useKonvaStage(containerRef: Ref<HTMLDivElement | null>): KonvaStageApi {
  const editor = useEditorStore();
  const settings = useSettingsStore();

  const stage = shallowRef<Konva.Stage | null>(null);
  const backgroundLayer = shallowRef<Konva.Layer | null>(null);
  const objectLayer = shallowRef<Konva.Layer | null>(null);
  const overlayLayer = shallowRef<Konva.Layer | null>(null);
  const transformer = shallowRef<Konva.Transformer | null>(null);
  const pageRect = shallowRef<Konva.Rect | null>(null);
  const backgroundImage = shallowRef<Konva.Image | null>(null);
  const draftShape = shallowRef<Konva.Shape | null>(null);
  const guidesShape = shallowRef<Konva.Shape | null>(null);
  const gridShape = shallowRef<Konva.Shape | null>(null);

  const isReady = ref(false);
  const size = ref({ width: 0, height: 0 });
  const pageSize = ref({ width: 0, height: 0 });
  /** Последний запрошенный фон — применяется при инициализации сцены. */
  let pendingBackground: { image: CanvasImageSource | null; width: number; height: number } | null =
    null;

  let resizeObserver: ResizeObserver | null = null;

  /* ======================== Инициализация ======================== */

  function init(): void {
    const container = containerRef.value;
    if (!container || stage.value) return;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    const stageInstance = new Konva.Stage({
      container,
      width,
      height,
      listening: true,
    });

    const bgLayer = new Konva.Layer({ listening: false, name: 'background' });
    const objLayer = new Konva.Layer({ name: 'objects' });
    const ovLayer = new Konva.Layer({ name: 'overlay' });

    // Подложка страницы (белый лист с тенью).
    const rect = new Konva.Rect({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fill: '#ffffff',
      shadowColor: 'rgba(15, 23, 42, 0.45)',
      shadowBlur: 24,
      shadowOffsetY: 6,
      listening: false,
    });
    bgLayer.add(rect);

    const image = new Konva.Image({ image: undefined, x: 0, y: 0, listening: false });
    bgLayer.add(image);

    const grid = new Konva.Shape({
      listening: false,
      sceneFunc: (context) => {
        if (!settings.settings.showGrid) return;
        const ctx = (context as unknown as { _context: CanvasRenderingContext2D })._context;
        const step = Math.max(2, settings.settings.gridSize);
        ctx.save();
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.25)';
        ctx.lineWidth = 0.5 / Math.max(editor.zoom, 0.2);
        ctx.beginPath();
        for (let x = step; x < pageSize.value.width; x += step) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, pageSize.value.height);
        }
        for (let y = step; y < pageSize.value.height; y += step) {
          ctx.moveTo(0, y);
          ctx.lineTo(pageSize.value.width, y);
        }
        ctx.stroke();
        ctx.restore();
      },
    });
    ovLayer.add(grid);

    // Черновики: штрих, рамка, выделение области.
    const draft = new Konva.Shape({
      listening: false,
      sceneFunc: (context) => {
        const ctx = (context as unknown as { _context: CanvasRenderingContext2D })._context;
        paintDrafts(ctx);
      },
    });
    ovLayer.add(draft);

    const guides = new Konva.Shape({
      listening: false,
      sceneFunc: (context) => {
        const ctx = (context as unknown as { _context: CanvasRenderingContext2D })._context;
        const { x, y } = editor.guideLines;
        if (x.length === 0 && y.length === 0) return;
        ctx.save();
        ctx.strokeStyle = '#f43f5e';
        ctx.lineWidth = 1 / Math.max(editor.zoom, 0.2);
        ctx.setLineDash([6 / Math.max(editor.zoom, 0.2), 4 / Math.max(editor.zoom, 0.2)]);
        ctx.beginPath();
        for (const lineX of x) {
          ctx.moveTo(lineX, -4000);
          ctx.lineTo(lineX, 4000);
        }
        for (const lineY of y) {
          ctx.moveTo(-4000, lineY);
          ctx.lineTo(4000, lineY);
        }
        ctx.stroke();
        ctx.restore();
      },
    });
    ovLayer.add(guides);

    // Transformer для выделения объектов.
    const tr = new Konva.Transformer({
      name: 'transformer',
      rotateEnabled: true,
      // Над объектом — круглая стрелка «поворот», а не крестик по умолчанию.
      rotateAnchorCursor: ROTATE_CURSOR,
      borderStroke: '#355ef0',
      borderStrokeWidth: 1.2,
      anchorStroke: '#355ef0',
      anchorFill: '#ffffff',
      anchorSize: 8,
      anchorCornerRadius: 2,
      rotateAnchorOffset: 22,
      padding: 2,
      ignoreStroke: true,
      flipEnabled: false,
      boundBoxFunc: (oldBox, newBox) => {
        if (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4) return oldBox;
        return newBox;
      },
    });
    objLayer.add(tr);

    stage.value = stageInstance;
    backgroundLayer.value = bgLayer;
    objectLayer.value = objLayer;
    overlayLayer.value = ovLayer;
    transformer.value = tr;
    pageRect.value = rect;
    backgroundImage.value = image;
    draftShape.value = draft;
    guidesShape.value = guides;
    gridShape.value = grid;
    size.value = { width, height };
    editor.setViewportSize(width, height);

    // Слои обязательно подключаем к сцене: без этого Konva не создаёт
    // canvas-элементы, и рабочая область остаётся пустой.
    stageInstance.add(bgLayer);
    stageInstance.add(objLayer);
    stageInstance.add(ovLayer);

    // Контейнер просто обязан быть позиционирован.
    container.style.position = 'relative';

    resizeObserver = new ResizeObserver(() => {
      const target = containerRef.value;
      if (!target || !stage.value) return;
      const nextWidth = Math.max(1, target.clientWidth);
      const nextHeight = Math.max(1, target.clientHeight);
      size.value = { width: nextWidth, height: nextHeight };
      stage.value.size({ width: nextWidth, height: nextHeight });
      editor.setViewportSize(nextWidth, nextHeight);
      requestDraw();
    });
    resizeObserver.observe(container);

    applyView();
    isReady.value = true;

    // Только для разработки и автотестов: доступ к сцене из консоли.
    // Позволяет проверять положение узлов и ручек трансформации.
    if (import.meta.env.DEV) {
      (window as unknown as { __PDF_EDITOR_STAGE__?: unknown }).__PDF_EDITOR_STAGE__ = stageInstance;
    }

    if (pendingBackground) {
      setBackground(
        pendingBackground.image,
        pendingBackground.width,
        pendingBackground.height,
      );
    }
  }

  function destroy(): void {
    resizeObserver?.disconnect();
    resizeObserver = null;
    stage.value?.destroy();
    stage.value = null;
    backgroundLayer.value = null;
    objectLayer.value = null;
    overlayLayer.value = null;
    transformer.value = null;
    isReady.value = false;
  }

  /* ======================== Отрисовка черновиков ======================== */

  function paintDrafts(ctx: CanvasRenderingContext2D): void {
    // Текущий штрих.
    const stroke = editor.activeStroke;
    if (stroke && stroke.points.length > 0) {
      // Корректоры заливают сразу за курсором: для них быстрый путь отрисовки.
      const isMasking = stroke.tool === 'eraser' || stroke.tool === 'smart-eraser';
      if (isMasking) paintStrokeFast(ctx, stroke);
      else paintStroke(ctx, stroke);
    }

    // Резиновая рамка инструмента.
    const draft = editor.shapeDraft;
    if (draft) {
      const tool = editor.tool;
      // Shift: у линий и стрелок — угол 45°, у фигур — квадрат. Предпросмотр
      // показывает ровно то, что получится после отпускания мыши.
      const endPoint = draft.constrained ? snapPointToAngle(draft.start, draft.end) : draft.end;
      const rect =
        draft.constrained && tool !== 'line' && tool !== 'arrow'
          ? tool === 'triangle'
            ? equilateralTriangleBox(draft.start, draft.end)
            : squareFromPoints(draft.start, draft.end)
          : normalizeRect(rectFromPoints(draft.start, draft.end));
      // «Без цвета» (stroke: null) — для резиновой рамки берём нейтральный цвет,
      // иначе контур черновика был бы невидим.
      const draftStroke = editor.toolOptions.shape.stroke ?? '#94a3b8';
      ctx.save();
      if (tool === 'whiteout') {
        ctx.fillStyle = editor.toolOptions.whiteout.color;
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        ctx.strokeStyle = 'rgba(53, 94, 240, 0.9)';
        ctx.lineWidth = 1 / Math.max(editor.zoom, 0.2);
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      } else if (tool === 'line' || tool === 'arrow') {
        ctx.strokeStyle = draftStroke;
        ctx.lineWidth = editor.toolOptions.shape.strokeWidth;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(draft.start.x, draft.start.y);
        ctx.lineTo(endPoint.x, endPoint.y);
        ctx.stroke();
      } else {
        ctx.strokeStyle = draftStroke;
        ctx.lineWidth = Math.max(1, editor.toolOptions.shape.strokeWidth);
        ctx.setLineDash([6 / Math.max(editor.zoom, 0.2), 4 / Math.max(editor.zoom, 0.2)]);
        if (tool === 'ellipse') {
          ctx.beginPath();
          ctx.ellipse(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
            Math.abs(rect.width) / 2,
            Math.abs(rect.height) / 2,
            0,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        } else if (tool === 'triangle' || tool === 'polygon') {
          // Контур черновика совпадает с будущей фигурой, а не с рамкой.
          const sides = tool === 'triangle' ? 3 : normalizeSides(editor.toolOptions.shape.sides);
          const path = polygonPath(rect.width, rect.height, sides, editor.toolOptions.shape.cornerRadius);
          ctx.save();
          ctx.translate(rect.x, rect.y);
          ctx.stroke(new Path2D(path));
          ctx.restore();
        } else {
          ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        }
      }
      ctx.restore();
    }

    // Выделение области.
    const marquee = editor.marquee;
    if (marquee) {
      const rect = normalizeRect(marquee);
      ctx.save();
      ctx.fillStyle = 'rgba(53, 94, 240, 0.12)';
      ctx.strokeStyle = 'rgba(53, 94, 240, 0.9)';
      ctx.lineWidth = 1 / Math.max(editor.zoom, 0.2);
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }

    if (editor.cursorPosition && (editor.tool === 'text' || editor.tool === 'stamp')) {
      // Небольшой маркер точки вставки.
      const position = editor.cursorPosition;
      ctx.save();
      ctx.strokeStyle = 'rgba(53, 94, 240, 0.8)';
      ctx.lineWidth = 1 / Math.max(editor.zoom, 0.2);
      const radius = 6 / Math.max(editor.zoom, 0.2);
      ctx.beginPath();
      ctx.moveTo(position.x - radius, position.y);
      ctx.lineTo(position.x + radius, position.y);
      ctx.moveTo(position.x, position.y - radius);
      ctx.lineTo(position.x, position.y + radius);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ======================== Вид ======================== */

  function applyView(): void {
    const instance = stage.value;
    if (!instance) return;
    instance.scale({ x: editor.zoom, y: editor.zoom });
    instance.position({ x: editor.pan.x, y: editor.pan.y });
    instance.batchDraw();
  }

  function requestDraw(): void {
    stage.value?.batchDraw();
  }

  /** Установка фона страницы. */
  function setBackground(image: CanvasImageSource | null, width: number, height: number): void {
    pendingBackground = { image, width, height };
    pageSize.value = { width, height };
    const rect = pageRect.value;
    const node = backgroundImage.value;
    if (rect) {
      rect.size({ width, height });
    }
    if (node) {
      node.size({ width, height });
      node.image(image ?? undefined);
      node.visible(Boolean(image));
    }
    requestDraw();
  }

  function setBackgroundVisible(visible: boolean): void {
    pageRect.value?.visible(visible);
    requestDraw();
  }

  /* ======================== Координаты ======================== */

  /** Экранные координаты (clientX/Y) → координаты страницы (pt). */
  function screenToPage(clientX: number, clientY: number): Point {
    const instance = stage.value;
    if (!instance) return { x: 0, y: 0 };
    const rect = instance.container().getBoundingClientRect();
    return {
      x: (clientX - rect.left - editor.pan.x) / editor.zoom,
      y: (clientY - rect.top - editor.pan.y) / editor.zoom,
    };
  }

  /** Координаты страницы → экранные (clientX/Y). */
  function pageToScreen(point: Point): Point {
    const instance = stage.value;
    if (!instance) return { x: 0, y: 0 };
    const rect = instance.container().getBoundingClientRect();
    return {
      x: point.x * editor.zoom + editor.pan.x + rect.left,
      y: point.y * editor.zoom + editor.pan.y + rect.top,
    };
  }

  /* ======================== Реактивность ======================== */

  watch(
    () => [editor.zoom, editor.pan.x, editor.pan.y] as const,
    () => applyView(),
  );

  watch(
    () => [editor.activeStroke, editor.shapeDraft, editor.marquee, editor.cursorPosition, editor.guideLines] as const,
    () => requestDraw(),
    { deep: true },
  );

  watch(
    () => [settings.settings.showGrid, settings.settings.gridSize, editor.zoom] as const,
    () => requestDraw(),
  );

  onBeforeUnmount(() => destroy());

  return {
    stage,
    backgroundLayer,
    objectLayer,
    overlayLayer,
    transformer,
    isReady,
    size,
    pageSize,
    init,
    destroy,
    applyView,
    setBackground,
    setBackgroundVisible,
    screenToPage,
    pageToScreen,
    requestDraw,
  };
}

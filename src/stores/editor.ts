/**
 * ============================================================================
 *  Состояние редактора: активный инструмент, параметры, зум и панорама,
 *  незавершённые операции (штрих, рамка, выделение).
 * ============================================================================
 *
 *  Важно: зум и панорамирование влияют только на отображение. Координаты
 *  объектов всегда хранятся в PDF points (см. `@/utils/coordinates`).
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP } from '@/constants';
import type {
  ArrowHead,
  DrawTool,
  MarqueeRect,
  SmartEraseMode,
  SmartEraseSettings,
  StrokeData,
  StrokePoint,
  TextAlign,
  ToolType,
} from '@/types';
import { clamp, type Point } from '@/utils/geometry';
import type { TextDefaults } from '@/services/objectFactory';
import { usePdfStore } from '@/stores/pdf';

/** Параметры инструментов. */
export interface EditorToolOptions {
  draw: { color: string; width: number; opacity: number; smooth: boolean };
  marker: { color: string; width: number; opacity: number };
  eraser: { color: string; width: number };
  smartEraser: SmartEraseSettings & { width: number };
  shape: {
    stroke: string | null;
    strokeWidth: number;
    fill: string | null;
    dash: number[];
    cornerRadius: number;
    /** Число сторон многоугольника (инструмент «Многоугольник»). */
    sides: number;
    arrowHead: ArrowHead;
  };
  text: TextDefaults & { align: TextAlign; bold: boolean; italic: boolean };
  whiteout: { color: string };
  highlight: { color: string };
  lastStampId: string | null;
  lastSignatureId: string | null;
  lastDrawingId: string | null;
}

/** Черновик фигуры (резиновая рамка). */
export interface ShapeDraft {
  start: Point;
  end: Point;
  /** Для линий/стрелок — привязка к сетке углов при Shift. */
  constrained: boolean;
}

export const useEditorStore = defineStore('editor', () => {
  const pdf = usePdfStore();

  const tool = ref<ToolType>('select');
  const previousTool = ref<ToolType>('select');
  const currentPage = ref(0);
  const zoom = ref(1);
  const pan = ref<Point>({ x: 0, y: 0 });
  const viewport = ref<{ width: number; height: number }>({ width: 0, height: 0 });

  /** Режим только для чтения (просмотр). */
  const viewOnly = ref(false);
  /** Пробел зажат — временная панорама. */
  const spacePressed = ref(false);
  /** Зажат Ctrl/Shift для дополнительных режимов. */
  const shiftPressed = ref(false);

  const editingTextId = ref<string | null>(null);
  /** Куда поставить каретку при входе в редактирование (позиция в тексте). */
  const textCaretOffset = ref<number | null>(null);
  const hoveredObjectId = ref<string | null>(null);
  const cursorPosition = ref<Point | null>(null);

  const activeStroke = ref<StrokeData | null>(null);
  const shapeDraft = ref<ShapeDraft | null>(null);
  const marquee = ref<MarqueeRect | null>(null);
  const guideLines = ref<{ x: number[]; y: number[] }>({ x: [], y: [] });

  const toolOptions = ref<EditorToolOptions>({
    draw: { color: '#1d4ed8', width: 2, opacity: 1, smooth: true },
    marker: { color: '#facc15', width: 12, opacity: 0.35 },
    eraser: { color: '#ffffff', width: 16 },
    smartEraser: {
      color: '#ffffff',
      width: 18,
      threshold: 170,
      autoColor: true,
      eraseAll: false,
      targetColor: null,
      colorTolerance: 22,
      mode: 'erase-all' as SmartEraseMode,
    },
    shape: {
      stroke: '#dc2626',
      strokeWidth: 2,
      fill: null,
      dash: [],
      cornerRadius: 0,
      sides: 5,
      arrowHead: 'end',
    },
    text: {
      fontId: 'pt-sans',
      fontFamily: 'PT Sans',
      fontSize: 14,
      color: '#111827',
      align: 'left',
      bold: false,
      italic: false,
      lineHeight: 1.25,
      letterSpacing: 0,
    },
    whiteout: { color: '#ffffff' },
    highlight: { color: '#facc15' },
    lastStampId: null,
    lastSignatureId: null,
    lastDrawingId: null,
  });

  /* ======================== Геттеры ======================== */

  const zoomPercent = computed(() => Math.round(zoom.value * 100));
  const isDrawingTool = computed(() =>
    ['brush', 'marker', 'eraser', 'smart-eraser'].includes(tool.value),
  );
  const isShapeTool = computed(() =>
    ['rect', 'ellipse', 'triangle', 'polygon', 'line', 'arrow', 'whiteout'].includes(tool.value),
  );
  const isSelectTool = computed(() => tool.value === 'select');
  const isPanTool = computed(() => tool.value === 'pan' || spacePressed.value);
  const pageSize = computed(() => pdf.displaySize(currentPage.value));

  /** Активный цвет инструмента рисования. */
  const activeDrawStyle = computed<{ tool: DrawTool; color: string; width: number; opacity: number }>(
    () => {
      switch (tool.value) {
        case 'marker':
          return {
            tool: 'marker',
            color: toolOptions.value.marker.color,
            width: toolOptions.value.marker.width,
            opacity: toolOptions.value.marker.opacity,
          };
        case 'eraser':
          return {
            tool: 'eraser',
            color: toolOptions.value.eraser.color,
            width: toolOptions.value.eraser.width,
            opacity: 1,
          };
        case 'smart-eraser':
          return {
            tool: 'smart-eraser',
            color: toolOptions.value.smartEraser.color,
            width: toolOptions.value.smartEraser.width,
            opacity: 1,
          };
        case 'brush':
        default:
          return {
            tool: 'brush',
            color: toolOptions.value.draw.color,
            width: toolOptions.value.draw.width,
            opacity: toolOptions.value.draw.opacity,
          };
      }
    },
  );

  /* ======================== Инструменты ======================== */

  function setTool(next: ToolType): void {
    if (next === tool.value) return;
    previousTool.value = tool.value;
    tool.value = next;
    cancelDrafts();
    if (next !== 'select') stopTextEditing();
  }

  /**
   * Начать редактирование текста прямо на холсте.
   *
   * `caret` — позиция каретки в тексте (при клике по готовому тексту она равна
   * месту нажатия, при создании нового — 0).
   */
  function startTextEditing(id: string, caret: number | null = null): void {
    textCaretOffset.value = caret;
    editingTextId.value = id;
  }

  /** Закончить редактирование текста. */
  function stopTextEditing(): void {
    editingTextId.value = null;
    textCaretOffset.value = null;
  }

  function restorePreviousTool(): void {
    setTool(previousTool.value);
  }

  function cancelDrafts(): void {
    activeStroke.value = null;
    shapeDraft.value = null;
    marquee.value = null;
    guideLines.value = { x: [], y: [] };
  }

  /**
   * Синхронизация параметров текста со значениями по умолчанию из настроек.
   * Вызывается при запуске и при изменении шрифта/размера/цвета в настройках,
   * иначе новые текстовые объекты игнорировали бы выбранный пользователем шрифт.
   */
  function syncTextDefaults(defaults: Partial<TextDefaults>): void {
    toolOptions.value.text = {
      ...toolOptions.value.text,
      ...defaults,
    };
  }

  /** Синхронизация параметров фигур и рисования из настроек. */
  function syncDrawingDefaults(options: {
    stroke?: string;
    strokeWidth?: number;
    whiteout?: string;
    highlight?: string;
  }): void {
    if (options.stroke) {
      toolOptions.value.draw.color = options.stroke;
      toolOptions.value.shape.stroke = options.stroke;
    }
    if (typeof options.strokeWidth === 'number') {
      toolOptions.value.draw.width = options.strokeWidth;
      toolOptions.value.shape.strokeWidth = options.strokeWidth;
    }
    if (options.whiteout) toolOptions.value.whiteout.color = options.whiteout;
    if (options.highlight) toolOptions.value.highlight.color = options.highlight;
  }

  /* ======================== Зум и панорама ======================== */

  /** Установка зума с сохранением точки под курсором. */
  function setZoom(next: number, focus?: Point): void {
    const value = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (focus) {
      const scale = value / zoom.value;
      pan.value = {
        x: focus.x - (focus.x - pan.value.x) * scale,
        y: focus.y - (focus.y - pan.value.y) * scale,
      };
    }
    zoom.value = value;
  }

  function zoomIn(focus?: Point): void {
    setZoom(zoom.value * ZOOM_STEP, focus);
  }

  function zoomOut(focus?: Point): void {
    setZoom(zoom.value / ZOOM_STEP, focus);
  }

  function setZoomPercent(percent: number, focus?: Point): void {
    setZoom(percent / 100, focus);
  }

  function setPan(next: Point): void {
    pan.value = { ...next };
  }

  function panBy(dx: number, dy: number): void {
    pan.value = { x: pan.value.x + dx, y: pan.value.y + dy };
  }

  function setViewportSize(width: number, height: number): void {
    viewport.value = { width, height };
  }

  /** Центрирование текущей страницы по вертикали и горизонтали. */
  function centerPage(): void {
    const size = pageSize.value;
    const scaledWidth = size.width * zoom.value;
    const scaledHeight = size.height * zoom.value;
    pan.value = {
      x: Math.max(16, (viewport.value.width - scaledWidth) / 2),
      y: Math.max(16, (viewport.value.height - scaledHeight) / 2),
    };
  }

  /** Вписать страницу по ширине. */
  function fitToWidth(): void {
    const size = pageSize.value;
    if (!viewport.value.width || !size.width) return;
    const padding = 48;
    const value = clamp((viewport.value.width - padding) / size.width, MIN_ZOOM, MAX_ZOOM);
    zoom.value = value;
    centerPage();
  }

  /** Вписать страницу целиком. */
  function fitToPage(): void {
    const size = pageSize.value;
    if (!viewport.value.width || !size.width) return;
    const padding = 48;
    const scaleX = (viewport.value.width - padding) / size.width;
    const scaleY = (viewport.value.height - padding) / size.height;
    zoom.value = clamp(Math.min(scaleX, scaleY), MIN_ZOOM, MAX_ZOOM);
    centerPage();
  }

  /** Масштаб 100%. */
  function actualSize(): void {
    setZoom(1);
    centerPage();
  }

  /** Полный сброс вида. */
  function resetView(): void {
    zoom.value = 1;
    centerPage();
  }

  /* ======================== Страницы ======================== */

  function setCurrentPage(index: number, options: { resetView?: boolean } = {}): void {
    const total = pdf.pageCount;
    const next = clamp(Math.round(index), 0, Math.max(0, total - 1));
    currentPage.value = next;
    if (options.resetView) centerPage();
  }

  function nextPage(): void {
    setCurrentPage(currentPage.value + 1);
  }

  function previousPage(): void {
    setCurrentPage(currentPage.value - 1);
  }

  function firstPage(): void {
    setCurrentPage(0);
  }

  function lastPage(): void {
    setCurrentPage(pdf.pageCount - 1);
  }

  /* ======================== Незавершённые операции ======================== */

  function startStroke(point: StrokePoint): void {
    const style = activeDrawStyle.value;
    activeStroke.value = {
      tool: style.tool,
      color: style.color,
      width: style.width,
      opacity: style.opacity,
      points: [point],
      smooth: toolOptions.value.draw.smooth,
    };
  }

  function appendStrokePoint(point: StrokePoint): void {
    const stroke = activeStroke.value;
    if (!stroke) return;
    const last = stroke.points[stroke.points.length - 1];
    // Отбрасываем слишком близкие точки: меньше данных — быстрее рендер.
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.35 && stroke.points.length > 2) {
      return;
    }
    stroke.points.push(point);
  }

  function takeStroke(): StrokeData | null {
    const stroke = activeStroke.value;
    activeStroke.value = null;
    return stroke;
  }

  function startShapeDraft(start: Point): void {
    shapeDraft.value = { start, end: { ...start }, constrained: false };
  }

  function updateShapeDraft(end: Point, constrained = false): void {
    if (!shapeDraft.value) return;
    shapeDraft.value = { start: shapeDraft.value.start, end, constrained };
  }

  function takeShapeDraft(): ShapeDraft | null {
    const draft = shapeDraft.value;
    shapeDraft.value = null;
    return draft;
  }

  function setMarquee(rect: MarqueeRect | null): void {
    marquee.value = rect;
  }

  function setGuides(guides: { x: number[]; y: number[] }): void {
    guideLines.value = guides;
  }

  function clearGuides(): void {
    guideLines.value = { x: [], y: [] };
  }

  return {
    // state
    tool,
    previousTool,
    currentPage,
    zoom,
    pan,
    viewport,
    viewOnly,
    spacePressed,
    shiftPressed,
    editingTextId,
    textCaretOffset,
    hoveredObjectId,
    cursorPosition,
    activeStroke,
    shapeDraft,
    marquee,
    guideLines,
    toolOptions,
    // getters
    zoomPercent,
    isDrawingTool,
    isShapeTool,
    isSelectTool,
    isPanTool,
    pageSize,
    activeDrawStyle,
    // actions
    setTool,
    startTextEditing,
    stopTextEditing,
    restorePreviousTool,
    cancelDrafts,
    syncTextDefaults,
    syncDrawingDefaults,
    setZoom,
    zoomIn,
    zoomOut,
    setZoomPercent,
    setPan,
    panBy,
    setViewportSize,
    centerPage,
    fitToWidth,
    fitToPage,
    actualSize,
    resetView,
    setCurrentPage,
    nextPage,
    previousPage,
    firstPage,
    lastPage,
    startStroke,
    appendStrokePoint,
    takeStroke,
    startShapeDraft,
    updateShapeDraft,
    takeShapeDraft,
    setMarquee,
    setGuides,
    clearGuides,
  };
});

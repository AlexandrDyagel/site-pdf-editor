<script setup lang="ts">
/**
 * Рабочая область редактора: Konva-сцена, фон страницы, объекты и черновики.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useKonvaStage } from '@/composables/useKonvaStage';
import { usePdfPage } from '@/composables/usePdfPage';
import { useObjectRenderer } from '@/composables/useObjectRenderer';
import { useEditorTools } from '@/composables/useEditorTools';
import { useEditorStore } from '@/stores/editor';
import { useObjectsStore } from '@/stores/objects';
import { usePdfStore } from '@/stores/pdf';
import { useSettingsStore } from '@/stores/settings';
import TextInlineEditor from '@/components/editor/TextInlineEditor.vue';
import {
  bindEyedropperStage,
  cancelEyedropper,
  isEyedropperActive,
  onEyedropperChange,
  readColorAt,
  resolveEyedropper,
} from '@/services/eyedropperService';

const editor = useEditorStore();
const objects = useObjectsStore();
const pdf = usePdfStore();
const settings = useSettingsStore();

const container = ref<HTMLDivElement | null>(null);

const stageApi = useKonvaStage(container);

const pdfPage = usePdfPage({
  setBackground: (image, width, height) => stageApi.setBackground(image, width, height),
});

const renderer = useObjectRenderer({
  objectLayer: stageApi.objectLayer,
  transformer: stageApi.transformer,
  screenToPage: (x, y) => stageApi.screenToPage(x, y),
});

const tools = useEditorTools({
  screenToPage: (x, y) => stageApi.screenToPage(x, y),
  renderer,
});

/** Класс курсора под активный инструмент. */
const cursorClass = computed(() => {
  if (editor.viewOnly) return 'canvas-pan';
  if (editor.isPanTool) return tools.isPanning.value ? 'canvas-pan-active' : 'canvas-pan';
  if (editor.tool === 'select') return 'cursor-default';
  if (editor.tool === 'text') return 'canvas-text';
  // Для кисти, маркера и корректора курсор рисуем сами — кружком по размеру.
  if (BRUSH_TOOLS.has(editor.tool)) return 'canvas-brush';
  return 'canvas-draw';
});

/* ======================== Курсор-кружок кисти ======================== */

/** Инструменты, у которых есть размер кисти. */
const BRUSH_TOOLS = new Set(['brush', 'marker', 'eraser', 'smart-eraser']);

/** Положение указателя внутри рабочей области (в пикселях экрана). */
const pointer = ref<{ x: number; y: number } | null>(null);

/** Текущий размер кисти в точках страницы. */
const brushWidth = computed(() => {
  const options = editor.toolOptions;
  // У инструмента «Кисть» настройки лежат в разделе draw.
  if (editor.tool === 'brush') return options.draw.width;
  if (editor.tool === 'marker') return options.marker.width;
  if (editor.tool === 'eraser') return options.eraser.width;
  if (editor.tool === 'smart-eraser') return options.smartEraser.width;
  return 0;
});

/** Показывать ли кружок вместо системного курсора. */
const showBrushCursor = computed(
  () =>
    BRUSH_TOOLS.has(editor.tool) &&
    !editor.viewOnly &&
    !editor.spacePressed &&
    !tools.isPanning.value &&
    pointer.value !== null,
);

/** Кружок соответствует размеру кисти с учётом масштаба. */
const brushCursorStyle = computed(() => {
  const diameter = Math.max(4, brushWidth.value * editor.zoom);
  return {
    width: `${diameter}px`,
    height: `${diameter}px`,
    left: `${pointer.value?.x ?? 0}px`,
    top: `${pointer.value?.y ?? 0}px`,
  };
});

function onPointerMove(event: PointerEvent): void {
  const element = event.currentTarget as HTMLElement | null;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  pointer.value = { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function onPointerLeave(): void {
  pointer.value = null;
}

/** Фон рабочей области. */
const backgroundClass = computed(() => {
  switch (settings.settings.canvasBackground) {
    case 'light':
      return 'bg-slate-200';
    case 'checker':
      return 'bg-slate-300 checker-bg';
    case 'dark':
    default:
      return 'bg-slate-800 dark:bg-slate-900';
  }
});

/** Пипетка: активна ли и какой цвет сейчас под курсором. */
const eyedropperActive = ref(false);
const eyedropperPreview = ref('#ffffff');

onEyedropperChange(() => {
  const wasActive = eyedropperActive.value;
  eyedropperActive.value = isEyedropperActive();
  if (!eyedropperActive.value && wasActive) eyedropperPreview.value = '#ffffff';
});

/**
 * Клик пипеткой перехватывается до Konva (фаза перехвата), иначе клик создал бы
 * объект или начал штрих.
 */
function onEyedropperPointerDown(event: PointerEvent): void {
  if (!isEyedropperActive()) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  resolveEyedropper(event.clientX, event.clientY);
}

function onEyedropperPointerMove(event: PointerEvent): void {
  if (!isEyedropperActive()) return;
  const color = readColorAt(event.clientX, event.clientY);
  if (color) eyedropperPreview.value = color;
}

function bindStage(): void {
  const stage = stageApi.stage.value;
  if (!stage) return;
  bindEyedropperStage(stage);
  const element = container.value;
  if (element) {
    element.addEventListener('pointerdown', onEyedropperPointerDown, true);
    element.addEventListener('pointermove', onEyedropperPointerMove, true);
  }
  stage.on('pointerdown', tools.onPointerDown);
  stage.on('pointermove', tools.onPointerMove);
  stage.on('pointerup', tools.onPointerUp);
  stage.on('pointerupoutside', tools.onPointerUp);
  // Отмена указателя (например, жестом системы) тоже завершает жест.
  stage.on('pointercancel', tools.onPointerUp);
  stage.on('dblclick', tools.onDoubleClick);
  stage.on('wheel', tools.onWheel);
  // Правая кнопка мыши: контекстное меню объекта (Сгруппировать / Удалить).
  stage.on('contextmenu', tools.onContextMenu);
}

onMounted(() => {
  stageApi.init();
  bindStage();
  renderer.sync();
});

onBeforeUnmount(() => {
  cancelEyedropper();
  bindEyedropperStage(null);
  const element = container.value;
  if (element) {
    element.removeEventListener('pointerdown', onEyedropperPointerDown, true);
    element.removeEventListener('pointermove', onEyedropperPointerMove, true);
  }
  stageApi.destroy();
});

// Синхронизация объектов при изменении данных, страницы, инструмента.
// Пробел (панорамирование) тоже в списке: пока он зажат, объекты нельзя
// перетаскивать, и это нужно применить к узлам сразу.
watch(
  () =>
    [objects.objects, editor.currentPage, editor.tool, editor.viewOnly, editor.isPanTool] as const,
  () => renderer.sync(),
);

// Синхронизация выделения.
watch(
  () => objects.selectedIds,
  () => renderer.attachTransformer(),
  { deep: true },
);

// Перерисовка при смене страницы/документа (фон подтягивает usePdfPage).
watch(
  () => pdf.isLoaded,
  () => renderer.sync(),
);
</script>

<template>
  <div
    class="relative h-full w-full overflow-hidden"
    :class="[backgroundClass, cursorClass, eyedropperActive ? 'eyedropper-active cursor-crosshair' : '']"
    data-testid="editor-canvas"
    @pointermove="onPointerMove"
    @pointerdown="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <div ref="container" class="absolute inset-0" />

    <!-- Пипетка: подсказка и цвет под курсором -->
    <div
      v-if="eyedropperActive"
      class="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-xl border border-brand-300/70 bg-white/95 px-3 py-2 text-[11px] text-slate-700 shadow-floating dark:border-brand-500/40 dark:bg-slate-900/95 dark:text-slate-200"
      data-testid="eyedropper-hint"
    >
      <span class="flex items-center gap-2">
        <span
          class="h-4 w-4 rounded ring-1 ring-inset ring-slate-900/20"
          :style="{ backgroundColor: eyedropperPreview }"
        />
        <span class="font-mono uppercase">{{ eyedropperPreview }}</span>
        <span class="text-slate-400">· клик по холсту — взять цвет · Esc — отмена</span>
      </span>
    </div>

    <!-- Редактирование текста на холсте: каретка, ввод, рост рамки -->
    <TextInlineEditor />

    <!-- Курсор кисти: кружок по размеру выбранного инструмента -->
    <div
      v-if="showBrushCursor && !eyedropperActive"
      class="brush-cursor pointer-events-none absolute z-10 rounded-full"
      :style="brushCursorStyle"
      data-testid="brush-cursor"
    >
      <span class="brush-cursor-dot" />
    </div>

    <!-- Индикатор отрисовки страницы -->
    <div
      v-if="pdfPage.isRendering.value"
      class="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-slate-900/80 px-3 py-1 text-[11px] text-white shadow-floating"
    >
      Отрисовка страницы…
    </div>

    <!-- Подсказка о пустой странице -->
    <div
      v-if="pdf.isLoaded && objects.countForPage(editor.currentPage) === 0 && !editor.viewOnly"
      class="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-slate-900/75 px-3 py-1.5 text-[11px] text-white shadow-floating"
    >
      Выберите инструмент и добавьте объект: текст, фигура, подпись, штамп
    </div>
  </div>
</template>

<style scoped>
/* Пока включена пипетка, системный курсор не скрываем: иначе прицела не видно. */
.eyedropper-active :deep(.konvajs-content),
.eyedropper-active :deep(canvas) {
  cursor: crosshair !important;
}
</style>

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
  return 'canvas-draw';
});

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

function bindStage(): void {
  const stage = stageApi.stage.value;
  if (!stage) return;
  stage.on('pointerdown', tools.onPointerDown);
  stage.on('pointermove', tools.onPointerMove);
  stage.on('pointerup', tools.onPointerUp);
  stage.on('pointerupoutside', tools.onPointerUp);
  // Отмена указателя (например, жестом системы) тоже завершает жест.
  stage.on('pointercancel', tools.onPointerUp);
  stage.on('dblclick', tools.onDoubleClick);
  stage.on('wheel', tools.onWheel);
  stage.on('contextmenu', (event) => event.evt.preventDefault());
}

onMounted(() => {
  stageApi.init();
  bindStage();
  renderer.sync();
});

onBeforeUnmount(() => {
  stageApi.destroy();
});

// Синхронизация объектов при изменении данных, страницы, инструмента.
watch(
  () => [objects.objects, editor.currentPage, editor.tool, editor.viewOnly] as const,
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
    :class="[backgroundClass, cursorClass]"
    data-testid="editor-canvas"
  >
    <div ref="container" class="absolute inset-0" />

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

<script setup lang="ts">
/** Нижняя строка состояния: страница, зум, курсор, объекты, предупреждения. */
import { computed } from 'vue';
import { useEditorStore } from '@/stores/editor';
import { useObjectsStore } from '@/stores/objects';
import { usePdfStore } from '@/stores/pdf';
import { useUiStore } from '@/stores/ui';
import { useSettingsStore } from '@/stores/settings';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppButton from '@/components/ui/AppButton.vue';

const editor = useEditorStore();
const objects = useObjectsStore();
const pdf = usePdfStore();
const ui = useUiStore();
const settings = useSettingsStore();

const cursorPosition = computed(() => {
  const point = editor.cursorPosition;
  if (!point) return '—';
  return `${point.x.toFixed(1)} × ${point.y.toFixed(1)} pt`;
});

const selectedLabel = computed(() => {
  if (!objects.hasSelection) return 'нет выделения';
  if (objects.selectionCount === 1) {
    const obj = objects.selectedObjects[0];
    const names: Record<string, string> = {
      text: 'текст',
      image: 'изображение',
      shape: 'фигура',
      drawing: 'рисунок',
      signature: 'подпись',
      stamp: 'штамп',
      whiteout: 'закрашивание',
      highlight: 'выделение',
    };
    return `${names[obj.type] ?? obj.type} · ${obj.width.toFixed(0)}×${obj.height.toFixed(0)} pt`;
  }
  return `выбрано объектов: ${objects.selectionCount}`;
});

const pageLabel = computed(() =>
  pdf.pageCount > 0 ? `Страница ${editor.currentPage + 1} из ${pdf.pageCount}` : 'Документ не открыт',
);

const pageSizeLabel = computed(() => {
  const size = editor.pageSize;
  const toMm = (pt: number): number => Math.round((pt / 72) * 25.4);
  return `${toMm(size.width)} × ${toMm(size.height)} мм`;
});
</script>

<template>
  <footer
    class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200 bg-white/95 px-3 py-1.5 text-[11px] text-slate-500 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 dark:text-slate-400"
  >
    <span class="flex items-center gap-1.5">
      <AppIcon name="file" :size="13" />
      {{ pageLabel }}
    </span>
    <span class="hidden sm:inline">{{ pageSizeLabel }}</span>
    <span class="flex items-center gap-1.5">
      <AppIcon name="zoomIn" :size="13" />
      {{ editor.zoomPercent }}%
    </span>
    <span class="hidden font-mono md:inline">{{ cursorPosition }}</span>
    <span class="hidden lg:inline">{{ selectedLabel }}</span>
    <span class="hidden xl:inline">Объектов: {{ objects.totalVisible }}</span>

    <div class="flex-1" />

    <span v-if="pdf.isEncrypted" class="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
      <AppIcon name="alert" :size="13" />
      Документ защищён
    </span>
    <span v-if="!settings.settings.snapToObjects" class="hidden md:inline">Привязка выключена</span>
    <AppButton
      v-if="objects.hasSelection"
      size="xs"
      variant="ghost"
      icon="x"
      @click="objects.clearSelection()"
    >
      Снять выделение
    </AppButton>
  </footer>
</template>

<script setup lang="ts">
/**
 * Текстовый слой PDF: позволяет заменить существующий текст
 * («корректурный слой»): старый фрагмент закрывается закрашиванием,
 * новый добавляется отдельным текстовым объектом.
 */
import { computed, ref, watch } from 'vue';
import type { PdfTextBlock } from '@/services/pdfService';
import { pdfService } from '@/services/pdfService';
import { createTextObject, createWhiteoutObject } from '@/services/objectFactory';
import { useEditorStore } from '@/stores/editor';
import { useObjectsStore } from '@/stores/objects';
import { usePdfStore } from '@/stores/pdf';
import { useSettingsStore } from '@/stores/settings';
import { useFontsStore } from '@/stores/fonts';
import { useUiStore } from '@/stores/ui';
import AppButton from '@/components/ui/AppButton.vue';
import AppEmptyState from '@/components/ui/AppEmptyState.vue';
import AppSpinner from '@/components/ui/AppSpinner.vue';
import AppInput from '@/components/ui/AppInput.vue';

const editor = useEditorStore();
const objects = useObjectsStore();
const pdf = usePdfStore();
const settings = useSettingsStore();
const fonts = useFontsStore();
const ui = useUiStore();

const blocks = ref<PdfTextBlock[]>([]);
const isLoading = ref(false);
const error = ref<string | null>(null);
const search = ref('');

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  const list = blocks.value;
  return query ? list.filter((block) => block.text.toLowerCase().includes(query)) : list;
});

async function load(): Promise<void> {
  blocks.value = [];
  error.value = null;
  if (!pdfService.getDocument()) {
    error.value = 'Документ открыт из проекта без исходного PDF: текстовый слой недоступен.';
    return;
  }
  isLoading.value = true;
  try {
    blocks.value = await pdfService.getTextBlocks(editor.currentPage);
    pdf.pages[editor.currentPage]!.hasTextLayer = blocks.value.length > 0;
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : String(loadError);
  } finally {
    isLoading.value = false;
  }
}

watch(
  () => [editor.currentPage, ui.leftTab] as const,
  () => {
    if (ui.leftTab === 'text') void load();
  },
);

watch(
  () => pdf.isLoaded,
  () => {
    if (ui.leftTab === 'text') void load();
  },
);

/** Заменить текстовый фрагмент: закрашивание + новый текст. */
function replaceBlock(block: PdfTextBlock): void {
  const whiteout = createWhiteoutObject({
    page: editor.currentPage,
    x: Math.max(0, block.x - 1),
    y: Math.max(0, block.y - 1),
    width: block.width + 2,
    height: block.height + 2,
    color: settings.settings.defaultWhiteoutColor,
  });
  const fontSize = Math.max(6, Math.round(block.fontSize));
  const textObject = createTextObject({
    page: editor.currentPage,
    x: block.x,
    y: block.y,
    width: Math.max(block.width + 30, 120),
    height: fontSize * 1.4,
    text: block.text,
    autoHeight: true,
    defaults: {
      fontId: settings.settings.defaultFontId,
      fontFamily: fonts.familyOf(settings.settings.defaultFontId),
      fontSize,
      color: settings.settings.defaultTextColor,
      align: 'left',
    },
  });
  objects.add([whiteout, textObject], 'Замена текста PDF');
  editor.editingTextId = textObject.id;
  ui.setRightTab('properties');
  ui.notify.info('Текст заменён', 'Отредактируйте его в панели свойств справа.');
}

/** Вставка нового текста в то же место (без закрашивания). */
function addTextAt(block: PdfTextBlock): void {
  const fontSize = Math.max(6, Math.round(block.fontSize));
  const textObject = createTextObject({
    page: editor.currentPage,
    x: block.x,
    y: block.y,
    width: Math.max(block.width + 30, 120),
    height: fontSize * 1.4,
    text: block.text,
    autoHeight: true,
    defaults: {
      fontId: settings.settings.defaultFontId,
      fontFamily: fonts.familyOf(settings.settings.defaultFontId),
      fontSize,
      color: settings.settings.defaultTextColor,
      align: 'left',
    },
  });
  objects.add([textObject], 'Добавление текста');
  editor.editingTextId = textObject.id;
  ui.setRightTab('properties');
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="space-y-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Текст из PDF (стр. {{ editor.currentPage + 1 }})
        </span>
        <AppButton size="xs" variant="ghost" icon="refresh" @click="load">Обновить</AppButton>
      </div>
      <AppInput v-model="search" size="sm" type="search" placeholder="Поиск фрагмента…" />
    </div>

    <div v-if="isLoading" class="flex flex-1 items-center justify-center">
      <AppSpinner :size="18" label="Чтение текстового слоя…" />
    </div>

    <div v-else-if="error" class="flex-1">
      <AppEmptyState compact icon="alert" title="Текстовый слой недоступен" :text="error" />
    </div>

    <div v-else-if="filtered.length === 0" class="flex-1">
      <AppEmptyState
        compact
        icon="type"
        title="Текст не найден"
        text="На этой странице нет текстового слоя (возможно, это скан). Добавьте текст инструментом «Текст»."
      />
    </div>

    <div v-else class="flex-1 space-y-1.5 overflow-y-auto p-2">
      <div
        v-for="block in filtered"
        :key="block.id"
        class="rounded-lg border border-slate-200 p-2 dark:border-slate-700"
      >
        <p class="line-clamp-3 text-[12px] leading-snug text-slate-700 dark:text-slate-200">
          {{ block.text }}
        </p>
        <p class="mt-1 text-[10px] text-slate-400">
          {{ Math.round(block.fontSize) }} pt · x={{ Math.round(block.x) }} y={{ Math.round(block.y) }}
        </p>
        <div class="mt-1.5 flex gap-1">
          <AppButton size="xs" variant="subtle" icon="refresh" @click="replaceBlock(block)">
            Заменить
          </AppButton>
          <AppButton size="xs" variant="ghost" icon="plus" @click="addTextAt(block)">
            Копия текста
          </AppButton>
        </div>
      </div>
    </div>

    <div class="border-t border-slate-200 px-3 py-2 text-[10px] leading-snug text-slate-400 dark:border-slate-800">
      «Заменить» закрывает исходный текст закрашиванием и добавляет новый — это надёжнее прямой
      правки PDF и гарантирует корректную кириллицу.
    </div>
  </div>
</template>

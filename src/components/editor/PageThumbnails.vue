<script setup lang="ts">
/** Панель миниатюр страниц с ленивой загрузкой. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useEditorStore } from '@/stores/editor';
import { usePdfStore } from '@/stores/pdf';
import { useObjectsStore } from '@/stores/objects';
import { usePageRotation } from '@/composables/usePageRotation';
import AppEmptyState from '@/components/ui/AppEmptyState.vue';
import AppSpinner from '@/components/ui/AppSpinner.vue';
import AppButton from '@/components/ui/AppButton.vue';

const editor = useEditorStore();
const pdf = usePdfStore();
const objects = useObjectsStore();
const rotation = usePageRotation();

const listRef = ref<HTMLElement | null>(null);
const observer = ref<IntersectionObserver | null>(null);
let preloadTimer: number | null = null;

/** Наблюдение за миниатюрами: грузим только видимые. */
function observeItems(): void {
  observer.value?.disconnect();
  if (typeof IntersectionObserver === 'undefined' || !listRef.value) {
    void pdf.ensureThumbnails(0, Math.min(9, pdf.pageCount - 1));
    return;
  }
  observer.value = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = Number((entry.target as HTMLElement).dataset.index ?? '-1');
        if (index >= 0) void pdf.ensureThumbnail(index);
      }
    },
    { root: listRef.value, rootMargin: '240px 0px' },
  );
  const items = listRef.value.querySelectorAll('[data-index]');
  items.forEach((item) => observer.value?.observe(item));
}

function objectsOnPage(index: number): number {
  return objects.countForPage(index);
}

function goToPage(index: number): void {
  editor.setCurrentPage(index);
}

watch(
  () => pdf.pageCount,
  () => {
    if (preloadTimer !== null) window.clearTimeout(preloadTimer);
    preloadTimer = window.setTimeout(() => {
      void pdf.ensureThumbnails(0, Math.min(9, pdf.pageCount - 1));
      observeItems();
    }, 120);
  },
  { immediate: true },
);

onMounted(() => {
  observeItems();
});

onBeforeUnmount(() => {
  observer.value?.disconnect();
  if (preloadTimer !== null) window.clearTimeout(preloadTimer);
});

const pages = computed(() => pdf.pages);
</script>

<template>
  <div class="flex h-full flex-col">
    <div
      class="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800"
    >
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Страницы ({{ pdf.pageCount }})
      </span>
      <AppButton
        v-if="pdf.pageCount > 12"
        size="xs"
        variant="ghost"
        icon="download"
        @click="pdf.ensureThumbnails(0, pdf.pageCount - 1)"
      >
        Все
      </AppButton>
    </div>

    <div v-if="pdf.pageCount === 0" class="flex-1">
      <AppEmptyState
        compact
        icon="file"
        title="Нет документа"
        text="Откройте PDF-файл, чтобы увидеть страницы."
      />
    </div>

    <div v-else ref="listRef" class="flex-1 space-y-2 overflow-y-auto p-2">
      <div
        v-for="page in pages"
        :key="page.index"
        :data-index="page.index"
        role="button"
        tabindex="0"
        class="group relative flex w-full cursor-pointer gap-2 rounded-lg p-1.5 text-left transition-colors"
        :class="
          editor.currentPage === page.index
            ? 'bg-brand-50 ring-1 ring-brand-300 dark:bg-brand-600/15 dark:ring-brand-500/40'
            : 'hover:bg-slate-100 dark:hover:bg-slate-800'
        "
        @click="goToPage(page.index)"
        @keydown.enter="goToPage(page.index)"
      >
        <span
          class="relative flex h-[86px] w-[64px] shrink-0 items-center justify-center overflow-hidden rounded border border-slate-200 bg-white dark:border-slate-700"
        >
          <img
            v-if="page.thumbnail"
            :src="page.thumbnail"
            :alt="`Страница ${page.index + 1}`"
            class="h-full w-full object-contain"
            loading="lazy"
          />
          <AppSpinner v-else-if="page.thumbnailStatus === 'rendering'" :size="14" />
          <span v-else class="text-[10px] text-slate-400">{{ page.index + 1 }}</span>
        </span>

        <span class="min-w-0 flex-1 py-0.5">
          <span class="flex items-center gap-1.5">
            <span class="text-[12px] font-medium text-slate-700 dark:text-slate-200">
              {{ page.index + 1 }}
            </span>
            <span
              v-if="objectsOnPage(page.index) > 0"
              class="rounded bg-emerald-100 px-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
            >
              {{ objectsOnPage(page.index) }}
            </span>
            <span
              v-if="rotation.hasCustomRotation(page.index)"
              class="rounded bg-brand-100 px-1 text-[10px] font-medium text-brand-700 dark:bg-brand-500/20 dark:text-brand-200"
            >
              {{ rotation.pageRotation(page.index) }}°
            </span>
          </span>
          <span class="mt-0.5 block text-[10px] leading-tight text-slate-400">
            {{ Math.round(page.displayWidth) }} × {{ Math.round(page.displayHeight) }} pt
          </span>
          <span v-if="page.error" class="mt-0.5 block text-[10px] text-rose-500">
            ошибка отрисовки
          </span>
        </span>

        <!-- Поворот отдельной страницы прямо из списка -->
        <span
          class="absolute right-1 top-1 hidden items-center gap-0.5 rounded-md bg-white/95 p-0.5 shadow-sm ring-1 ring-slate-200 group-hover:flex dark:bg-slate-900/95 dark:ring-slate-700"
        >
          <AppButton
            size="xs"
            variant="ghost"
            icon="rotateLeft"
            title="Повернуть страницу влево"
            @click.stop="rotation.rotatePage(page.index, -90)"
          />
          <AppButton
            size="xs"
            variant="ghost"
            icon="rotateRight"
            title="Повернуть страницу вправо"
            @click.stop="rotation.rotatePage(page.index, 90)"
          />
        </span>
      </div>
    </div>
  </div>
</template>

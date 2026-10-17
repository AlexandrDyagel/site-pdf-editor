<script setup lang="ts">
/**
 * Корневой компонент: инициализация приложения, глобальные модальные
 * элементы, уведомления и оверлей перетаскивания файлов.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useSettingsStore } from '@/stores/settings';
import { useFontsStore } from '@/stores/fonts';
import { useLibraryStore } from '@/stores/library';
import { useUiStore } from '@/stores/ui';
import { usePdfStore } from '@/stores/pdf';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useExportStore } from '@/stores/export';
import { useHistoryStore } from '@/stores/history';
import { useHotkeys } from '@/composables/useHotkeys';
import { useDragAndDrop } from '@/composables/useDragAndDrop';
import AppToasts from '@/components/ui/AppToasts.vue';
import AppConfirmDialog from '@/components/ui/AppConfirmDialog.vue';
import FontManagerModal from '@/components/export/FontManagerModal.vue';
import ShortcutsModal from '@/components/export/ShortcutsModal.vue';
import ImageLibraryModal from '@/components/export/ImageLibraryModal.vue';
import ProjectsModal from '@/components/export/ProjectsModal.vue';
import AppProgressBar from '@/components/ui/AppProgressBar.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import { storageService } from '@/services/storageService';
import { pdfService } from '@/services/pdfService';

const route = useRoute();
const router = useRouter();
const settings = useSettingsStore();
const fonts = useFontsStore();
const library = useLibraryStore();
const ui = useUiStore();
const pdf = usePdfStore();
const objects = useObjectsStore();
const editor = useEditorStore();
const exporter = useExportStore();
const history = useHistoryStore();

const { progress } = storeToRefs(ui);
const { isDragging } = useDragAndDrop();
const hotkeys = useHotkeys();

const isReady = ref(false);
const bootError = ref<string | null>(null);
let autosaveTimer: number | null = null;

/** Показывать ли глобальную полосу прогресса. */
const showProgress = computed(() => progress.value.active && route.name === 'editor');

/** Автосохранение проекта в IndexedDB. */
function scheduleAutosave(): void {
  if (autosaveTimer !== null) window.clearInterval(autosaveTimer);
  const interval = settings.settings.autosaveInterval;
  if (!interval || interval <= 0) return;
  autosaveTimer = window.setInterval(() => {
    if (!pdf.isLoaded || objects.objects.length === 0) return;
    void exporter.saveProjectToStorage().catch(() => undefined);
  }, Math.max(15_000, interval));
}

onMounted(async () => {
  try {
    settings.load();
    await fonts.load();
    await library.load();
    await seedDemoData();
    if (!storageService.persistent) {
      ui.notify.warning(
        'Локальное хранилище недоступно',
        'Библиотека штампов и подписей не сохранится после перезагрузки страницы.',
      );
    }
    pdfService.setCacheLimit(settings.settings.pageCacheLimit);
    applyDefaultsToTools();
    // Поворот страницы входит в историю: связываем историю с состоянием страниц.
    history.setRotationBridge({
      read: () => pdf.viewRotations(),
      write: (rotations) => pdf.setViewRotations(rotations),
    });

    // При переходе между страницами приложения окна закрываем: иначе окно,
    // открытое на одной странице, «всплывало» при входе в другую.
    router.afterEach(() => {
      ui.closeAllModals();
    });
  } catch (error) {
    bootError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isReady.value = true;
    scheduleAutosave();
  }
});

/**
 * Первый запуск: добавляем в библиотеку образцы штампов, печати и подписи,
 * чтобы инструменты были понятны сразу. Модуль подгружается по требованию —
 * на стартовом экране лишний код не нужен.
 */
async function seedDemoData(): Promise<void> {
  const flag = 'pdf-editor:demo-seeded:v1';
  try {
    if (library.items.length > 0 || localStorage.getItem(flag)) return;
    const {
      demoApprovalStamp,
      demoCopyStamp,
      demoRoundSeal,
      demoSignature,
    } = await import('@/constants/demoData');
    await library.saveStamp(demoApprovalStamp());
    await library.saveStamp(demoCopyStamp());
    await library.saveStamp(demoRoundSeal());
    await library.saveSignature(demoSignature());
    localStorage.setItem(flag, '1');
  } catch {
    /* демо-данные не критичны */
  }
}

onBeforeUnmount(() => {
  hotkeys.dispose();
  if (autosaveTimer !== null) window.clearInterval(autosaveTimer);
});

// Изменение интервала автосохранения в настройках.
watch(() => settings.settings.autosaveInterval, scheduleAutosave);

/** Переносим значения по умолчанию из настроек в параметры инструментов. */
function applyDefaultsToTools(): void {
  editor.syncTextDefaults(settings.textDefaults);
  editor.syncDrawingDefaults({
    stroke: settings.settings.defaultStrokeColor,
    strokeWidth: settings.settings.defaultStrokeWidth,
    whiteout: settings.settings.defaultWhiteoutColor,
    highlight: settings.settings.defaultHighlightColor,
  });
}

watch(
  () => [
    settings.settings.defaultFontId,
    settings.settings.defaultTextSize,
    settings.settings.defaultTextColor,
    settings.settings.defaultStrokeColor,
    settings.settings.defaultStrokeWidth,
    settings.settings.defaultWhiteoutColor,
    settings.settings.defaultHighlightColor,
  ],
  () => applyDefaultsToTools(),
);

// Ограничение кэша отрисованных страниц.
watch(
  () => settings.settings.pageCacheLimit,
  (value) => pdfService.setCacheLimit(value),
);
</script>

<template>
  <div class="flex h-full min-h-screen flex-col bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <div v-if="showProgress" class="fixed inset-x-0 top-0 z-[150] px-4 pt-3">
      <div
        class="mx-auto max-w-md rounded-xl bg-white/95 p-3 shadow-floating ring-1 ring-slate-200 backdrop-blur dark:bg-slate-900/95 dark:ring-slate-800"
      >
        <AppProgressBar
          :value="progress.value"
          :label="progress.label"
          :detail="progress.detail"
        />
      </div>
    </div>

    <div v-if="bootError" class="m-4 rounded-xl bg-rose-50 p-4 text-sm text-rose-700 ring-1 ring-rose-200">
      Не удалось инициализировать приложение: {{ bootError }}
    </div>

    <router-view v-if="isReady" v-slot="{ Component }">
      <component :is="Component" />
    </router-view>

    <div
      v-else
      class="flex flex-1 items-center justify-center gap-3 text-sm text-slate-500 dark:text-slate-400"
    >
      <AppIcon name="file" :size="18" />
      Загрузка редактора…
    </div>

    <!-- Оверлей перетаскивания файлов -->
    <Transition
      enter-active-class="transition duration-150"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isDragging"
        class="pointer-events-none fixed inset-0 z-[250] flex items-center justify-center bg-brand-900/40 backdrop-blur-sm"
      >
        <div
          class="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-white/70 bg-white/95 px-10 py-8 text-center shadow-floating dark:bg-slate-900/95"
        >
          <AppIcon name="download" :size="30" class="text-brand-600" />
          <p class="text-sm font-medium">Отпустите файл, чтобы открыть</p>
          <p class="text-xs text-slate-500">
            PDF, изображения, шрифты TTF/OTF, проекты и библиотеки JSON
          </p>
        </div>
      </div>
    </Transition>

    <AppToasts />
    <AppConfirmDialog />

    <!--
      Окна, доступные с любой страницы (главная, настройки, редактор).
      Раньше они были смонтированы только в редакторе: кнопка «Управление
      шрифтами» в настройках только выставляла флаг, окно не открывалось,
      а появлялось при следующем входе в редактор.
    -->
    <FontManagerModal />
    <ShortcutsModal />
    <ImageLibraryModal />
    <ProjectsModal />
  </div>
</template>

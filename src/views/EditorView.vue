<script setup lang="ts">
/**
 * Экран редактора: панели, рабочая область и модальные окна.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useUiStore } from '@/stores/ui';
import { usePdfStore } from '@/stores/pdf';
import { useEditorStore } from '@/stores/editor';
import { useObjectsStore } from '@/stores/objects';
import { useExportStore } from '@/stores/export';
import { usePdfDocument } from '@/composables/usePdfDocument';
import EditorToolbar from '@/components/editor/EditorToolbar.vue';
import EditorCanvas from '@/components/editor/EditorCanvas.vue';
import StatusBar from '@/components/editor/StatusBar.vue';
import PageThumbnails from '@/components/editor/PageThumbnails.vue';
import PropertiesPanel from '@/components/editor/PropertiesPanel.vue';
import LayersPanel from '@/components/editor/LayersPanel.vue';
import ToolOptionsPanel from '@/components/editor/ToolOptionsPanel.vue';
import PagePropertiesPanel from '@/components/editor/PagePropertiesPanel.vue';
import TextLayerPanel from '@/components/editor/TextLayerPanel.vue';
import LibraryPanel from '@/components/library/LibraryPanel.vue';
import PdfDropzone from '@/components/pdf/PdfDropzone.vue';
import PasswordPrompt from '@/components/pdf/PasswordPrompt.vue';
import StampEditor from '@/components/stamps/StampEditor.vue';
import SignatureEditor from '@/components/signatures/SignatureEditor.vue';
import DrawingEditor from '@/components/drawings/DrawingEditor.vue';
import ExportModal from '@/components/export/ExportModal.vue';
import DocumentInfoModal from '@/components/export/DocumentInfoModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppTabs from '@/components/ui/AppTabs.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const router = useRouter();
const ui = useUiStore();
const pdf = usePdfStore();
const editor = useEditorStore();
const objects = useObjectsStore();
const exporter = useExportStore();
const documents = usePdfDocument();

const passwordError = ref<string | null>(null);
/** Панель, открытая поверх канваса на узких экранах. */
const mobilePanel = ref<'left' | 'right' | null>(null);

const leftTabs = computed(() => [
  { id: 'pages', label: 'Страницы', icon: 'layers' },
  { id: 'library', label: 'Библиотека', icon: 'book' },
  { id: 'text', label: 'Текст PDF', icon: 'type' },
]);

const rightTabs = computed(() => [
  { id: 'tool', label: 'Инструмент', icon: 'sliders' },
  { id: 'properties', label: 'Свойства', icon: 'settings' },
  { id: 'layers', label: 'Слои', icon: 'layers' },
  { id: 'page', label: 'Страница', icon: 'file' },
]);

const leftTab = computed({
  get: () => ui.leftTab,
  set: (value: string) => ui.setLeftTab(value as typeof ui.leftTab),
});

const rightTab = computed({
  get: () => ui.rightTab,
  set: (value: string) => ui.setRightTab(value as typeof ui.rightTab),
});

async function onFiles(files: File[]): Promise<void> {
  const file = files[0];
  if (!file) return;
  passwordError.value = null;
  const outcome = await documents.openFile(file);
  if (outcome.ok) editor.fitToWidth();
}

async function onPassword(password: string): Promise<void> {
  passwordError.value = null;
  const outcome = await pdf.unlock(password);
  if (!outcome.ok) {
    passwordError.value = outcome.error ?? 'Неверный пароль';
    return;
  }
  objects.clearAll(false);
  editor.fitToWidth();
  ui.notify.success('Документ открыт', pdf.fileName);
}

function cancelPassword(): void {
  void pdf.clear();
  passwordError.value = null;
}

onMounted(async () => {
  await exporter.syncWithDocument();
  if (pdf.isLoaded) {
    editor.fitToWidth();
    void pdf.ensureThumbnails(0, Math.min(9, pdf.pageCount - 1));
  }
});

// Пересчёт масштаба при смене страницы или документа.
watch(
  () => [pdf.isLoaded, editor.currentPage] as const,
  () => {
    if (pdf.isLoaded) void pdf.ensureThumbnail(editor.currentPage);
  },
);
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden">
    <EditorToolbar />

    <div class="relative flex min-h-0 flex-1 overflow-hidden">
      <!-- Левая панель -->
      <aside
        v-if="ui.leftPanelOpen"
        class="hidden w-[252px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 md:flex"
      >
        <AppTabs v-model="leftTab" :items="leftTabs" size="sm" class="m-2" />
        <div class="min-h-0 flex-1 overflow-hidden">
          <PageThumbnails v-if="leftTab === 'pages'" />
          <LibraryPanel v-else-if="leftTab === 'library'" />
          <TextLayerPanel v-else />
        </div>
      </aside>

      <!-- Рабочая область -->
      <main class="relative min-w-0 flex-1 overflow-hidden">
        <EditorCanvas v-if="pdf.isLoaded && !pdf.needsPassword" />

        <div
          v-else-if="pdf.needsPassword"
          class="flex h-full items-center justify-center p-6"
        >
          <PasswordPrompt
            :file-name="pdf.fileName"
            :loading="pdf.isLoading"
            :error="passwordError"
            @submit="onPassword"
            @cancel="cancelPassword"
          />
        </div>

        <div v-else class="flex h-full items-center justify-center p-6">
          <div class="w-full max-w-lg space-y-3">
            <PdfDropzone :loading="pdf.isLoading" @select="onFiles" />
            <div v-if="pdf.error" class="rounded-xl bg-rose-50 p-3 text-[12px] text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
              {{ pdf.error }}
            </div>
            <div class="flex gap-2">
              <AppButton block icon="file" @click="router.push('/')">На главный экран</AppButton>
              <AppButton block icon="folder" @click="ui.openModal('projects')">
                Открыть проект
              </AppButton>
            </div>
          </div>
        </div>

        <!-- Кнопки панелей для планшета -->
        <div class="pointer-events-none absolute inset-x-0 top-2 flex justify-between px-2 md:hidden">
          <AppButton
            class="pointer-events-auto"
            size="sm"
            icon="layers"
            variant="secondary"
            @click="mobilePanel = 'left'"
          >
            Панели
          </AppButton>
          <AppButton
            class="pointer-events-auto"
            size="sm"
            icon="settings"
            variant="secondary"
            @click="mobilePanel = 'right'"
          >
            Свойства
          </AppButton>
        </div>
      </main>

      <!-- Правая панель -->
      <aside
        v-if="ui.rightPanelOpen"
        class="hidden w-[304px] shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:flex"
      >
        <AppTabs v-model="rightTab" :items="rightTabs" size="sm" class="m-2" />
        <div class="min-h-0 flex-1 overflow-hidden">
          <ToolOptionsPanel v-if="rightTab === 'tool'" />
          <PropertiesPanel v-else-if="rightTab === 'properties'" />
          <LayersPanel v-else-if="rightTab === 'layers'" />
          <PagePropertiesPanel v-else />
        </div>
      </aside>

      <!-- Мобильные панели -->
      <Transition
        enter-active-class="transition duration-150"
        enter-from-class="opacity-0"
        leave-active-class="transition duration-100"
        leave-to-class="opacity-0"
      >
        <div
          v-if="mobilePanel"
          class="absolute inset-0 z-40 flex bg-slate-900/40 md:hidden"
          @click.self="mobilePanel = null"
        >
          <div
            class="flex h-full w-[86%] max-w-sm flex-col bg-white dark:bg-slate-900"
            :class="mobilePanel === 'left' ? 'mr-auto' : 'ml-auto'"
          >
            <div class="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
              <AppTabs
                :model-value="mobilePanel === 'left' ? leftTab : rightTab"
                :items="mobilePanel === 'left' ? leftTabs : rightTabs"
                size="sm"
                @update:model-value="
                  (value) =>
                    mobilePanel === 'left' ? ui.setLeftTab(value as typeof ui.leftTab) : ui.setRightTab(value as typeof ui.rightTab)
                "
              />
              <AppButton size="icon" variant="ghost" icon="x" @click="mobilePanel = null" />
            </div>
            <div class="min-h-0 flex-1 overflow-hidden">
              <template v-if="mobilePanel === 'left'">
                <PageThumbnails v-if="leftTab === 'pages'" />
                <LibraryPanel v-else-if="leftTab === 'library'" />
                <TextLayerPanel v-else />
              </template>
              <template v-else>
                <ToolOptionsPanel v-if="rightTab === 'tool'" />
                <PropertiesPanel v-else-if="rightTab === 'properties'" />
                <LayersPanel v-else-if="rightTab === 'layers'" />
                <PagePropertiesPanel v-else />
              </template>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <StatusBar />

    <!-- Модальные окна (общие для всех страниц — в App.vue) -->
    <StampEditor />
    <SignatureEditor />
    <DrawingEditor />
    <ExportModal />
    <DocumentInfoModal />

    <div
      v-if="ui.progress.active"
      class="pointer-events-none fixed bottom-16 right-4 z-[120] w-64 rounded-xl bg-white/95 p-2.5 text-[11px] shadow-floating ring-1 ring-slate-200 dark:bg-slate-900/95 dark:ring-slate-800"
    >
      <div class="flex items-center gap-2">
        <AppIcon name="refresh" :size="13" class="animate-spin text-brand-600" />
        <span class="truncate">{{ ui.progress.label }}</span>
      </div>
    </div>
  </div>
</template>

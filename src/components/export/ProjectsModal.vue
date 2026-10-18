<script setup lang="ts">
/** Сохранённые проекты (IndexedDB): открыть, удалить, сохранить текущий. */
import { computed, ref, watch } from 'vue';
import { useUiStore } from '@/stores/ui';
import { usePdfStore } from '@/stores/pdf';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useExport } from '@/composables/useExport';
import { useHistoryStore } from '@/stores/history';
import { storageService } from '@/services/storageService';
import { formatBytes } from '@/utils/download';
import { formatDateTime } from '@/utils/date';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppEmptyState from '@/components/ui/AppEmptyState.vue';
import AppSpinner from '@/components/ui/AppSpinner.vue';

interface ProjectEntry {
  id: string;
  fileName: string;
  savedAt: string;
  numPages: number;
  objects: number;
}

const ui = useUiStore();
const pdf = usePdfStore();
const objects = useObjectsStore();
const editor = useEditorStore();
const { saveProject } = useExport();
const history = useHistoryStore();

const projects = ref<ProjectEntry[]>([]);
const isLoading = ref(false);
const isSaving = ref(false);

const isOpen = computed({
  get: () => ui.modals.projects,
  set: (value: boolean) => (value ? ui.openModal('projects') : ui.closeModal('projects')),
});

async function refresh(): Promise<void> {
  isLoading.value = true;
  try {
    projects.value = await storageService.projectList();
  } finally {
    isLoading.value = false;
  }
}

watch(
  () => ui.modals.projects,
  (open) => {
    if (open) void refresh();
  },
);

async function saveCurrent(): Promise<void> {
  if (!pdf.isLoaded) {
    ui.notify.warning('Нет открытого документа');
    return;
  }
  isSaving.value = true;
  try {
    await saveProject();
    await refresh();
  } finally {
    isSaving.value = false;
  }
}

async function loadProject(id: string): Promise<void> {
  const project = await storageService.projectLoad(id);
  if (!project) {
    ui.notify.error('Проект не найден');
    return;
  }
  const outcome = await pdf.loadFromProject(project);
  if (!outcome.ok) {
    ui.notify.error('Не удалось открыть проект', outcome.error ?? undefined);
    return;
  }
  objects.replaceAll(project.objects, false);
  history.clear();
  editor.setCurrentPage(0);
  editor.fitToWidth();
  ui.closeModal('projects');
  ui.notify.success('Проект открыт', `${project.objects.length} объектов`);
  if (outcome.warning) ui.notify.warning('Внимание', outcome.warning);
}

async function removeProject(id: string, name: string): Promise<void> {
  const confirmed = await ui.askConfirm({
    title: 'Удалить проект?',
    text: name,
    confirmLabel: 'Удалить',
    danger: true,
  });
  if (!confirmed) return;
  await storageService.projectDelete(id);
  await refresh();
  ui.notify.info('Проект удалён');
}
</script>

<template>
  <AppModal
    v-model="isOpen"
    title="Проекты в браузере"
    subtitle="Проекты сохраняются локально в IndexedDB — без сервера"
    icon="folder"
    width="lg"
  >
    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <AppButton icon="save" :loading="isSaving" :disabled="!pdf.isLoaded" @click="saveCurrent">
          Сохранить текущий документ
        </AppButton>
        <AppButton icon="refresh" variant="ghost" @click="refresh">Обновить список</AppButton>
      </div>

      <div v-if="isLoading" class="flex justify-center py-6">
        <AppSpinner :size="20" label="Загрузка проектов…" />
      </div>

      <AppEmptyState
        v-else-if="projects.length === 0"
        icon="folder"
        title="Проектов пока нет"
        text="Сохраните документ, чтобы вернуться к работе позже."
      />

      <div v-else class="space-y-2">
        <div
          v-for="project in projects"
          :key="project.id"
          class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700"
        >
          <div class="min-w-0">
            <p class="truncate text-[13px] font-medium text-slate-800 dark:text-slate-100">
              {{ project.fileName }}
            </p>
            <p class="text-[11px] text-slate-400">
              {{ formatDateTime(project.savedAt) }} · страниц: {{ project.numPages }} · объектов:
              {{ project.objects }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <AppButton size="sm" variant="primary" icon="folder" @click="loadProject(project.id)">
              Открыть
            </AppButton>
            <AppButton
              size="sm"
              variant="ghost"
              icon="trash"
              @click="removeProject(project.id, project.fileName)"
            />
          </div>
        </div>
      </div>

      <p class="text-[11px] leading-snug text-slate-400">
        Проекты хранятся только в этом браузере. Чтобы перенести работу на другое устройство,
        используйте экспорт в «Проект (JSON)» — он включает исходный PDF и все объекты.
      </p>
      <p v-if="pdf.fileSize" class="text-[11px] text-slate-400">
        Размер текущего документа: {{ formatBytes(pdf.fileSize) }}
      </p>
    </div>

    <template #footer>
      <AppButton variant="ghost" @click="ui.closeModal('projects')">Закрыть</AppButton>
    </template>
  </AppModal>
</template>

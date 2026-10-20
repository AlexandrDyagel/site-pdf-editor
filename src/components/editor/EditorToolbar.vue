<script setup lang="ts">
/**
 * Верхняя панель: файл, история, инструменты, зум, вид.
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { TOOL_DEFINITIONS, TOOL_GROUPS, ZOOM_PRESETS } from '@/constants';
import { useEditorStore } from '@/stores/editor';
import { useObjectsStore } from '@/stores/objects';
import { usePdfStore } from '@/stores/pdf';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';
import { useUndoRedo } from '@/composables/useUndoRedo';
import { usePdfDocument } from '@/composables/usePdfDocument';
import { useExport } from '@/composables/useExport';
import { usePageRotation } from '@/composables/usePageRotation';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppTooltip from '@/components/ui/AppTooltip.vue';

const router = useRouter();
const editor = useEditorStore();
const objects = useObjectsStore();
const pdf = usePdfStore();
const settings = useSettingsStore();
const ui = useUiStore();
const history = useUndoRedo();
const documents = usePdfDocument();
const exporter = useExport();
const rotation = usePageRotation();

const groups = computed(() =>
  TOOL_GROUPS.map((group) => ({
    ...group,
    tools: TOOL_DEFINITIONS.filter((tool) => tool.group === group.id),
  })).filter((group) => group.tools.length > 0),
);

const zoomOptions = computed(() => {
  const options = new Set<number>([...ZOOM_PRESETS.map((value) => Math.round(value * 100))]);
  options.add(editor.zoomPercent);
  return Array.from(options)
    .sort((a, b) => a - b)
    .map((percent) => ({ value: percent, label: `${percent}%` }));
});

function onZoomSelect(value: string | number | null): void {
  if (typeof value === 'number') editor.setZoomPercent(value);
}

async function onOpen(): Promise<void> {
  await documents.openFromDialog();
}

/** Сохранение проекта в браузере (IndexedDB), а не скачивание PDF. */
async function onSave(): Promise<void> {
  await exporter.saveProject();
}

function onExport(): void {
  exporter.open();
}

function toggleViewOnly(): void {
  editor.viewOnly = !editor.viewOnly;
  if (editor.viewOnly) {
    editor.setTool('pan');
    objects.clearSelection();
  }
}
</script>

<template>
  <header
    class="flex flex-col gap-2 border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95"
  >
    <!-- Верхний ряд: файл и история -->
    <div class="flex flex-wrap items-center gap-2">
      <RouterLink
        to="/"
        class="flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
        title="На главную"
      >
        <span
          class="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-white"
        >
          <AppIcon name="file" :size="16" />
        </span>
        <span class="hidden text-[13px] font-semibold sm:block">PDF Редактор</span>
      </RouterLink>

      <div class="mx-1 hidden h-6 w-px bg-slate-200 sm:block dark:bg-slate-700" />

      <AppTooltip text="Открыть PDF" shortcut="Ctrl+O">
        <AppButton icon="folder" size="sm" @click="onOpen">Открыть</AppButton>
      </AppTooltip>

      <AppTooltip text="Сохранить проект в браузере (PDF скачивается через «Экспорт»)" shortcut="Ctrl+S">
        <AppButton
          icon="save"
          size="sm"
          variant="primary"
          :disabled="!pdf.isLoaded"
          data-testid="toolbar-save"
          @click="onSave"
        >
          Сохранить
        </AppButton>
      </AppTooltip>

      <AppTooltip text="Экспорт (PDF, PNG, DOCX, JSON…)" shortcut="Ctrl+E">
        <AppButton icon="download" size="sm" :disabled="!pdf.isLoaded" @click="onExport">
          Экспорт
        </AppButton>
      </AppTooltip>

      <div class="mx-1 hidden h-6 w-px bg-slate-200 sm:block dark:bg-slate-700" />

      <AppTooltip :text="`Отменить: ${history.undoLabel.value}`" shortcut="Ctrl+Z">
        <AppButton
          icon="undo"
          size="icon"
          variant="ghost"
          :disabled="!history.canUndo.value"
          @click="history.undo()"
        />
      </AppTooltip>
      <AppTooltip :text="`Повторить: ${history.redoLabel.value}`" shortcut="Ctrl+Shift+Z">
        <AppButton
          icon="redo"
          size="icon"
          variant="ghost"
          :disabled="!history.canRedo.value"
          @click="history.redo()"
        />
      </AppTooltip>

      <div class="flex-1" />

      <AppTooltip :text="editor.viewOnly ? 'Вернуться к редактированию' : 'Режим просмотра'">
        <AppButton
          :icon="editor.viewOnly ? 'eye' : 'eyeOff'"
          size="sm"
          variant="ghost"
          :active="editor.viewOnly"
          @click="toggleViewOnly"
        >
          <span class="hidden md:inline">{{ editor.viewOnly ? 'Просмотр' : 'Редактирование' }}</span>
        </AppButton>
      </AppTooltip>

      <AppTooltip text="Шрифты: загрузить свой TTF/OTF" shortcut="Ctrl+Shift+F">
        <AppButton
          icon="font"
          size="icon"
          variant="ghost"
          title="Шрифты"
          @click="ui.openModal('fonts')"
        />
      </AppTooltip>

      <AppTooltip :text="settings.isDark ? 'Светлая тема' : 'Тёмная тема'">
        <AppButton
          :icon="settings.isDark ? 'sun' : 'moon'"
          size="icon"
          variant="ghost"
          @click="settings.toggleTheme()"
        />
      </AppTooltip>

      <AppTooltip text="Настройки приложения">
        <AppButton icon="settings" size="icon" variant="ghost" @click="router.push('/settings')" />
      </AppTooltip>

      <AppTooltip text="Горячие клавиши" shortcut="?">
        <AppButton
          icon="key"
          size="icon"
          variant="ghost"
          @click="ui.openModal('shortcuts')"
        />
      </AppTooltip>
    </div>

    <!-- Второй ряд: инструменты и зум -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex flex-wrap items-center gap-1">
        <template v-for="(group, groupIndex) in groups" :key="group.id">
          <div
            v-if="groupIndex > 0"
            class="mx-1 hidden h-6 w-px bg-slate-200 sm:block dark:bg-slate-700"
          />
          <AppTooltip
            v-for="tool in group.tools"
            :key="tool.id"
            :text="tool.label"
            :shortcut="tool.shortcut"
          >
            <AppButton
              :icon="tool.icon"
              size="icon"
              variant="ghost"
              :active="editor.tool === tool.id"
              :disabled="editor.viewOnly"
              :data-tool="tool.id"
              :aria-label="tool.label"
              @click="editor.setTool(tool.id)"
            />
          </AppTooltip>
        </template>
      </div>

      <div class="flex-1" />

      <div v-if="objects.hasSelection" class="hidden items-center gap-1 lg:flex">
        <AppTooltip text="На передний план">
          <AppButton icon="front" size="icon" variant="ghost" @click="objects.bringToFront()" />
        </AppTooltip>
        <AppTooltip text="На задний план">
          <AppButton icon="back" size="icon" variant="ghost" @click="objects.sendToBack()" />
        </AppTooltip>
        <AppTooltip text="Дублировать" shortcut="Ctrl+D">
          <AppButton icon="duplicate" size="icon" variant="ghost" @click="objects.duplicate()" />
        </AppTooltip>
        <AppTooltip text="Удалить" shortcut="Delete">
          <AppButton
            icon="trash"
            size="icon"
            variant="ghost"
            @click="objects.remove(objects.selectedIds)"
          />
        </AppTooltip>
        <div class="mx-1 h-6 w-px bg-slate-200 dark:bg-slate-700" />
      </div>

      <div class="flex items-center gap-1">
        <AppTooltip text="Повернуть страницу влево" shortcut="Alt+←">
          <AppButton
            icon="rotateLeft"
            size="icon"
            variant="ghost"
            :disabled="!pdf.isLoaded"
            @click="rotation.rotateCurrentPage(-90)"
          />
        </AppTooltip>
        <AppTooltip text="Повернуть страницу вправо" shortcut="Alt+→">
          <AppButton
            icon="rotateRight"
            size="icon"
            variant="ghost"
            :disabled="!pdf.isLoaded"
            @click="rotation.rotateCurrentPage(90)"
          />
        </AppTooltip>
        <div class="mx-1 h-6 w-px bg-slate-200 dark:bg-slate-700" />
        <AppTooltip text="Уменьшить" shortcut="Ctrl+−">
          <AppButton icon="minus" size="icon" variant="ghost" @click="editor.zoomOut()" />
        </AppTooltip>
        <div class="w-[86px]">
          <AppSelect
            size="sm"
            :model-value="editor.zoomPercent"
            :options="zoomOptions"
            @update:model-value="onZoomSelect"
          />
        </div>
        <AppTooltip text="Увеличить" shortcut="Ctrl++">
          <AppButton icon="plus" size="icon" variant="ghost" @click="editor.zoomIn()" />
        </AppTooltip>
        <AppTooltip text="Вписать по ширине" shortcut="Ctrl+0">
          <AppButton icon="fitWidth" size="icon" variant="ghost" @click="editor.fitToWidth()" />
        </AppTooltip>
        <AppTooltip text="Вписать страницу" shortcut="Ctrl+Shift+0">
          <AppButton icon="fitPage" size="icon" variant="ghost" @click="editor.fitToPage()" />
        </AppTooltip>
        <AppTooltip :text="`Сетка: ${settings.settings.showGrid ? 'вкл' : 'выкл'}`">
          <AppButton
            icon="grid"
            size="icon"
            variant="ghost"
            :active="settings.settings.showGrid"
            @click="settings.update({ showGrid: !settings.settings.showGrid })"
          />
        </AppTooltip>
      </div>
    </div>
  </header>
</template>

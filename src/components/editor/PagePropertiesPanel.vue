<script setup lang="ts">
/** Свойства документа: метаданные, страница, экспорт, шрифты. */
import { computed } from 'vue';
import { usePdfStore } from '@/stores/pdf';
import { useEditorStore } from '@/stores/editor';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';
import { useExportStore } from '@/stores/export';
import { useObjectsStore } from '@/stores/objects';
import { usePageRotation } from '@/composables/usePageRotation';
import { PAGE_SIZE_PRESETS } from '@/constants';
import { formatBytes } from '@/utils/download';
import { describePageSize, ptToMm } from '@/utils/pdf';
import AppSection from '@/components/ui/AppSection.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppToggle from '@/components/ui/AppToggle.vue';

const pdf = usePdfStore();
const editor = useEditorStore();
const settings = useSettingsStore();
const ui = useUiStore();
const exporter = useExportStore();
const objects = useObjectsStore();
const rotation = usePageRotation();

const page = computed(() => pdf.pages[editor.currentPage]);

const metadataFields = [
  { key: 'title', label: 'Название' },
  { key: 'author', label: 'Автор' },
  { key: 'subject', label: 'Тема' },
  { key: 'keywords', label: 'Ключевые слова' },
  { key: 'creator', label: 'Создатель' },
  { key: 'producer', label: 'Производитель' },
] as const;

function updateMetadata(key: string, value: string | number | null): void {
  pdf.updateMetadata({ [key]: String(value ?? '') });
  exporter.updateMetadata({ [key]: String(value ?? '') });
}

const objectsOnPage = computed(() => objects.countForPage(editor.currentPage));
</script>

<template>
  <div class="flex h-full flex-col overflow-y-auto">
    <AppSection title="Документ" icon="file">
      <dl class="space-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        <div class="flex justify-between gap-2">
          <dt>Файл</dt>
          <dd class="truncate font-medium text-slate-700 dark:text-slate-200" :title="pdf.fileName">
            {{ pdf.fileName || '—' }}
          </dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>Размер</dt>
          <dd>{{ pdf.fileSize ? formatBytes(pdf.fileSize) : '—' }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>Страниц</dt>
          <dd>{{ pdf.pageCount }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>Объектов</dt>
          <dd>{{ objects.objects.length }}</dd>
        </div>
        <div v-if="pdf.isEncrypted" class="flex justify-between gap-2 text-amber-600">
          <dt>Защита</dt>
          <dd>документ зашифрован</dd>
        </div>
      </dl>
      <AppButton size="sm" icon="info" block @click="ui.openModal('documentInfo')">
        Все свойства
      </AppButton>
    </AppSection>

    <AppSection title="Текущая страница" icon="crop">
      <dl class="space-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        <div class="flex justify-between gap-2">
          <dt>Номер</dt>
          <dd>{{ editor.currentPage + 1 }} из {{ pdf.pageCount }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>Размер в PDF</dt>
          <dd>{{ page ? `${Math.round(page.width)} × ${Math.round(page.height)} pt` : '—' }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>После поворота</dt>
          <dd>{{ page ? describePageSize(page.displayWidth, page.displayHeight) : '—' }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>Поворот страницы</dt>
          <dd>
            {{ rotation.pageRotation(editor.currentPage) }}°
            <span v-if="rotation.hasCustomRotation(editor.currentPage)" class="text-brand-600 dark:text-brand-300">
              (задан в редакторе)
            </span>
          </dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>Объектов здесь</dt>
          <dd>{{ objectsOnPage }}</dd>
        </div>
      </dl>
      <div class="flex flex-wrap gap-1">
        <AppButton size="sm" variant="ghost" @click="editor.fitToWidth()">По ширине</AppButton>
        <AppButton size="sm" variant="ghost" @click="editor.fitToPage()">Страница</AppButton>
        <AppButton size="sm" variant="ghost" @click="editor.actualSize()">100%</AppButton>
      </div>
      <AppButton
        size="sm"
        icon="trash"
        variant="ghost"
        block
        :disabled="objectsOnPage === 0"
        @click="
          ui
            .askConfirm({
              title: 'Очистить страницу?',
              text: `Будут удалены все объекты страницы (${objectsOnPage}).`,
              confirmLabel: 'Очистить',
              danger: true,
            })
            .then((ok) => ok && objects.removePage(editor.currentPage))
        "
      >
        Очистить объекты страницы
      </AppButton>
    </AppSection>

    <AppSection title="Поворот страницы" icon="rotate">
      <div class="flex gap-1">
        <AppButton
          size="sm"
          icon="rotateLeft"
          block
          @click="rotation.rotateCurrentPage(-90)"
        >
          Влево 90°
        </AppButton>
        <AppButton
          size="sm"
          icon="rotateRight"
          block
          @click="rotation.rotateCurrentPage(90)"
        >
          Вправо 90°
        </AppButton>
      </div>
      <AppSelect
        :model-value="rotation.pageRotation(editor.currentPage)"
        label="Ориентация страницы"
        size="sm"
        :options="[
          { value: 0, label: '0° — книжная' },
          { value: 90, label: '90° — поворот вправо' },
          { value: 180, label: '180° — перевёрнутая' },
          { value: 270, label: '270° — поворот влево' },
        ]"
        @update:model-value="rotation.setPageRotation(editor.currentPage, Number($event))"
      />
      <AppButton
        size="sm"
        icon="refresh"
        variant="subtle"
        block
        :disabled="!rotation.hasCustomRotation(editor.currentPage)"
        @click="rotation.resetPageRotation(editor.currentPage)"
      >
        Исходная ориентация страницы
      </AppButton>
      <div class="mt-1 space-y-1 border-t border-slate-200 pt-2 dark:border-slate-700">
        <AppButton size="sm" icon="rotateRight" variant="ghost" block @click="rotation.rotateAllPages(90)">
          Повернуть все страницы на 90° вправо
        </AppButton>
        <AppButton size="sm" icon="rotateLeft" variant="ghost" block @click="rotation.rotateAllPages(-90)">
          Повернуть все страницы на 90° влево
        </AppButton>
        <AppButton
          size="sm"
          icon="refresh"
          variant="ghost"
          block
          :disabled="rotation.customRotationCount() === 0"
          @click="rotation.resetPageRotation()"
        >
          Сбросить повороты ({{ rotation.customRotationCount() }})
        </AppButton>
      </div>
      <p class="text-[11px] leading-snug text-slate-400">
        Поворот сохраняется в PDF как свойство страницы, содержимое не портится.
        Аннотации переносятся вместе со страницей.
      </p>
    </AppSection>

    <AppSection title="Метаданные PDF" icon="book">
      <AppInput
        v-for="field in metadataFields"
        :key="field.key"
        :label="field.label"
        size="sm"
        :model-value="pdf.metadata[field.key]"
        @update:model-value="updateMetadata(field.key, $event)"
      />
      <p class="text-[11px] leading-snug text-slate-400">
        Метаданные записываются в PDF в Unicode — кириллица сохраняется корректно.
      </p>
    </AppSection>

    <AppSection title="Новый документ" icon="plus">
      <AppSelect
        size="sm"
        :model-value="'a4'"
        label="Формат листа"
        :options="PAGE_SIZE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))"
        @update:model-value="(value) => ui.openModal('documentInfo', { preset: value })"
      />
      <p class="text-[11px] text-slate-400">
        Создать чистый документ можно на главном экране приложения.
      </p>
    </AppSection>

    <AppSection title="Рабочая область" icon="settings">
      <AppToggle
        :model-value="settings.settings.showGrid"
        label="Сетка"
        @update:model-value="settings.update({ showGrid: $event })"
      />
      <AppToggle
        :model-value="settings.settings.snapToObjects"
        label="Привязка к объектам"
        @update:model-value="settings.update({ snapToObjects: $event })"
      />
      <AppSelect
        :model-value="settings.settings.canvasBackground"
        label="Фон области"
        size="sm"
        :options="[
          { value: 'dark', label: 'Тёмный' },
          { value: 'light', label: 'Светлый' },
          { value: 'checker', label: 'Шахматный' },
        ]"
        @update:model-value="settings.update({ canvasBackground: $event as never })"
      />
      <AppInput
        :model-value="settings.settings.gridSize"
        label="Шаг сетки, pt"
        type="number"
        size="sm"
        :min="2"
        :max="200"
        @update:model-value="settings.update({ gridSize: Number($event) || 10 })"
      />
    </AppSection>

    <AppSection title="Шрифты" icon="font">
      <p class="text-[11px] text-slate-400">
        Активный шрифт по умолчанию: {{ settings.textDefaults.fontFamily }} ({{
          Math.round(ptToMm(settings.textDefaults.fontSize) * 10) / 10
        }}
        мм)
      </p>
      <AppButton size="sm" icon="upload" block @click="ui.openModal('fonts')">
        Управление шрифтами
      </AppButton>
    </AppSection>
  </div>
</template>

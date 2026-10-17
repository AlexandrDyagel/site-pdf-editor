<script setup lang="ts">
/**
 * Библиотека: штампы, печати, подписи, рисунки, изображения.
 * Элементы хранятся в IndexedDB и переживают перезагрузку страницы.
 */
import { computed, ref } from 'vue';
import type { DrawingTemplate, ImageTemplate, LibraryItemType, SignatureTemplate, StampTemplate } from '@/types';
import { LIBRARY_TYPE_LABELS } from '@/constants';
import { useLibraryStore } from '@/stores/library';
import { useEditorStore } from '@/stores/editor';
import { useObjectsStore } from '@/stores/objects';
import { useUiStore } from '@/stores/ui';
import { usePdfStore } from '@/stores/pdf';
import { createStampObject, createSignatureObject, createDrawingObject, createImageObject } from '@/services/objectFactory';
import { downloadBlob, downloadText } from '@/utils/download';
import { buildJson } from '@/utils/encoding';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppEmptyState from '@/components/ui/AppEmptyState.vue';
import AppSpinner from '@/components/ui/AppSpinner.vue';
import AppTooltip from '@/components/ui/AppTooltip.vue';

const library = useLibraryStore();
const editor = useEditorStore();
const objects = useObjectsStore();
const ui = useUiStore();
const pdf = usePdfStore();

const search = ref('');
const importInput = ref<HTMLInputElement | null>(null);

const typeTabs: { id: LibraryItemType; label: string; icon: string }[] = [
  { id: 'stamp', label: 'Штампы', icon: 'stamp' },
  { id: 'seal', label: 'Печати', icon: 'seal' },
  { id: 'signature', label: 'Подписи', icon: 'signature' },
  { id: 'drawing', label: 'Рисунки', icon: 'brush' },
  { id: 'image', label: 'Картинки', icon: 'image' },
];

const items = computed(() => {
  const query = search.value.trim().toLowerCase();
  return library.items
    .filter((item) => item.type === library.activeType)
    .filter((item) =>
      query
        ? item.name.toLowerCase().includes(query) ||
          (item.tags ?? []).some((tag) => tag.toLowerCase().includes(query))
        : true,
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
});

/** Точка вставки: центр текущей страницы. */
function insertionPoint(): { x: number; y: number } {
  const size = editor.pageSize;
  return { x: size.width / 2, y: size.height / 2 };
}

/** Вставка элемента в документ. */
function insertItem(id: string): void {
  const record = library.byId(id);
  if (!record) return;
  const at = insertionPoint();

  if (record.type === 'stamp' || record.type === 'seal') {
    const template = record.data as StampTemplate;
    const object = createStampObject(template, {
      page: editor.currentPage,
      x: at.x - template.width / 2,
      y: at.y - template.height / 2,
      templateId: template.id,
    });
    objects.add([object], 'Добавление штампа');
    editor.toolOptions.lastStampId = template.id;
    return;
  }

  if (record.type === 'signature') {
    const template = record.data as SignatureTemplate;
    const object = createSignatureObject({
      page: editor.currentPage,
      x: at.x - template.designWidth / 2,
      y: at.y - template.designHeight / 2,
      width: template.designWidth,
      height: template.designHeight,
      strokes: template.strokes,
      color: template.color,
      strokeWidth: template.strokeWidth,
      svg: template.svg ?? null,
      png: template.png ?? null,
      modelId: template.id,
    });
    objects.add([object], 'Добавление подписи');
    editor.toolOptions.lastSignatureId = template.id;
    return;
  }

  if (record.type === 'drawing') {
    const template = record.data as DrawingTemplate;
    const object = createDrawingObject(template.strokes, {
      page: editor.currentPage,
      name: template.name,
    });
    if (object) {
      object.x = at.x - object.width / 2;
      object.y = at.y - object.height / 2;
      objects.add([object], 'Добавление рисунка');
    }
    return;
  }

  const template = record.data as ImageTemplate;
  const maxWidth = editor.pageSize.width * 0.4;
  const scale = Math.min(1, maxWidth / Math.max(1, template.naturalWidth));
  objects.add(
    [
      createImageObject({
        page: editor.currentPage,
        x: at.x - (template.naturalWidth * scale) / 2,
        y: at.y - (template.naturalHeight * scale) / 2,
        width: Math.max(24, template.naturalWidth * scale),
        height: Math.max(24, template.naturalHeight * scale),
        src: template.src,
        mimeType: template.mimeType,
        naturalWidth: template.naturalWidth,
        naturalHeight: template.naturalHeight,
        alt: template.name,
      }),
    ],
    'Добавление изображения',
  );
}

function editItem(id: string): void {
  const record = library.byId(id);
  if (!record) return;
  if (record.type === 'stamp' || record.type === 'seal') {
    ui.openModal('stampEditor', { templateId: id });
    return;
  }
  if (record.type === 'signature') {
    ui.openModal('signatureEditor', { signatureId: id });
    return;
  }
  if (record.type === 'drawing') {
    ui.openModal('drawingEditor', { drawingId: id });
    return;
  }
  ui.notify.info('Изображение', 'Изображения из библиотеки можно только вставлять и переименовывать.');
}

async function removeItem(id: string): Promise<void> {
  const record = library.byId(id);
  if (!record) return;
  const confirmed = await ui.askConfirm({
    title: 'Удалить элемент библиотеки?',
    text: `${record.name}${pdf.isLoaded ? '' : ''}`,
    confirmLabel: 'Удалить',
    danger: true,
  });
  if (!confirmed) return;
  await library.removeItem(id);
  ui.notify.info('Элемент удалён из библиотеки', record.name);
}

async function renameItem(id: string): Promise<void> {
  const record = library.byId(id);
  if (!record) return;
  const name = window.prompt('Новое имя элемента', record.name);
  if (!name) return;
  await library.updateItem(id, { name: name.trim() });
}

/** Экспорт одного элемента в JSON. */
function exportItem(id: string): void {
  const record = library.byId(id);
  if (!record) return;
  downloadText(
    buildJson({ schemaVersion: 2, app: 'pdf-editor', exportedAt: new Date().toISOString(), items: [record] }),
    `${record.name.replace(/[\\/:*?"<>|]/g, '_')}.json`,
    'application/json;charset=utf-8',
  );
}

/** Экспорт всей библиотеки. */
async function exportAll(): Promise<void> {
  const json = await library.exportJson();
  downloadBlob(
    new Blob([json], { type: 'application/json;charset=utf-8' }),
    `pdf-editor-library-${new Date().toISOString().slice(0, 10)}.json`,
  );
  ui.notify.success('Библиотека экспортирована');
}

/** Импорт библиотеки из файла. */
async function onImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const result = await library.importJson(text);
    ui.notify.success(
      'Библиотека импортирована',
      `Добавлено: ${result.added}, обновлено: ${result.updated}, пропущено: ${result.skipped}`,
    );
  } catch (error) {
    ui.notify.error('Не удалось импортировать', error instanceof Error ? error.message : String(error));
  }
}

async function clearCategory(): Promise<void> {
  const confirmed = await ui.askConfirm({
    title: `Очистить раздел «${LIBRARY_TYPE_LABELS[library.activeType]}»?`,
    text: 'Действие необратимо. Экспортируйте библиотеку заранее, если она нужна.',
    confirmLabel: 'Очистить',
    danger: true,
  });
  if (!confirmed) return;
  await library.clearType(library.activeType);
  ui.notify.info('Раздел очищен');
}

function countOf(type: LibraryItemType): number {
  return library.items.filter((item) => item.type === type).length;
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
      <div class="mb-2 grid grid-cols-5 gap-1">
        <AppTooltip v-for="tab in typeTabs" :key="tab.id" :text="tab.label">
          <button
            type="button"
            class="flex h-8 w-full items-center justify-center rounded-lg transition-colors"
            :class="
              library.activeType === tab.id
                ? 'bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-200'
                : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
            "
            @click="library.activeType = tab.id"
          >
            <AppIcon :name="tab.icon" :size="16" />
          </button>
        </AppTooltip>
      </div>
      <AppInput v-model="search" size="sm" type="search" placeholder="Поиск по библиотеке…" />
    </div>

    <div class="flex items-center justify-between px-3 py-1.5 text-[11px] text-slate-400">
      <span>{{ LIBRARY_TYPE_LABELS[library.activeType] }}: {{ countOf(library.activeType) }}</span>
      <AppButton
        size="xs"
        variant="ghost"
        icon="plus"
        @click="
          library.activeType === 'signature'
            ? ui.openModal('signatureEditor')
            : library.activeType === 'drawing'
              ? ui.openModal('drawingEditor')
              : library.activeType === 'image'
                ? ui.openModal('imageLibrary')
                : ui.openModal('stampEditor', { kind: library.activeType === 'seal' ? 'seal' : 'stamp' })
        "
      >
        Создать
      </AppButton>
    </div>

    <div v-if="library.isLoading" class="flex flex-1 items-center justify-center">
      <AppSpinner :size="20" label="Загрузка библиотеки…" />
    </div>

    <div v-else-if="items.length === 0" class="flex-1">
      <AppEmptyState
        compact
        icon="book"
        title="Библиотека пуста"
        text="Создайте штамп, печать или подпись — они сохранятся локально и будут доступны после перезагрузки."
      />
    </div>

    <div v-else class="flex-1 space-y-2 overflow-y-auto p-2">
      <div
        v-for="item in items"
        :key="item.id"
        class="group rounded-xl border border-slate-200 bg-white p-2 transition-shadow hover:shadow-panel dark:border-slate-700 dark:bg-slate-900"
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 text-left"
          @click="insertItem(item.id)"
        >
          <span
            class="checker-bg flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700"
          >
            <img
              v-if="item.preview"
              :src="item.preview"
              :alt="item.name"
              class="h-full w-full object-contain"
              loading="lazy"
            />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[12px] font-medium text-slate-700 dark:text-slate-200">
              {{ item.name }}
            </span>
            <span class="block text-[10px] text-slate-400">
              {{ new Date(item.updatedAt).toLocaleDateString('ru-RU') }}
              <template v-if="item.tags?.length"> · {{ item.tags.join(', ') }}</template>
            </span>
          </span>
        </button>

        <div class="mt-1.5 flex items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
          <AppButton size="xs" variant="subtle" icon="plus" @click="insertItem(item.id)">
            Вставить
          </AppButton>
          <AppTooltip text="Редактировать">
            <AppButton size="xs" variant="ghost" icon="settings" @click="editItem(item.id)" />
          </AppTooltip>
          <AppTooltip text="Переименовать">
            <AppButton size="xs" variant="ghost" icon="type" @click="renameItem(item.id)" />
          </AppTooltip>
          <AppTooltip text="Копия">
            <AppButton
              size="xs"
              variant="ghost"
              icon="copy"
              @click="library.duplicateItem(item.id)"
            />
          </AppTooltip>
          <AppTooltip text="Экспорт в JSON">
            <AppButton size="xs" variant="ghost" icon="download" @click="exportItem(item.id)" />
          </AppTooltip>
          <div class="flex-1" />
          <AppTooltip text="Удалить">
            <AppButton size="xs" variant="ghost" icon="trash" @click="removeItem(item.id)" />
          </AppTooltip>
        </div>
      </div>
    </div>

    <div class="space-y-1.5 border-t border-slate-200 p-2 dark:border-slate-800">
      <div class="flex gap-1.5">
        <AppButton size="sm" variant="ghost" icon="upload" block @click="importInput?.click()">
          Импорт
        </AppButton>
        <AppButton size="sm" variant="ghost" icon="download" block @click="exportAll">
          Экспорт
        </AppButton>
      </div>
      <AppButton
        size="sm"
        variant="ghost"
        icon="trash"
        block
        :disabled="countOf(library.activeType) === 0"
        @click="clearCategory"
      >
        Очистить раздел
      </AppButton>
      <p v-if="!library.persistent" class="text-[10px] leading-snug text-amber-600">
        Локальное хранилище недоступно: библиотека не сохранится после перезагрузки.
      </p>
      <input
        ref="importInput"
        type="file"
        accept="application/json,.json"
        class="hidden"
        @change="onImportFile"
      />
    </div>
  </div>
</template>

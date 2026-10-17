<script setup lang="ts">
/** Библиотека изображений: загрузка в библиотеку и вставка в документ. */
import { computed, ref } from 'vue';
import type { ImageTemplate } from '@/types';
import { createId } from '@/utils/id';
import { createImageObject } from '@/services/objectFactory';
import { ACCEPT, openFileDialog, readImageFile } from '@/services/fileService';
import { useUiStore } from '@/stores/ui';
import { useLibraryStore } from '@/stores/library';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppEmptyState from '@/components/ui/AppEmptyState.vue';
import AppInput from '@/components/ui/AppInput.vue';

const ui = useUiStore();
const library = useLibraryStore();
const objects = useObjectsStore();
const editor = useEditorStore();

const search = ref('');
const uploading = ref(false);

const isOpen = computed({
  get: () => ui.modals.imageLibrary,
  set: (value: boolean) => (value ? ui.openModal('imageLibrary') : ui.closeModal('imageLibrary')),
});

const images = computed(() => {
  const query = search.value.trim().toLowerCase();
  return library.images
    .filter((image) => (query ? image.name.toLowerCase().includes(query) : true))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
});

/** Загрузка изображений в библиотеку. */
async function upload(): Promise<void> {
  const files = await openFileDialog({ accept: ACCEPT.images, multiple: true });
  if (files.length === 0) return;
  uploading.value = true;
  try {
    for (const file of files) {
      const image = await readImageFile(file);
      const now = new Date().toISOString();
      const template: ImageTemplate = {
        id: createId('image'),
        name: file.name.replace(/\.[^.]+$/, ''),
        src: image.src,
        mimeType: image.mimeType,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        createdAt: now,
        updatedAt: now,
        tags: [],
        preview: image.src,
      };
      await library.saveImage(template);
    }
    ui.notify.success('Изображения добавлены в библиотеку', `${files.length} шт.`);
  } finally {
    uploading.value = false;
  }
}

/** Вставка изображения из библиотеки на страницу. */
function insert(image: ImageTemplate): void {
  const size = editor.pageSize;
  const maxWidth = size.width * 0.45;
  const scale = Math.min(1, maxWidth / Math.max(1, image.naturalWidth));
  const width = Math.max(24, image.naturalWidth * scale);
  const height = Math.max(24, image.naturalHeight * scale);
  objects.add(
    [
      createImageObject({
        page: editor.currentPage,
        x: (size.width - width) / 2,
        y: (size.height - height) / 2,
        width,
        height,
        src: image.src,
        mimeType: image.mimeType,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        alt: image.name,
      }),
    ],
    'Добавление изображения',
  );
  ui.closeModal('imageLibrary');
  ui.notify.success('Изображение добавлено на страницу', image.name);
}

async function remove(image: ImageTemplate): Promise<void> {
  const record = library.items.find((item) => item.id === image.id);
  if (!record) return;
  const confirmed = await ui.askConfirm({
    title: 'Удалить изображение?',
    text: image.name,
    confirmLabel: 'Удалить',
    danger: true,
  });
  if (confirmed) await library.removeItem(record.id);
}
</script>

<template>
  <AppModal
    v-model="isOpen"
    title="Библиотека изображений"
    subtitle="Логотипы, бланки и картинки, часто используемые в документах"
    icon="image"
    width="lg"
  >
    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <AppButton icon="upload" :loading="uploading" @click="upload">
          Добавить изображения
        </AppButton>
        <div class="min-w-48 flex-1">
          <AppInput v-model="search" size="sm" type="search" placeholder="Поиск…" />
        </div>
      </div>

      <AppEmptyState
        v-if="images.length === 0"
        icon="image"
        title="Изображений нет"
        text="Загрузите PNG, JPEG или SVG — они сохранятся в браузере и будут доступны позже."
      />

      <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <div
          v-for="image in images"
          :key="image.id"
          class="group overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700"
        >
          <button type="button" class="block w-full" @click="insert(image)">
            <span class="checker-bg flex h-24 items-center justify-center">
              <img :src="image.src" :alt="image.name" class="max-h-24 max-w-full object-contain" />
            </span>
          </button>
          <div class="space-y-1 p-2">
            <p class="truncate text-[11px] font-medium text-slate-700 dark:text-slate-200">
              {{ image.name }}
            </p>
            <p class="text-[10px] text-slate-400">
              {{ image.naturalWidth }} × {{ image.naturalHeight }} px
            </p>
            <div class="flex gap-1">
              <AppButton size="xs" variant="subtle" icon="plus" @click="insert(image)">
                Вставить
              </AppButton>
              <AppButton size="xs" variant="ghost" icon="trash" @click="remove(image)" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <AppButton variant="ghost" @click="ui.closeModal('imageLibrary')">Закрыть</AppButton>
    </template>
  </AppModal>
</template>

/**
 * ============================================================================
 *  Библиотека: штампы, печати, подписи, рисунки, изображения.
 * ============================================================================
 *
 *  Всё хранится в IndexedDB (см. `storageService`), поэтому библиотека
 *  переживает перезагрузку страницы. Поддерживается импорт/экспорт в JSON
 *  как всей библиотеки, так и отдельных элементов.
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type {
  DrawingTemplate,
  ImageTemplate,
  LibraryItemType,
  LibraryRecord,
  SignatureTemplate,
  StampTemplate,
} from '@/types';
import { createId, hashString } from '@/utils/id';
import { storageService } from '@/services/storageService';
import { cloneStampTemplate } from '@/services/stampRenderService';
import { renderStampPreview, renderStrokesPreview } from '@/services/imageExportService';

export const useLibraryStore = defineStore('library', () => {
  const items = ref<LibraryRecord[]>([]);
  const isLoading = ref(false);
  const isSaving = ref(false);
  const error = ref<string | null>(null);
  const persistent = ref(true);
  const activeType = ref<LibraryItemType>('stamp');
  const query = ref('');
  const tagFilter = ref<string | null>(null);

  /* ======================== Геттеры ======================== */

  const stamps = computed(
    () =>
      items.value
        .filter((item) => item.type === 'stamp')
        .map((item) => item.data as StampTemplate)
        .filter(Boolean),
  );

  const seals = computed(
    () =>
      items.value
        .filter((item) => item.type === 'seal')
        .map((item) => item.data as StampTemplate)
        .filter(Boolean),
  );

  const signatures = computed(
    () =>
      items.value
        .filter((item) => item.type === 'signature')
        .map((item) => item.data as SignatureTemplate)
        .filter(Boolean),
  );

  const drawings = computed(
    () =>
      items.value
        .filter((item) => item.type === 'drawing')
        .map((item) => item.data as DrawingTemplate)
        .filter(Boolean),
  );

  const images = computed(
    () =>
      items.value
        .filter((item) => item.type === 'image')
        .map((item) => item.data as ImageTemplate)
        .filter(Boolean),
  );

  const counts = computed<Record<LibraryItemType, number>>(() => ({
    stamp: stamps.value.length,
    seal: seals.value.length,
    signature: signatures.value.length,
    drawing: drawings.value.length,
    image: images.value.length,
  }));

  const allTags = computed(() => {
    const set = new Set<string>();
    for (const item of items.value) for (const tag of item.tags ?? []) set.add(tag);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'));
  });

  /** Отфильтрованный список для панели библиотеки. */
  const filtered = computed(() => {
    const search = query.value.trim().toLowerCase();
    return items.value
      .filter((item) => item.type === activeType.value)
      .filter((item) => (tagFilter.value ? (item.tags ?? []).includes(tagFilter.value) : true))
      .filter((item) =>
        search
          ? item.name.toLowerCase().includes(search) ||
            (item.tags ?? []).some((tag) => tag.toLowerCase().includes(search))
          : true,
      )
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  });

  const isEmpty = computed(() => items.value.length === 0);

  /* ======================== Загрузка ======================== */

  async function load(): Promise<void> {
    isLoading.value = true;
    error.value = null;
    try {
      items.value = await storageService.libraryList();
      persistent.value = storageService.persistent;
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : String(loadError);
    } finally {
      isLoading.value = false;
    }
  }

  /* ======================== Сохранение элементов ======================== */

  /** Штамп или печать. */
  async function saveStamp(template: StampTemplate): Promise<LibraryRecord> {
    isSaving.value = true;
    try {
      const type: LibraryItemType = template.kind === 'seal' ? 'seal' : 'stamp';
      const now = new Date().toISOString();
      const existing = items.value.find((item) => item.id === template.id);
      const preview = await renderStampPreview(template, 2);
      const record: LibraryRecord = {
        id: template.id,
        type,
        name: template.name || 'Штамп',
        createdAt: existing?.createdAt ?? template.createdAt ?? now,
        updatedAt: now,
        tags: template.tags ?? [],
        preview,
        data: { ...template, preview, updatedAt: now },
      };
      await storageService.libraryPut(record);
      upsert(record);
      return record;
    } finally {
      isSaving.value = false;
    }
  }

  /** Подпись. */
  async function saveSignature(template: SignatureTemplate): Promise<LibraryRecord> {
    isSaving.value = true;
    try {
      const now = new Date().toISOString();
      const existing = items.value.find((item) => item.id === template.id);
      const preview = renderStrokesPreview(
        template.strokes,
        template.designWidth,
        template.designHeight,
        2,
      );
      const record: LibraryRecord = {
        id: template.id,
        type: 'signature',
        name: template.name || 'Подпись',
        createdAt: existing?.createdAt ?? template.createdAt ?? now,
        updatedAt: now,
        tags: template.tags ?? [],
        preview,
        data: { ...template, preview, updatedAt: now },
      };
      await storageService.libraryPut(record);
      upsert(record);
      return record;
    } finally {
      isSaving.value = false;
    }
  }

  /** Рисунок. */
  async function saveDrawing(template: DrawingTemplate): Promise<LibraryRecord> {
    isSaving.value = true;
    try {
      const now = new Date().toISOString();
      const existing = items.value.find((item) => item.id === template.id);
      const preview = renderStrokesPreview(
        template.strokes,
        template.designWidth,
        template.designHeight,
        2,
      );
      const record: LibraryRecord = {
        id: template.id,
        type: 'drawing',
        name: template.name || 'Рисунок',
        createdAt: existing?.createdAt ?? template.createdAt ?? now,
        updatedAt: now,
        tags: template.tags ?? [],
        preview,
        data: { ...template, preview, updatedAt: now },
      };
      await storageService.libraryPut(record);
      upsert(record);
      return record;
    } finally {
      isSaving.value = false;
    }
  }

  /** Изображение. */
  async function saveImage(template: ImageTemplate): Promise<LibraryRecord> {
    isSaving.value = true;
    try {
      const now = new Date().toISOString();
      const existing = items.value.find((item) => item.id === template.id);
      const record: LibraryRecord = {
        id: template.id,
        type: 'image',
        name: template.name || 'Изображение',
        createdAt: existing?.createdAt ?? template.createdAt ?? now,
        updatedAt: now,
        tags: template.tags ?? [],
        preview: template.src,
        data: { ...template, updatedAt: now },
      };
      await storageService.libraryPut(record);
      upsert(record);
      return record;
    } finally {
      isSaving.value = false;
    }
  }

  /** Внутреннее обновление реактивного списка. */
  function upsert(record: LibraryRecord): void {
    const index = items.value.findIndex((item) => item.id === record.id);
    if (index === -1) items.value = [...items.value, record];
    else {
      const next = items.value.slice();
      next[index] = record;
      items.value = next;
    }
  }

  /** Обновление элемента (имя, теги). */
  async function updateItem(
    id: string,
    patch: Partial<Pick<LibraryRecord, 'name' | 'tags'>>,
  ): Promise<void> {
    const record = items.value.find((item) => item.id === id);
    if (!record) return;
    const updated: LibraryRecord = {
      ...record,
      ...patch,
      updatedAt: new Date().toISOString(),
      data: { ...record.data, ...patch } as LibraryRecord['data'],
    };
    await storageService.libraryPut(updated);
    upsert(updated);
  }

  /** Удаление элемента. */
  async function removeItem(id: string): Promise<void> {
    await storageService.libraryDelete(id);
    items.value = items.value.filter((item) => item.id !== id);
  }

  /** Дублирование элемента. */
  async function duplicateItem(id: string): Promise<LibraryRecord | null> {
    const record = items.value.find((item) => item.id === id);
    if (!record) return null;
    const now = new Date().toISOString();
    const newId = createId(record.type);
    const data = JSON.parse(JSON.stringify(record.data)) as LibraryRecord['data'] & { id: string };
    data.id = newId;
    if (record.type === 'stamp' || record.type === 'seal') {
      Object.assign(data, cloneStampTemplate(data as StampTemplate, { id: newId }));
    }
    const copyRecord: LibraryRecord = {
      ...record,
      id: newId,
      name: `${record.name} (копия)`,
      createdAt: now,
      updatedAt: now,
      data,
    };
    await storageService.libraryPut(copyRecord);
    upsert(copyRecord);
    return copyRecord;
  }

  /** Очистка категории. */
  async function clearType(type: LibraryItemType): Promise<void> {
    await storageService.libraryClear(type);
    items.value = items.value.filter((item) => item.type !== type);
  }

  /* ======================== Импорт/экспорт ======================== */

  async function exportJson(types?: LibraryItemType[]): Promise<string> {
    return storageService.exportLibrary(types);
  }

  async function importJson(json: string): Promise<{ added: number; updated: number; skipped: number }> {
    const result = await storageService.importLibrary(json);
    await load();
    return result;
  }

  /** Поиск элемента по id. */
  function byId(id: string): LibraryRecord | undefined {
    return items.value.find((item) => item.id === id);
  }

  /** Поиск штампа по id. */
  function stampById(id: string | null | undefined): StampTemplate | undefined {
    if (!id) return undefined;
    const record = items.value.find((item) => item.id === id);
    return record ? (record.data as StampTemplate) : undefined;
  }

  /** Подпись по id. */
  function signatureById(id: string | null | undefined): SignatureTemplate | undefined {
    if (!id) return undefined;
    const record = items.value.find((item) => item.id === id);
    return record ? (record.data as SignatureTemplate) : undefined;
  }

  /** Быстрый поиск по имени (для палитры команд). */
  function search(text: string, limit = 12): LibraryRecord[] {
    const search_ = text.trim().toLowerCase();
    if (!search_) return items.value.slice(0, limit);
    return items.value
      .filter(
        (item) =>
          item.name.toLowerCase().includes(search_) ||
          (item.tags ?? []).some((tag) => tag.toLowerCase().includes(search_)),
      )
      .slice(0, limit);
  }

  /** Уникальный тег для элемента. */
  function previewKeyOf(record: LibraryRecord): string {
    return `${record.id}:${hashString(record.updatedAt)}`;
  }

  return {
    items,
    isLoading,
    isSaving,
    error,
    persistent,
    activeType,
    query,
    tagFilter,
    stamps,
    seals,
    signatures,
    drawings,
    images,
    counts,
    allTags,
    filtered,
    isEmpty,
    load,
    saveStamp,
    saveSignature,
    saveDrawing,
    saveImage,
    updateItem,
    removeItem,
    duplicateItem,
    clearType,
    exportJson,
    importJson,
    byId,
    stampById,
    signatureById,
    search,
    previewKeyOf,
  };
});

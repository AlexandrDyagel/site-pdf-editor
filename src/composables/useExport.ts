/**
 * Экспорт: удобная обёртка для компонентов (модальное окно, быстрые действия).
 */

import { computed } from 'vue';
import type { ExportFormat, ExportResult } from '@/types';
import { EXPORT_FORMAT_LABELS } from '@/constants';
import { useExportStore } from '@/stores/export';
import { useUiStore } from '@/stores/ui';
import { usePdfStore } from '@/stores/pdf';
import { useObjectsStore } from '@/stores/objects';

export function useExport() {
  const store = useExportStore();
  const ui = useUiStore();
  const pdf = usePdfStore();
  const objects = useObjectsStore();

  const formats: { value: ExportFormat; label: string }[] = [
    { value: 'pdf', label: EXPORT_FORMAT_LABELS.pdf },
    { value: 'pdf-flat', label: EXPORT_FORMAT_LABELS['pdf-flat'] },
    { value: 'png', label: EXPORT_FORMAT_LABELS.png },
    { value: 'jpeg', label: EXPORT_FORMAT_LABELS.jpeg },
    { value: 'webp', label: EXPORT_FORMAT_LABELS.webp },
    { value: 'docx', label: EXPORT_FORMAT_LABELS.docx },
    { value: 'json', label: EXPORT_FORMAT_LABELS.json },
    { value: 'svg', label: EXPORT_FORMAT_LABELS.svg },
    { value: 'library', label: EXPORT_FORMAT_LABELS.library },
  ];

  function open(): void {
    if (!pdf.isLoaded) {
      ui.notify.warning('Нет открытого документа', 'Сначала загрузите PDF-файл.');
      return;
    }
    store.syncWithDocument();
    ui.openModal('export');
  }

  function close(): void {
    ui.closeModal('export');
  }

  async function run(): Promise<ExportResult> {
    const result = await store.run({ download: true });
    if (result.ok) {
      ui.notify.success('Экспорт завершён', result.fileName);
      for (const warning of result.warnings ?? []) ui.notify.warning('Предупреждение', warning);
    } else {
      ui.notify.error('Ошибка экспорта', result.error ?? 'Неизвестная ошибка');
    }
    void store.refreshPreflight();
    return result;
  }

  /**
   * Сохранение проекта в браузере (кнопка «Сохранить», Ctrl+S).
   *
   * Документ, аннотации и настройки остаются в IndexedDB — открыть их можно на
   * главной странице в блоке «Локальные проекты». PDF на диск не скачивается:
   * для этого есть «Экспорт».
   */
  async function saveProject(): Promise<void> {
    if (!pdf.isLoaded) {
      ui.notify.warning('Нет открытого документа', 'Сначала загрузите PDF-файл.');
      return;
    }
    try {
      const { isNew } = await store.saveProjectToStorage();
      ui.notify.success(
        isNew ? 'Проект сохранён в браузере' : 'Проект обновлён',
        'Открыть его можно на главной странице → «Локальные проекты».',
      );
    } catch (error) {
      ui.notify.error(
        'Не удалось сохранить проект',
        error instanceof Error ? error.message : 'Неизвестная ошибка',
      );
    }
  }

  function downloadLast(): void {
    store.downloadLast();
  }

  function formatLabel(format: ExportFormat): string {
    return EXPORT_FORMAT_LABELS[format] ?? format;
  }

  const summary = computed(() => {
    const pages = store.selectedCount;
    const objectsCount = objects.totalVisible;
    return `${pages} стр. · ${objectsCount} объектов`;
  });

  return { store, formats, open, close, run, saveProject, downloadLast, formatLabel, summary };
}

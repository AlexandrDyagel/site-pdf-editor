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

  /** Быстрое сохранение PDF с аннотациями (Ctrl+S). */
  async function quickSavePdf(): Promise<void> {
    const previous = store.settings.format;
    store.setFormat('pdf');
    const result = await store.run({ download: true });
    store.setFormat(previous);
    if (result.ok) {
      ui.notify.success('Документ сохранён', result.fileName);
      for (const warning of result.warnings ?? []) ui.notify.warning('Предупреждение', warning);
    } else {
      ui.notify.error('Не удалось сохранить PDF', result.error ?? 'Неизвестная ошибка');
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

  return { store, formats, open, close, run, quickSavePdf, downloadLast, formatLabel, summary };
}

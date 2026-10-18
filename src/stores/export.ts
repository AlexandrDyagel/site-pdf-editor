/**
 * ============================================================================
 *  Экспорт: настройки, запуск, скачивание.
 * ============================================================================
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { DEFAULT_EXPORT_SETTINGS } from '@/constants';
import type {
  EditorObject,
  ExportFormat,
  ExportResult,
  ExportSettings,
  PdfMetadata,
  SignaturePayload,
  StampPayload,
} from '@/types';
import { downloadBlob, formatBytes } from '@/utils/download';
import { buildExportFileName, extensionFor, resolveSelectedPages } from '@/utils/export';
import { documentFileName } from '@/utils/naming';
import { exportPdf, collectFontWarnings } from '@/services/pdfExportService';
import { exportPagesToImages } from '@/services/imageExportService';
import { exportDocx } from '@/services/docxExportService';
import { renderPageCanvas } from '@/services/imageExportService';
import { projectToBlob, projectFileName, serializeProject } from '@/services/projectService';
import { stampTemplateToSvg } from '@/services/stampRenderService';
import { strokesToSvg } from '@/services/strokeService';
import { storageService } from '@/services/storageService';
import { usePdfStore } from '@/stores/pdf';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useSettingsStore } from '@/stores/settings';
import { useLibraryStore } from '@/stores/library';
import { useUiStore } from '@/stores/ui';

/** Запись об экспорте (для панели «последние экспорты»). */
export interface ExportHistoryEntry {
  at: string;
  format: ExportFormat;
  fileName: string;
  size: number;
  ok: boolean;
  error?: string;
}

export const useExportStore = defineStore('export', () => {
  const pdf = usePdfStore();
  const objects = useObjectsStore();
  const editor = useEditorStore();
  const settingsStore = useSettingsStore();
  const library = useLibraryStore();
  const ui = useUiStore();

  const settings = ref<ExportSettings>({
    ...DEFAULT_EXPORT_SETTINGS,
    metadata: { ...DEFAULT_EXPORT_SETTINGS.metadata },
  });

  const isExporting = ref(false);
  const lastResult = ref<ExportResult | null>(null);
  const warnings = ref<string[]>([]);
  const history = ref<ExportHistoryEntry[]>([]);
  const preflightWarnings = ref<string[]>([]);

  const totalPages = computed(() => pdf.pageCount);
  const selectedPages = computed(() =>
    resolveSelectedPages(settings.value, pdf.pageCount, editor.currentPage),
  );
  const selectedCount = computed(() => selectedPages.value.length);
  const resultSizeLabel = computed(() =>
    lastResult.value ? formatBytes(lastResult.value.size) : '—',
  );
  const canExport = computed(() => pdf.pageCount > 0 && selectedCount.value > 0 && !isExporting.value);
  const isRasterFormat = computed(() =>
    ['png', 'jpeg', 'webp', 'pdf-flat'].includes(settings.value.format),
  );
  const needsImageScale = computed(() =>
    ['png', 'jpeg', 'webp'].includes(settings.value.format),
  );

  /* ======================== Настройки ======================== */

  function update(patch: Partial<ExportSettings>): void {
    settings.value = { ...settings.value, ...patch };
  }

  function updateMetadata(patch: Partial<PdfMetadata>): void {
    settings.value = {
      ...settings.value,
      metadata: { ...settings.value.metadata, ...patch },
    };
  }

  function setFormat(format: ExportFormat): void {
    const rasterize = format === 'pdf-flat';
    settings.value = {
      ...settings.value,
      format,
      rasterize,
      dpi: settings.value.dpi ?? settingsStore.settings.defaultDpi,
    };
    if (format === 'jpeg' && settings.value.transparentBackground) {
      settings.value.transparentBackground = false;
    }
    void refreshPreflight();
  }

  function resetSettings(): void {
    settings.value = {
      ...DEFAULT_EXPORT_SETTINGS,
      fileName: documentFileName(pdf.fileName),
      metadata: {
        ...DEFAULT_EXPORT_SETTINGS.metadata,
        ...pdf.metadata,
      },
    };
  }

  /** Синхронизация имени файла и метаданных с документом. */
  function syncWithDocument(): void {
    settings.value = {
      ...settings.value,
      fileName: settings.value.fileName && settings.value.fileName !== 'document'
        ? settings.value.fileName
        : documentFileName(pdf.fileName),
      metadata: {
        title: settings.value.metadata.title || pdf.metadata.title,
        author: settings.value.metadata.author || pdf.metadata.author,
        subject: settings.value.metadata.subject || pdf.metadata.subject,
        keywords: settings.value.metadata.keywords || pdf.metadata.keywords,
        creator: settings.value.metadata.creator || 'PDF Редактор',
        producer: settings.value.metadata.producer || 'PDF Редактор (pdf-lib)',
      },
      pages: settings.value.pages.length > 0 ? settings.value.pages : [],
    };
    void refreshPreflight();
  }

  /** Предварительные проверки (шрифты, объекты). */
  async function refreshPreflight(): Promise<void> {
    const list: string[] = [];
    if (settings.value.format === 'pdf' || settings.value.format === 'pdf-flat') {
      try {
        const fontWarnings = await collectFontWarnings(objects.objects);
        list.push(...fontWarnings);
      } catch {
        /* проверка не критична */
      }
      if (pdf.isEncrypted) {
        list.push('Документ зашифрован: экспорт PDF может быть неполным.');
      }
    }
    preflightWarnings.value = list;
  }

  /* ======================== Запуск экспорта ======================== */

  /** Общий вход для сервисов. */
  function buildInput() {
    return {
      settings: settings.value,
      objects: objects.objects,
      originalBytes: pdf.originalBytes(),
      pageGeometry: pdf.geometries(),
      // Пользовательские повороты страниц попадают в готовый PDF.
      pageViewRotations: pdf.viewRotations(),
      currentPage: editor.currentPage,
      checkGlyphs: settingsStore.settings.checkGlyphs,
      renderOriginalPage: (index: number, scale: number, transparent: boolean) =>
        pdf.renderOriginalPage(index, scale, transparent),
      onProgress: (value: number, label: string) => ui.setProgress(value, label),
    };
  }

  /** Экспорт проекта (JSON). */
  function exportProject(includeOriginal = true): ExportResult {
    const project = serializeProject({
      fileName: pdf.fileName || 'document.pdf',
      metadata: settings.value.metadata,
      pages: pdf.pages,
      objects: objects.objects,
      settings: settingsStore.settings,
      originalBytes: pdf.originalBytes(),
      includeOriginal,
    });
    const blob = projectToBlob(project);
    return {
      ok: true,
      fileName: projectFileName(pdf.fileName || 'document.pdf'),
      size: blob.size,
      blob,
      warnings: includeOriginal ? [] : ['Проект сохранён без встроенного PDF.'],
    };
  }

  /** Экспорт библиотеки. */
  async function exportLibraryJson(): Promise<ExportResult> {
    const json = await library.exportJson();
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    return {
      ok: true,
      fileName: `pdf-editor-library-${new Date().toISOString().slice(0, 10)}.json`,
      size: blob.size,
      blob,
      warnings: [],
    };
  }

  /** Экспорт выделенного объекта в SVG (штамп/печать/подпись/рисунок). */
  function exportSelectionSvg(): ExportResult {
    const selected = objects.selectedObjects;
    if (selected.length !== 1) {
      return failure('svg', 'Выберите ровно один объект (штамп, печать, подпись или рисунок).');
    }
    const obj = selected[0] as EditorObject;
    const familyOf = (fontId?: string): string => library.byId(fontId ?? '')?.name ?? 'PT Sans';
    try {
      if (obj.type === 'stamp') {
        const payload = obj.payload as StampPayload;
        const svg = stampTemplateToSvg(payload.template, () => familyOf(payload.template.fontId));
        return blobResult(svg, 'svg', 'image/svg+xml', obj.name ?? payload.template.name);
      }
      if (obj.type === 'signature' || obj.type === 'drawing') {
        const payload = obj.payload as SignaturePayload;
        const svg = strokesToSvg(payload.strokes, obj.width, obj.height, {
          scale: 1,
          background: null,
        });
        return blobResult(svg, 'svg', 'image/svg+xml', obj.name ?? 'Рисунок');
      }
      return failure('svg', 'Экспорт в SVG поддерживается для штампов, печатей, подписей и рисунков.');
    } catch (error) {
      return failure('svg', error instanceof Error ? error.message : String(error));
    }
  }

  /** Результат из SVG-строки. */
  function blobResult(svg: string, format: ExportFormat, mime: string, name: string): ExportResult {
    const blob = new Blob([svg], { type: `${mime};charset=utf-8` });
    return {
      ok: true,
      fileName: buildExportFileName({ ...settings.value, fileName: name }, extensionFor(format)),
      size: blob.size,
      blob,
      warnings: [],
    };
  }

  function failure(format: ExportFormat, message: string): ExportResult {
    return {
      ok: false,
      fileName: buildExportFileName(settings.value, extensionFor(format)),
      size: 0,
      blob: new Blob([], { type: 'application/octet-stream' }),
      warnings: [],
      error: message,
    };
  }

  /** Основное действие: выполнить экспорт в выбранном формате. */
  async function run(options: { download?: boolean } = {}): Promise<ExportResult> {
    const download = options.download ?? true;
    if (isExporting.value) return failure(settings.value.format, 'Экспорт уже выполняется');
    isExporting.value = true;
    ui.setProgress(0.02, 'Подготовка экспорта');
    let result: ExportResult;

    try {
      switch (settings.value.format) {
        case 'png':
        case 'jpeg':
        case 'webp':
          result = await exportPagesToImages(buildInput());
          break;
        case 'docx':
          result = await exportDocx({
            ...buildInput(),
            documentTitle: settings.value.metadata.title,
          });
          break;
        case 'json':
          result = exportProject(true);
          break;
        case 'library':
          result = await exportLibraryJson();
          break;
        case 'svg':
          result = exportSelectionSvg();
          break;
        case 'pdf-flat':
        case 'pdf':
        default:
          result = await exportPdf(buildInput());
          break;
      }
    } catch (error) {
      result = failure(
        settings.value.format,
        error instanceof Error ? error.message : String(error),
      );
    }

    isExporting.value = false;
    lastResult.value = result;
    warnings.value = result.warnings ?? [];
    history.value = [
      {
        at: new Date().toISOString(),
        format: result.ok ? settings.value.format : settings.value.format,
        fileName: result.fileName,
        size: result.size,
        ok: result.ok,
        error: result.error,
      },
      ...history.value,
    ].slice(0, 12);
    ui.clearProgress();

    if (result.ok && download) {
      downloadBlob(result.blob, result.fileName);
    }
    return result;
  }

  /** Скачать последний результат повторно. */
  function downloadLast(): void {
    const result = lastResult.value;
    if (!result?.ok) return;
    downloadBlob(result.blob, result.fileName);
  }

  /** Рендер одной страницы в canvas (для предпросмотра экспорта). */
  async function previewPage(pageIndex: number, scale = 1) {
    const geometry = pdf.geometry(pageIndex);
    const background = await pdf.renderOriginalPage(pageIndex, scale, false);
    return renderPageCanvas({
      pageIndex,
      scale,
      geometry,
      objects: objects.objects,
      backgroundCanvas: background,
      transparent: false,
    });
  }

  /** Проверка, что в библиотеке есть хотя бы один штамп. */
  const libraryEmpty = computed(() => library.items.length === 0);

  /**
   * Сохранение проекта в IndexedDB.
   *
   * Идентификатор: проект, из которого открыт документ, иначе отпечаток файла,
   * иначе новый id. Так повторное нажатие «Сохранить» обновляет тот же проект,
   * а разные документы не затирают друг друга.
   */
  async function saveProjectToStorage(): Promise<{ id: string; isNew: boolean }> {
    const previous = pdf.currentProjectId ?? pdf.fingerprint ?? null;
    const id = previous ?? `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const project = serializeProject({
      fileName: pdf.fileName || 'document.pdf',
      metadata: settings.value.metadata,
      pages: pdf.pages,
      objects: objects.objects,
      settings: settingsStore.settings,
      originalBytes: pdf.originalBytes(),
      includeOriginal: false,
    });
    await storageService.projectSave(id, project);
    pdf.currentProjectId = id;
    return { id, isNew: previous === null };
  }

  return {
    settings,
    isExporting,
    lastResult,
    warnings,
    history,
    preflightWarnings,
    totalPages,
    selectedPages,
    selectedCount,
    resultSizeLabel,
    canExport,
    isRasterFormat,
    needsImageScale,
    libraryEmpty,
    update,
    updateMetadata,
    setFormat,
    resetSettings,
    syncWithDocument,
    refreshPreflight,
    run,
    downloadLast,
    previewPage,
    exportProject,
    exportLibraryJson,
    exportSelectionSvg,
    saveProjectToStorage,
    failure,
  };
});

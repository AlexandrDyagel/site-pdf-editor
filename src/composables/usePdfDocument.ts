/**
 * ============================================================================
 *  Загрузка документов и проектов.
 * ============================================================================
 */

import { ref } from 'vue';
import type { PageGeometry } from '@/utils/coordinates';
import { PAGE_SIZE_PRESETS } from '@/constants';
import { ACCEPT, openFileDialog, readPdfFile, warnIfLarge } from '@/services/fileService';
import { projectFileName, readProjectFile, serializeProject } from '@/services/projectService';
import { downloadBlob } from '@/utils/download';
import { usePdfStore } from '@/stores/pdf';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';
import { useHistoryStore } from '@/stores/history';
import { clearImageCache } from '@/services/konvaObjectFactory';
import { pdfService } from '@/services/pdfService';

export interface OpenDocumentResult {
  ok: boolean;
  needsPassword?: boolean;
  error?: string | null;
  warning?: string | null;
}

export function usePdfDocument(): {
  isOpening: ReturnType<typeof ref<boolean>>;
  openFile: (file: File, password?: string) => Promise<OpenDocumentResult>;
  openFromDialog: () => Promise<OpenDocumentResult>;
  openProject: (file: File) => Promise<OpenDocumentResult>;
  openProjectFromDialog: () => Promise<OpenDocumentResult>;
  saveProject: (includeOriginal?: boolean) => void;
  createBlankDocument: (presetId?: string) => void;
  closeDocument: () => Promise<void>;
  reportError: (error: unknown) => void;
} {
  const pdf = usePdfStore();
  const objects = useObjectsStore();
  const editor = useEditorStore();
  const settings = useSettingsStore();
  const ui = useUiStore();
  const history = useHistoryStore();

  const isOpening = ref(false);

  /** Сброс состояния редактора под новый документ. */
  function resetEditorState(): void {
    objects.clearAll(false);
    history.clear();
    editor.setCurrentPage(0);
    editor.cancelDrafts();
    editor.stopTextEditing();
    editor.tool = 'select';
    clearImageCache();
  }

  /** Открытие PDF-файла. */
  async function openFile(file: File, password?: string): Promise<OpenDocumentResult> {
    isOpening.value = true;
    ui.setProgress(0.05, 'Открытие документа', file.name);
    try {
      const warning = warnIfLarge(
        file.size,
        settings.settings.largeFileThresholdMb,
        settings.settings.warnLargeFiles,
      );
      const outcome = await pdf.loadFile(file, password);
      if (outcome.needsPassword) {
        isOpening.value = false;
        ui.clearProgress();
        return { ok: false, needsPassword: true };
      }
      if (!outcome.ok) {
        isOpening.value = false;
        ui.clearProgress();
        ui.notify.error('Не удалось открыть документ', outcome.error ?? undefined);
        return { ok: false, error: outcome.error };
      }

      resetEditorState();
      editor.fitToWidth();
      ui.setProgress(0.9, 'Подготовка страниц');
      await pdf.ensureThumbnails(0, Math.min(7, pdf.pageCount - 1));
      ui.clearProgress();
      ui.notify.success('Документ открыт', `${file.name} · страниц: ${pdf.pageCount}`);
      if (outcome.warning ?? warning) {
        ui.notify.warning('Внимание', outcome.warning ?? warning ?? undefined);
      }
      return { ok: true, warning: warning ?? null };
    } catch (error) {
      ui.clearProgress();
      const message = error instanceof Error ? error.message : String(error);
      ui.notify.error('Ошибка открытия', message);
      return { ok: false, error: message };
    } finally {
      isOpening.value = false;
    }
  }

  /** Открытие через диалог. */
  async function openFromDialog(): Promise<OpenDocumentResult> {
    const files = await openFileDialog({ accept: ACCEPT.pdf });
    if (files.length === 0) return { ok: false };
    return openFile(files[0]);
  }

  /** Открытие проекта (JSON). */
  async function openProject(file: File): Promise<OpenDocumentResult> {
    isOpening.value = true;
    ui.setProgress(0.1, 'Открытие проекта', file.name);
    try {
      const project = await readProjectFile(file);
      const outcome = await pdf.loadFromProject(project);
      if (!outcome.ok) {
        ui.clearProgress();
        ui.notify.error('Не удалось открыть проект', outcome.error ?? undefined);
        return { ok: false, error: outcome.error };
      }
      objects.replaceAll(project.objects, false);
      history.clear();
      editor.setCurrentPage(0);
      editor.fitToWidth();
      if (project.settings) {
        settings.update({
          showGrid: project.settings.showGrid ?? settings.settings.showGrid,
          snapToObjects: project.settings.snapToObjects ?? settings.settings.snapToObjects,
          defaultFontId: project.settings.defaultFontId ?? settings.settings.defaultFontId,
        });
      }
      ui.clearProgress();
      ui.notify.success(
        'Проект открыт',
        `${project.objects.length} объектов · страниц: ${project.pages.length}`,
      );
      if (outcome.warning) ui.notify.warning('Внимание', outcome.warning);
      return { ok: true, warning: outcome.warning ?? null };
    } catch (error) {
      ui.clearProgress();
      const message = error instanceof Error ? error.message : String(error);
      ui.notify.error('Ошибка открытия проекта', message);
      return { ok: false, error: message };
    } finally {
      isOpening.value = false;
    }
  }

  /** Открытие проекта через диалог. */
  async function openProjectFromDialog(): Promise<OpenDocumentResult> {
    const files = await openFileDialog({ accept: ACCEPT.project });
    if (files.length === 0) return { ok: false };
    return openProject(files[0]);
  }

  /** Сохранение проекта в файл. */
  function saveProject(includeOriginal = true): void {
    const project = serializeProject({
      fileName: pdf.fileName || 'document.pdf',
      metadata: pdf.metadata,
      pages: pdf.pages,
      objects: objects.objects,
      settings: settings.settings,
      originalBytes: pdf.originalBytes(),
      includeOriginal,
    });
    const blob = new Blob([JSON.stringify(project, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const name = pdf.fileName ? projectFileName(pdf.fileName) : 'project.json';
    downloadBlob(blob, name);
    ui.notify.success('Проект сохранён', name);
  }

  /** Новый пустой документ. */
  function createBlankDocument(presetId = 'a4'): void {
    const preset = PAGE_SIZE_PRESETS.find((item) => item.id === presetId) ?? PAGE_SIZE_PRESETS[0];
    const geometry: PageGeometry = {
      width: preset.width,
      height: preset.height,
      rotation: 0,
      originX: 0,
      originY: 0,
    };
    void pdfService.reset();
    pdf.setBytes(null);
    pdf.setPagesFromGeometry([geometry], 'Новый документ.pdf');
    resetEditorState();
    editor.fitToPage();
    ui.notify.info('Создан пустой документ', `${preset.label} · 1 страница`);
  }

  /** Закрытие документа с подтверждением. */
  async function closeDocument(): Promise<void> {
    if (!pdf.isLoaded) return;
    if (objects.objects.length > 0) {
      const confirmed = await ui.askConfirm({
        title: 'Закрыть документ?',
        text: 'Все несохранённые аннотации будут потеряны. Сохранить проект можно кнопкой «Сохранить» (Ctrl+S).',
        confirmLabel: 'Закрыть без сохранения',
        danger: true,
      });
      if (!confirmed) return;
    }
    resetEditorState();
    await pdf.clear();
    ui.notify.info('Документ закрыт');
  }

  /** Единая точка сообщения об ошибке. */
  function reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    ui.notify.error('Ошибка', message);
  }

  return {
    isOpening,
    openFile,
    openFromDialog,
    openProject,
    openProjectFromDialog,
    saveProject,
    createBlankDocument,
    closeDocument,
    reportError,
  };
}

/** Re-export для удобства компонентов. */
export { readPdfFile };

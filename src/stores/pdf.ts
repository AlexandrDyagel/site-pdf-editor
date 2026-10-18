/**
 * ============================================================================
 *  Хранилище документа PDF.
 * ============================================================================
 *
 *  Хранит состояние страниц, метаданные и миниатюры. Сами байты файла
 *  держатся вне реактивности (тяжёлый ArrayBuffer не должен становиться
 *  реактивным), доступ — через методы `originalBytes`/`setBytes`.
 */

import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { PdfDocumentState, PdfMetadata, PdfPageState, ProjectFile } from '@/types';
import type { PageGeometry } from '@/utils/coordinates';
import { effectivePageRotation, extraPageRotation, getDisplaySize } from '@/utils/coordinates';
import { pdfService } from '@/services/pdfService';
import { storageService } from '@/services/storageService';
import { decodeOriginalPdf } from '@/services/projectService';
import { readPdfFile } from '@/services/fileService';
import { formatBytes } from '@/utils/download';

/** Результат загрузки файла. */
export interface LoadOutcome {
  ok: boolean;
  needsPassword?: boolean;
  error?: string | null;
  warning?: string | null;
}

/** Метаданные по умолчанию. */
function emptyMetadata(): PdfMetadata {
  return {
    title: '',
    author: '',
    subject: '',
    keywords: '',
    creator: 'PDF Редактор',
    producer: 'PDF Редактор (pdf-lib)',
  };
}

export const usePdfStore = defineStore('pdf', () => {
  const fileName = ref('');
  const fileSize = ref(0);
  const numPages = ref(0);
  const pages = ref<PdfPageState[]>([]);
  const metadata = ref<PdfMetadata>(emptyMetadata());
  const isLoading = ref(false);
  const isLoaded = ref(false);
  const isEncrypted = ref(false);
  const isRestricted = ref(false);
  const needsPassword = ref(false);
  const fingerprint = ref<string | null>(null);
  /**
   * Проект в локальном хранилище, из которого открыт документ.
   * Нужен, чтобы кнопка «Сохранить» обновляла тот же проект, а не создавала
   * новый при каждом нажатии.
   */
  const currentProjectId = ref<string | null>(null);
  const error = ref<string | null>(null);
  const loadProgress = ref(0);
  const lastPassword = ref<string | undefined>(undefined);

  /** Оригинальные байты (вне реактивности). */
  const bytes = shallowRef<Uint8Array | null>(null);

  const pageCount = computed(() => pages.value.length);
  const hasDocument = computed(() => isLoaded.value && pages.value.length > 0);
  const fileSizeLabel = computed(() => formatBytes(fileSize.value));
  const isEmpty = computed(() => !isLoaded.value && !isLoading.value && !error.value);

  /** Полное состояние документа (для сериализации). */
  const state = computed<PdfDocumentState>(() => ({
    fileName: fileName.value,
    fileSize: fileSize.value,
    numPages: numPages.value,
    isLoaded: isLoaded.value,
    isLoading: isLoading.value,
    isEncrypted: isEncrypted.value,
    needsPassword: needsPassword.value,
    isRestricted: isRestricted.value,
    fingerprint: fingerprint.value,
    metadata: metadata.value,
    pages: pages.value,
    error: error.value,
  }));

  /** Геометрия страницы для системы координат (с учётом поворота пользователя). */
  function geometry(index: number): PageGeometry {
    const page = pages.value[index];
    if (!page) {
      return { width: 595.28, height: 841.89, rotation: 0, originX: 0, originY: 0 };
    }
    return {
      width: page.width,
      height: page.height,
      rotation: effectivePageRotation(page),
      originX: 0,
      originY: 0,
    };
  }

  /** Геометрия всех страниц. */
  function geometries(): PageGeometry[] {
    return pages.value.map((_, index) => geometry(index));
  }

  /** Размер страницы с учётом поворота (в том числе пользовательского). */
  function displaySize(index: number): { width: number; height: number } {
    const page = pages.value[index];
    if (!page) return { width: 595.28, height: 841.89 };
    return getDisplaySize(page.width, page.height, effectivePageRotation(page));
  }

  /**
   * Установка пользовательского поворота страницы (без переноса объектов —
   * перенос выполняет `usePageRotation`).
   */
  function setViewRotation(index: number, rotation: number): void {
    const page = pages.value[index];
    if (!page) return;
    const normalized = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
    if ((page.viewRotation ?? 0) === normalized) return;
    page.viewRotation = normalized;
    // Миниатюру нужно перерисовать с новым поворотом.
    page.thumbnail = null;
    page.thumbnailStatus = 'idle';
    page.status = 'idle';
  }

  /** Массовая установка поворотов (используется историей undo/redo). */
  function setViewRotations(rotations: readonly number[]): void {
    pages.value.forEach((page, index) => {
      const value = rotations[index];
      if (typeof value !== 'number') return;
      setViewRotation(index, value);
    });
  }

  /** Текущие пользовательские повороты всех страниц. */
  function viewRotations(): number[] {
    return pages.value.map((page) => extraPageRotation(page));
  }

  /** Загрузка документа из байтов. */
  async function loadBytes(
    data: Uint8Array,
    name: string,
    password?: string,
  ): Promise<LoadOutcome> {
    isLoading.value = true;
    error.value = null;
    needsPassword.value = false;
    // Открыли другой документ — связь с сохранённым проектом теряется.
    currentProjectId.value = null;
    loadProgress.value = 0.1;
    try {
      const result = await pdfService.load(data, { password, fileName: name });
      loadProgress.value = 0.9;

      if (result.needsPassword) {
        needsPassword.value = true;
        isLoading.value = false;
        return { ok: false, needsPassword: true, error: null };
      }

      bytes.value = new Uint8Array(data);
      lastPassword.value = password;
      fileName.value = name;
      fileSize.value = data.byteLength;
      numPages.value = result.numPages;
      pages.value = result.pages;
      metadata.value = result.metadata;
      fingerprint.value = result.fingerprint;
      isEncrypted.value = result.isEncrypted;
      isRestricted.value = result.isRestricted;
      isLoaded.value = true;
      isLoading.value = false;
      loadProgress.value = 1;
      return { ok: true };
    } catch (loadError) {
      isLoading.value = false;
      isLoaded.value = false;
      pages.value = [];
      numPages.value = 0;
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      error.value = message;
      return { ok: false, error: message };
    }
  }

  /** Загрузка документа из файла. */
  async function loadFile(file: File, password?: string): Promise<LoadOutcome> {
    isLoading.value = true;
    error.value = null;
    try {
      const { bytes: data, name } = await readPdfFile(file);
      return await loadBytes(data, name, password);
    } catch (fileError) {
      isLoading.value = false;
      const message = fileError instanceof Error ? fileError.message : String(fileError);
      error.value = message;
      return { ok: false, error: message };
    }
  }

  /** Повторная загрузка с паролем. */
  async function unlock(password: string): Promise<LoadOutcome> {
    const data = bytes.value;
    const name = fileName.value || 'document.pdf';
    if (!data) return { ok: false, error: 'Файл документа недоступен' };
    return loadBytes(data, name, password);
  }

  /**
   * Загрузка документа из проекта: восстанавливает страницы и, если в проекте
   * есть исходный PDF, открывает его для рендера и дальнейшего экспорта.
   */
  async function loadFromProject(project: ProjectFile & { id?: string }): Promise<LoadOutcome> {
    const projectId = typeof project.id === 'string' ? project.id : null;
    let original = decodeOriginalPdf(project);
    // Проект в браузере хранит PDF отдельным ресурсом (чтобы JSON оставался
    // маленьким), поэтому достаём его оттуда, если внутри проекта файла нет.
    if ((!original || original.byteLength === 0) && projectId) {
      const stored = await storageService.assetGet<Uint8Array>(`project-pdf:${projectId}`);
      if (stored && stored.byteLength > 0) original = stored;
    }
    if (original && original.byteLength > 0) {
      const outcome = await loadBytes(original, project.fileName);
      if (!outcome.ok) return outcome;
      metadata.value = { ...metadata.value, ...project.metadata };
      fileName.value = project.fileName;
      currentProjectId.value = projectId;
      return { ok: true, warning: null };
    }

    // Проект без встроенного PDF: работаем только с аннотациями.
    await pdfService.reset();
    bytes.value = null;
    fileName.value = project.fileName;
    fileSize.value = 0;
    metadata.value = { ...emptyMetadata(), ...project.metadata };
    pages.value = project.pages.map((page, index) => ({
      ...page,
      index,
      status: 'idle',
      thumbnail: null,
      thumbnailStatus: 'idle',
    }));
    numPages.value = pages.value.length;
    isLoaded.value = true;
    isLoading.value = false;
    error.value = null;
    fingerprint.value = null;
    currentProjectId.value = projectId;
    return {
      ok: true,
      warning:
        'В проекте нет встроенного PDF: страницы отображаются схематично, экспорт возможен в PNG/JSON/DOCX.',
    };
  }

  /** Заменить оригинальные байты (например, после сохранения). */
  function setBytes(data: Uint8Array | null): void {
    bytes.value = data ? new Uint8Array(data) : null;
  }

  /** Оригинальные байты для экспорта. */
  function originalBytes(): Uint8Array | null {
    return bytes.value ? new Uint8Array(bytes.value) : null;
  }

  /** Отрисовка исходной страницы PDF (нужна сервисам экспорта). */
  async function renderOriginalPage(
    index: number,
    scale: number,
    transparent: boolean,
  ): Promise<HTMLCanvasElement | null> {
    if (!pdfService.getDocument()) return null;
    const page = pages.value[index];
    try {
      const { canvas } = await pdfService.renderPage(index, {
        scale,
        // Поворот пользователя учитывается и при отрисовке, и при экспорте.
        rotation: extraPageRotation(page ?? {}),
        background: transparent ? 'transparent' : '#ffffff',
      });
      return canvas;
    } catch {
      return null;
    }
  }

  /** Обновление статуса страницы. */
  function setPageStatus(index: number, status: PdfPageState['status'], message?: string | null): void {
    const page = pages.value[index];
    if (!page) return;
    page.status = status;
    page.error = message ?? null;
  }

  /** Установка миниатюры. */
  function setThumbnail(index: number, dataUrl: string): void {
    const page = pages.value[index];
    if (!page) return;
    page.thumbnail = dataUrl;
    page.thumbnailStatus = 'ready';
  }

  /** Миниатюры в очереди. */
  const thumbnailQueue = new Set<number>();

  /** Ленивая отрисовка миниатюры страницы. */
  async function ensureThumbnail(index: number): Promise<void> {
    const page = pages.value[index];
    if (!page || page.thumbnail || page.thumbnailStatus === 'rendering') return;
    if (!pdfService.getDocument()) return;
    if (thumbnailQueue.has(index)) return;
    thumbnailQueue.add(index);
    page.thumbnailStatus = 'rendering';
    try {
      const dataUrl = await pdfService.renderThumbnail(
        index,
        150,
        210,
        extraPageRotation(page),
      );
      setThumbnail(index, dataUrl);
    } catch {
      page.thumbnailStatus = 'error';
    } finally {
      thumbnailQueue.delete(index);
    }
  }

  /** Отрисовка миниатюр для диапазона страниц. */
  async function ensureThumbnails(from: number, to: number): Promise<void> {
    const end = Math.min(to, pages.value.length - 1);
    for (let index = Math.max(0, from); index <= end; index += 1) {
      await ensureThumbnail(index);
    }
  }

  /** Обновление метаданных (панель свойств документа). */
  function updateMetadata(patch: Partial<PdfMetadata>): void {
    metadata.value = { ...metadata.value, ...patch };
  }

  /** Установка количества страниц (например, после создания пустого документа). */
  function setPagesFromGeometry(list: PageGeometry[], name = 'Новый документ.pdf'): void {
    pages.value = list.map((geo, index) => ({
      index,
      width: geo.width,
      height: geo.height,
      rotation: geo.rotation,
      displayWidth: getDisplaySize(geo.width, geo.height, geo.rotation).width,
      displayHeight: getDisplaySize(geo.width, geo.height, geo.rotation).height,
      status: 'idle',
      thumbnail: null,
      thumbnailStatus: 'idle',
      hasTextLayer: false,
      error: null,
      renderScale: 1,
    }));
    numPages.value = pages.value.length;
    fileName.value = name;
    isLoaded.value = true;
    error.value = null;
    currentProjectId.value = null;
  }

  /** Полный сброс документа. */
  async function clear(): Promise<void> {
    await pdfService.reset();
    bytes.value = null;
    fileName.value = '';
    fileSize.value = 0;
    numPages.value = 0;
    pages.value = [];
    metadata.value = emptyMetadata();
    isLoaded.value = false;
    isLoading.value = false;
    isEncrypted.value = false;
    isRestricted.value = false;
    needsPassword.value = false;
    fingerprint.value = null;
    currentProjectId.value = null;
    error.value = null;
    loadProgress.value = 0;
    lastPassword.value = undefined;
    thumbnailQueue.clear();
  }

  return {
    // state
    fileName,
    fileSize,
    numPages,
    pages,
    metadata,
    isLoading,
    isLoaded,
    isEncrypted,
    isRestricted,
    needsPassword,
    fingerprint,
    currentProjectId,
    error,
    loadProgress,
    // getters
    pageCount,
    hasDocument,
    fileSizeLabel,
    isEmpty,
    state,
    // methods
    geometry,
    geometries,
    displaySize,
    setViewRotation,
    setViewRotations,
    viewRotations,
    loadBytes,
    loadFile,
    unlock,
    loadFromProject,
    setBytes,
    originalBytes,
    renderOriginalPage,
    setPageStatus,
    setThumbnail,
    ensureThumbnail,
    ensureThumbnails,
    updateMetadata,
    setPagesFromGeometry,
    clear,
  };
});

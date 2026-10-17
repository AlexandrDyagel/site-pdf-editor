/**
 * ============================================================================
 *  Проект: сохранение и открытие (JSON).
 * ============================================================================
 *
 *  Формат самодостаточен: объекты, страницы, метаданные, настройки и
 *  (опционально) исходный PDF в base64. Поддерживается версионирование
 *  схемы и миграция старых проектов.
 */

import { APP_NAME, APP_VERSION, PROJECT_SCHEMA_VERSION } from '@/constants';
import type {
  AppSettings,
  EditorObject,
  PdfMetadata,
  PdfPageState,
  ProjectFile,
} from '@/types';
import { getDisplaySize } from '@/utils/coordinates';
import { base64ToBytes, bytesToBase64, buildJson, parseJson } from '@/utils/encoding';
import { normalizeImportedObject } from '@/services/objectFactory';

/** Входные данные сериализации. */
export interface SerializeProjectInput {
  fileName: string;
  metadata: PdfMetadata;
  pages: PdfPageState[];
  objects: EditorObject[];
  settings: AppSettings;
  /** Оригинальный PDF (если есть). */
  originalBytes: Uint8Array | null;
  /** Встраивать ли PDF в проект (увеличивает файл примерно на треть). */
  includeOriginal?: boolean;
}

/** Приведение страницы к актуальной схеме. */
function normalizePage(raw: Partial<PdfPageState>, index: number): PdfPageState {
  const width = Number.isFinite(raw.width) ? Number(raw.width) : 595.28;
  const height = Number.isFinite(raw.height) ? Number(raw.height) : 841.89;
  const rotation = Number.isFinite(raw.rotation) ? Number(raw.rotation) : 0;
  // Поворот, добавленный пользователем в редакторе (появился в схеме 4).
  const viewRotation = Number.isFinite(raw.viewRotation) ? Number(raw.viewRotation) : 0;
  const display = getDisplaySize(width, height, rotation + viewRotation);
  return {
    index: Number.isFinite(raw.index) ? Number(raw.index) : index,
    width,
    height,
    rotation,
    viewRotation: ((viewRotation % 360) + 360) % 360,
    displayWidth: Number.isFinite(raw.displayWidth) ? Number(raw.displayWidth) : display.width,
    displayHeight: Number.isFinite(raw.displayHeight) ? Number(raw.displayHeight) : display.height,
    status: 'idle',
    error: null,
    thumbnail: null,
    thumbnailStatus: 'idle',
    hasTextLayer: Boolean(raw.hasTextLayer),
    renderScale: raw.renderScale,
  };
}

/** Сериализация проекта. */
export function serializeProject(input: SerializeProjectInput): ProjectFile {
  const includeOriginal = input.includeOriginal ?? true;
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    app: APP_NAME,
    appVersion: APP_VERSION,
    savedAt: new Date().toISOString(),
    fileName: input.fileName || 'document.pdf',
    metadata: input.metadata,
    originalPdfBase64:
      includeOriginal && input.originalBytes ? bytesToBase64(input.originalBytes) : null,
    originalPdfSize: input.originalBytes?.byteLength ?? 0,
    pages: input.pages.map((page, index) => normalizePage(page, index)),
    objects: input.objects,
    settings: input.settings as Partial<AppSettings>,
  };
}

/** Проект → JSON-строка (UTF-8, читаемая). */
export function projectToJson(project: ProjectFile): string {
  return buildJson(project);
}

/** Проект → Blob для скачивания. */
export function projectToBlob(project: ProjectFile): Blob {
  return new Blob([projectToJson(project)], { type: 'application/json;charset=utf-8' });
}

/** Разбор JSON проекта с миграцией схемы. */
export function parseProjectJson(text: string): ProjectFile {
  const raw = parseJson<Partial<ProjectFile> & { schemaVersion?: number }>(text);
  if (!raw || typeof raw !== 'object') throw new Error('Файл проекта повреждён');
  if (!Array.isArray(raw.objects)) {
    throw new Error('В файле проекта отсутствует список объектов');
  }

  const version = Number(raw.schemaVersion ?? 1);
  const objects = raw.objects
    .map((item) => normalizeImportedObject(item))
    .filter((item): item is EditorObject => item !== null);
  const pages = (raw.pages ?? []).map((page, index) => normalizePage(page, index));

  const metadata: PdfMetadata = {
    title: raw.metadata?.title ?? '',
    author: raw.metadata?.author ?? '',
    subject: raw.metadata?.subject ?? '',
    keywords: raw.metadata?.keywords ?? '',
    creator: raw.metadata?.creator ?? APP_NAME,
    producer: raw.metadata?.producer ?? `${APP_NAME} (pdf-lib)`,
  };

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    app: raw.app ?? APP_NAME,
    appVersion: raw.appVersion ?? APP_VERSION,
    savedAt: raw.savedAt ?? new Date().toISOString(),
    fileName: raw.fileName ?? 'document.pdf',
    metadata,
    originalPdfBase64: raw.originalPdfBase64 ?? null,
    originalPdfSize: raw.originalPdfSize ?? 0,
    // До версии 3 страницы хранили только размеры без учёта поворота.
    pages: pages.length > 0 ? pages : version < 3 ? [] : [],
    objects,
    settings: raw.settings ?? {},
  };
}

/** Чтение файла проекта. */
export async function readProjectFile(file: File): Promise<ProjectFile> {
  const text = await file.text();
  return parseProjectJson(text);
}

/** Извлечение оригинального PDF из проекта. */
export function decodeOriginalPdf(project: ProjectFile): Uint8Array | null {
  if (!project.originalPdfBase64) return null;
  try {
    return base64ToBytes(project.originalPdfBase64);
  } catch {
    return null;
  }
}

/** Оценка размера проекта (для предупреждения о больших файлах). */
export function estimateProjectSize(project: ProjectFile): number {
  const json = projectToJson(project);
  return new Blob([json]).size;
}

/** Имя файла проекта. */
export function projectFileName(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, '');
  return `${base}-project.json`;
}

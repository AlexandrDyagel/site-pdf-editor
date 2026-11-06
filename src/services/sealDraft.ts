/**
 * Черновик конструктора круглой печати.
 *
 * Зачем: окно можно случайно закрыть (Esc, клик по подложке, перезагрузка
 * маршрута). Незавершённая настройка оттиска не должна пропадать — при
 * повторном открытии конструктор возвращает ровно то состояние, которое было.
 *
 * Хранится в памяти модуля (на время сессии). Время жизни сознательно
 * ограничено: черновик сбрасывается после «Добавить на документ» или по
 * кнопке «Сбросить».
 */

import type { StampTemplate } from '@/types';

export interface SealDraft {
  /** Контекст: какой объект/шаблон редактировали. */
  key: string;
  template: StampTemplate;
  zoom: number;
  tab: string;
  /** Выбранный фон превью (не часть печати). */
  background: string | null;
  /** Какая строка текста была выбрана. */
  selectedLineId: string | null;
}

let draft: SealDraft | null = null;

/** Ключ контекста: объект, шаблон из библиотеки или новая печать. */
export function sealDraftKey(objectId: string | null, templateId: string | null): string {
  if (objectId) return `object:${objectId}`;
  if (templateId) return `template:${templateId}`;
  return 'new';
}

/** Сохранить снимок состояния (данные копируются, реактивность не тянем). */
export function saveSealDraft(value: SealDraft): void {
  draft = {
    key: value.key,
    template: JSON.parse(JSON.stringify(value.template)) as StampTemplate,
    zoom: value.zoom,
    tab: value.tab,
    background: value.background,
    selectedLineId: value.selectedLineId ?? null,
  };
}

/** Прочитать черновик для контекста (или null). */
export function readSealDraft(key: string): SealDraft | null {
  if (!draft || draft.key !== key) return null;
  return {
    key: draft.key,
    template: JSON.parse(JSON.stringify(draft.template)) as StampTemplate,
    zoom: draft.zoom,
    tab: draft.tab,
    background: draft.background,
    selectedLineId: draft.selectedLineId ?? null,
  };
}

/** Сбросить черновик. */
export function clearSealDraft(): void {
  draft = null;
}

/**
 * Выбранный фон превью запоминается отдельно от черновика.
 *
 * Фон — не часть печати, но при повторном редактировании той же печати он
 * должен остаться тем же. Храним его по контексту (объект/шаблон/новая печать),
 * поэтому он переживает и вставку на документ, и закрытие окна.
 */
const backgrounds = new Map<string, string | null>();

/** Запомнить фон превью для контекста. */
export function saveSealBackground(key: string, background: string | null): void {
  backgrounds.set(key, background);
}

/** Восстановить фон превью для контекста. */
export function readSealBackground(key: string): string | null | undefined {
  return backgrounds.has(key) ? backgrounds.get(key) : undefined;
}

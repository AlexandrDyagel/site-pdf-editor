/**
 * Состояние интерфейса: модальные окна, уведомления, прогресс, панели,
 * диалог подтверждения опасных действий.
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { ProgressState, ToastMessage } from '@/types';
import { createId } from '@/utils/id';

/** Доступные модальные окна. */
export type ModalName =
  | 'stampEditor'
  | 'signatureEditor'
  | 'drawingEditor'
  | 'export'
  | 'fonts'
  | 'imageLibrary'
  | 'projects'
  | 'shortcuts'
  | 'documentInfo'
  | 'about';

/** Вкладки левой панели. */
export type LeftTab = 'pages' | 'library' | 'text';
/** Вкладки правой панели. */
export type RightTab = 'tool' | 'properties' | 'layers' | 'history' | 'page';

/** Состояние контекстного меню объектов. */
export interface ContextMenuState {
  /** Координаты курсора в окне. */
  x: number;
  y: number;
  /** Объекты, к которым применяются действия меню. */
  ids: string[];
  /** Группа, по которой кликнули (если клик был по группе или её объекту). */
  groupId: string | null;
  /** Заголовок меню (например, название группы). */
  title?: string;
}

/** Диалог подтверждения. */
export interface ConfirmState {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
}

export const useUiStore = defineStore('ui', () => {
  const modals = ref<Record<ModalName, boolean>>({
    stampEditor: false,
    signatureEditor: false,
    drawingEditor: false,
    export: false,
    fonts: false,
    imageLibrary: false,
    projects: false,
    shortcuts: false,
    documentInfo: false,
    about: false,
  });

  /** Данные, передаваемые в модальное окно. */
  const modalPayload = ref<Record<string, unknown>>({});

  const toasts = ref<ToastMessage[]>([]);
  const progress = ref<ProgressState>({ active: false, value: 0, label: '' });
  const busy = ref(false);

  const leftTab = ref<LeftTab>('pages');
  const rightTab = ref<RightTab>('properties');
  const leftPanelOpen = ref(true);
  const rightPanelOpen = ref(true);
  const mobilePanelsVisible = ref(false);

  const confirmState = ref<ConfirmState>({
    open: false,
    title: '',
    text: '',
    confirmLabel: 'Подтвердить',
    cancelLabel: 'Отмена',
    danger: false,
  });

  /**
   * Контекстное меню объектов (правая кнопка мыши).
   * Открывается и из панели «Слои», и с холста — меню одно, поэтому действия
   * ведут себя одинаково.
   */
  const contextMenu = ref<ContextMenuState | null>(null);

  function openContextMenu(state: ContextMenuState): void {
    contextMenu.value = state;
    // Меню перекрывает панели — закрываем открытые модальные окна выбора.
    confirmResolver = confirmResolver ?? null;
  }

  function closeContextMenu(): void {
    contextMenu.value = null;
  }

  let confirmResolver: ((value: boolean) => void) | null = null;

  const anyModalOpen = computed(() => Object.values(modals.value).some(Boolean));

  /* ======================== Модальные окна ======================== */

  function openModal(name: ModalName, payload: Record<string, unknown> = {}): void {
    modalPayload.value = { ...payload };
    modals.value[name] = true;
  }

  function closeModal(name: ModalName): void {
    modals.value[name] = false;
    modalPayload.value = {};
  }

  function closeAllModals(): void {
    for (const key of Object.keys(modals.value) as ModalName[]) modals.value[key] = false;
    modalPayload.value = {};
    contextMenu.value = null;
  }

  function isModalOpen(name: ModalName): boolean {
    return modals.value[name];
  }

  /* ======================== Уведомления ======================== */

  function toast(
    type: ToastMessage['type'],
    title: string,
    text?: string,
    timeout = type === 'error' ? 9000 : 4500,
  ): string {
    const id = createId('toast');
    toasts.value = [...toasts.value, { id, type, title, text, timeout }];
    if (timeout > 0) {
      window.setTimeout(() => dismissToast(id), timeout);
    }
    return id;
  }

  function dismissToast(id: string): void {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }

  function clearToasts(): void {
    toasts.value = [];
  }

  const notify = {
    info: (title: string, text?: string): string => toast('info', title, text),
    success: (title: string, text?: string): string => toast('success', title, text),
    warning: (title: string, text?: string): string => toast('warning', title, text, 7000),
    error: (title: string, text?: string): string => toast('error', title, text, 9000),
  };

  /* ======================== Прогресс ======================== */

  function setProgress(value: number, label: string, detail?: string): void {
    progress.value = {
      active: value < 1,
      value: Math.max(0, Math.min(1, value)),
      label,
      detail,
    };
    busy.value = true;
  }

  function clearProgress(): void {
    progress.value = { active: false, value: 0, label: '' };
    busy.value = false;
  }

  /* ======================== Подтверждение ======================== */

  function askConfirm(options: {
    title: string;
    text?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }): Promise<boolean> {
    if (confirmResolver) {
      confirmResolver(false);
      confirmResolver = null;
    }
    confirmState.value = {
      open: true,
      title: options.title,
      text: options.text ?? '',
      confirmLabel: options.confirmLabel ?? 'Подтвердить',
      cancelLabel: options.cancelLabel ?? 'Отмена',
      danger: options.danger ?? false,
    };
    return new Promise<boolean>((resolve) => {
      confirmResolver = resolve;
    });
  }

  function resolveConfirm(value: boolean): void {
    confirmState.value = { ...confirmState.value, open: false };
    const resolver = confirmResolver;
    confirmResolver = null;
    resolver?.(value);
  }

  /* ======================== Панели ======================== */

  function setLeftTab(tab: LeftTab): void {
    leftTab.value = tab;
    leftPanelOpen.value = true;
  }

  function setRightTab(tab: RightTab): void {
    rightTab.value = tab;
    rightPanelOpen.value = true;
  }

  function toggleLeftPanel(): void {
    leftPanelOpen.value = !leftPanelOpen.value;
  }

  function toggleRightPanel(): void {
    rightPanelOpen.value = !rightPanelOpen.value;
  }

  function togglePanels(): void {
    const visible = leftPanelOpen.value || rightPanelOpen.value;
    leftPanelOpen.value = !visible;
    rightPanelOpen.value = !visible;
  }

  return {
    modals,
    modalPayload,
    toasts,
    progress,
    busy,
    leftTab,
    rightTab,
    leftPanelOpen,
    rightPanelOpen,
    mobilePanelsVisible,
    confirmState,
    contextMenu,
    openContextMenu,
    closeContextMenu,
    anyModalOpen,
    openModal,
    closeModal,
    closeAllModals,
    isModalOpen,
    toast,
    dismissToast,
    clearToasts,
    notify,
    setProgress,
    clearProgress,
    askConfirm,
    resolveConfirm,
    setLeftTab,
    setRightTab,
    toggleLeftPanel,
    toggleRightPanel,
    togglePanels,
  };
});

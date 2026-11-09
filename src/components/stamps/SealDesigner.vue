<script setup lang="ts">
/**
 * Конструктор круглой печати (оттиска).
 *
 * Слева — большое живое превью с зумом, маркерами и перетаскиванием строк,
 * справа — настройки. Печать рисуется тем же кодом, что и объект на странице
 * и экспорт в PDF (`computeStampLayout` + `paintStampLayout`), поэтому
 * «что вижу — то и вставлю».
 *
 * Текст по кольцам — это список независимых строк: у каждой свой шрифт,
 * начертание, кегль, трекинг и межсловный интервал (в pt), свой кольцевой
 * зазор и половина кольца. Строки центрируются по зазору, тянутся мышью и
 * имеют контекстное меню.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SealMultiSelection, SealRingLine, StampLogo, StampTemplate, StampTextLine } from '@/types';
import { SEAL_COLORS } from '@/constants';
import { createId } from '@/utils/id';
import {
  SEAL_MAX_MM,
  SEAL_MAX_RINGS,
  SEAL_MIN_MM,
  createSealRing,
  createSealRingLine,
  createSealSettings,
  normalizeSealSettings,
  sealDiameterMm,
  sealDiameterPx,
  sealSettingsFromTemplate,
} from '@/services/sealRenderService';
import { createSealTemplate, createStampLine, computeStampLayout } from '@/services/stampRenderService';
import { createStampObject } from '@/services/objectFactory';
import {
  clearSealDraft,
  readSealBackground,
  readSealDraft,
  saveSealBackground,
  saveSealDraft,
  sealDraftKey,
  type SealReference,
} from '@/services/sealDraft';
import { useUiStore } from '@/stores/ui';
import { useLibraryStore } from '@/stores/library';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useFontsStore } from '@/stores/fonts';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSlider from '@/components/ui/AppSlider.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppColorPicker from '@/components/ui/AppColorPicker.vue';
import AppSection from '@/components/ui/AppSection.vue';
import AppToggle from '@/components/ui/AppToggle.vue';
import AppTabs from '@/components/ui/AppTabs.vue';
import SealPreview from '@/components/stamps/SealPreview.vue';
import SealLineControls from '@/components/stamps/SealLineControls.vue';

const ui = useUiStore();
const library = useLibraryStore();
const objects = useObjectsStore();
const editor = useEditorStore();
const fonts = useFontsStore();

const template = ref<StampTemplate>(createSealTemplate());
const targetObjectId = ref<string | null>(null);
const tab = ref('rings');
const zoom = ref(3);
const isSaving = ref(false);
/** Выбранная строка текста по кольцу (для маркеров и правки). */
const selectedLineId = ref<string | null>(null);
/** Выбранная строка в центре (клик по ней показывает свойства справа). */
const selectedCenterIndex = ref<number | null>(null);
/** Выбранное кольцо (клик по кольцу показывает его настройки справа). */
const selectedRingIndex = ref<number | null>(null);
/** Выбран логотип: показываем рамку, углы и маркер поворота. */
const selectedLogo = ref(false);
/** Индекс выбранного логотипа (их может быть несколько). */
const selectedLogoIndex = ref<number | null>(null);
/** Список логотипов: массив или совместимость со старым `logo`. */
const stampLogos = computed<StampLogo[]>(() =>
  template.value.logos?.length
    ? template.value.logos
    : template.value.logo
      ? [template.value.logo]
      : [],
);
/** Выбран образец печати (картинка под превью). */
const selectedReference = ref(false);
/** Картинка-образец под превью — не часть печати, только подсказка. */
const reference = ref<SealReference | null>(null);
/** Ссылка на превью — нужна, чтобы сбрасывать панораму. */
const previewRef = ref<{ resetPan: () => void } | null>(null);
/** Выделение нескольких объектов на превью (рамка или Shift+клик). */
const multiSelection = ref<SealMultiSelection | null>(null);
const multiSelectionCount = computed(() => {
  const selection = multiSelection.value;
  if (!selection) return 0;
  return selection.lines.length + selection.centers.length + selection.rings.length + selection.logos.length;
});

/** Сколько строк максимум может стоять в одном кольцевом зазоре. */
const MAX_LINES_PER_SLOT = 2;

/* ======================== Локальная история (Ctrl+Z) ======================== */

let undoStack: string[] = [];
let redoStack: string[] = [];
let historyApplying = false;
let historyTimer: number | null = null;

/** Фон подложки превью. В документ он не попадает — это только просмотр. */
const previewBackgrounds = [
  { id: 'none', label: 'Без фона', color: null },
  { id: 'white', label: 'Белый', color: '#ffffff' },
  { id: 'paper', label: 'Бумага', color: '#f3eddf' },
  { id: 'gray', label: 'Серый', color: '#dbe1ea' },
  { id: 'dark', label: 'Тёмный', color: '#1f2937' },
] as const;
const previewBg = ref<string | null>(null);

/** Пипетка свернула окно: показываем холст, но не закрываем конструктор. */
const picking = ref(false);
/** Конструктор восстановил незавершённое редактирование. */
const restoredDraft = ref(false);
const draftKey = ref('new');
/** Флаг «закрываем намеренно»: после вставки черновик сохранять не нужно. */
let suppressDraftSave = false;

const rightColumn = ref<HTMLElement | null>(null);

const isOpen = computed({
  get: () => ui.modals.sealDesigner,
  set: (value: boolean) => {
    if (value) ui.openModal('sealDesigner');
    else ui.closeModal('sealDesigner');
  },
});

const tabs = [
  { id: 'rings', label: 'Кольца', icon: 'circle' },
  { id: 'text', label: 'Текст', icon: 'type' },
  { id: 'center', label: 'Центр', icon: 'seal' },
  { id: 'logo', label: 'Логотип', icon: 'image' },
  { id: 'sample', label: 'Образец', icon: 'layers' },
  { id: 'ink', label: 'Краска', icon: 'sliders' },
];

const fontOptions = computed(() =>
  fonts.fonts.map((font) => ({
    value: font.id,
    label: font.name,
    group: font.source === 'user' ? 'Пользовательские' : 'Встроенные',
  })),
);

/** Настройки печати (они всегда есть у открытого конструктора). */
const seal = computed(() => template.value.seal ?? createSealSettings());
const diameterPx = computed(() => sealDiameterPx(seal.value.diameterMm));
const maxArcRadius = computed(() => Math.round(diameterPx.value / 2));

/** Варианты зазоров для строк: между кольцами и под последним кольцом. */
const slotOptions = computed(() => {
  const count = seal.value.rings.length;
  return Array.from({ length: count }, (_, index) => ({
    value: index,
    label: index < count - 1 ? `Между кольцами ${index + 1}–${index + 2}` : `Под кольцом ${count}`,
  }));
});

/** Фактические углы строк — для подсказок «фактически N°». */
const lineSpans = computed(() => {
  const layout = computeStampLayout(template.value, (fontId) => fonts.familyOf(fontId));
  const result: Record<string, number> = {};
  for (const item of layout.seal?.ringLines ?? []) {
    result[item.lineId] = Math.abs(item.endAngle - item.startAngle);
  }
  return result;
});

/** Зазоры, в которых больше одной строки: там легко «не поместиться». */
const multiLineSlots = computed(() => {
  const counts = new Map<number, number>();
  for (const line of seal.value.lines) {
    if (!line.text.trim()) continue;
    counts.set(line.slot, (counts.get(line.slot) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([slot]) => slot);
});

/* ======================== Открытие/инициализация ======================== */

/**
 * Приводит шаблон к виду печати: гарантирует настройки, форму и размер.
 * Диаметр берём из фактического размера шаблона — печать, которую уже
 * растянули на странице, открывается с честными миллиметрами.
 */
function withSealSettings(source: StampTemplate): StampTemplate {
  const plain = JSON.parse(JSON.stringify(source)) as StampTemplate;
  const size = Math.max(8, Math.min(plain.width, plain.height));
  const settings = normalizeSealSettings(plain.seal ?? sealSettingsFromTemplate(plain));
  settings.diameterMm =
    Math.round(Math.min(SEAL_MAX_MM, Math.max(SEAL_MIN_MM, sealDiameterMm(size))) * 10) / 10;
  const px = sealDiameterPx(settings.diameterMm);
  return { ...plain, kind: 'seal', shape: 'round', seal: settings, width: px, height: px };
}

watch(
  () => ui.modals.sealDesigner,
  async (open) => {
    if (!open) {
      // Окно закрыли (в том числе случайно) — сохраняем черновик.
      if (!suppressDraftSave) persistDraft();
      suppressDraftSave = false;
      picking.value = false;
      return;
    }
    const payload = ui.modalPayload;
    const objectId = typeof payload.objectId === 'string' ? payload.objectId : null;
    const templateId = typeof payload.templateId === 'string' ? payload.templateId : null;
    targetObjectId.value = objectId;
    draftKey.value = sealDraftKey(objectId, templateId);

    // 1. Черновик того же контекста — восстанавливаем как было.
    const draft = readSealDraft(draftKey.value);
    const rememberedBackground = readSealBackground(draftKey.value);
    if (draft) {
      template.value = withSealSettings(draft.template);
      zoom.value = Math.min(12, Math.max(0.5, draft.zoom || fitZoomValue()));
      tab.value = draft.tab || 'rings';
      // Фон запоминается отдельно: он переживает и вставку, и закрытие окна.
      previewBg.value = rememberedBackground ?? draft.background;
      selectedLineId.value = draft.selectedLineId;
      selectedCenterIndex.value = null;
      selectedRingIndex.value = null;
      selectedLogo.value = false;
      selectedLogoIndex.value = null;
      selectedReference.value = false;
      reference.value = draft.reference ?? null;
      restoredDraft.value = true;
      resetHistory();
      await nextTick();
      return;
    }

    // 2. Иначе — объект, шаблон из библиотеки или новая печать.
    let source: StampTemplate | null = null;
    if (objectId) {
      const object = objects.byId(objectId);
      if (object?.type === 'stamp') source = object.payload.template;
    }
    if (!source && templateId) source = library.stampById(templateId) ?? null;

    template.value = withSealSettings(source ?? createSealTemplate());
    tab.value = 'rings';
    zoom.value = fitZoomValue();
    // Фон, выбранный для этой печати раньше, тоже помним.
    previewBg.value = rememberedBackground ?? null;
    selectedLineId.value = null;
    selectedCenterIndex.value = null;
    selectedRingIndex.value = null;
    selectedLogo.value = false;
    selectedLogoIndex.value = null;
    selectedReference.value = false;
    reference.value = null;
    restoredDraft.value = false;
    resetHistory();
    await nextTick();
  },
);

/** Черновик: сохраняем при закрытии окна, чтобы ничего не потерялось. */
function persistDraft(): void {
  if (!template.value?.seal) return;
  saveSealDraft({
    key: draftKey.value,
    template: template.value,
    zoom: zoom.value,
    tab: tab.value,
    background: previewBg.value,
    selectedLineId: selectedLineId.value,
    reference: reference.value,
  });
}

// Фон превью запоминаем сразу: даже если окно закроют «накрест» или после
// вставки черновик очистится, при следующем редактировании он вернётся.
watch(previewBg, (value) => saveSealBackground(draftKey.value, value));

/** Начать печать заново и забыть черновик. */
function resetDraft(): void {
  clearSealDraft();
  restoredDraft.value = false;
  template.value = withSealSettings(createSealTemplate());
  tab.value = 'rings';
  previewBg.value = null;
  selectedLineId.value = null;
  selectedCenterIndex.value = null;
  selectedRingIndex.value = null;
  selectedLogo.value = false;
  selectedLogoIndex.value = null;
  selectedReference.value = false;
  reference.value = null;
  zoom.value = fitZoomValue();
  resetHistory();
}

/** Зум, при котором печать занимает ~380 px превью. */
function fitZoomValue(): number {
  const size = Math.max(24, Math.min(template.value.width, template.value.height));
  return Math.min(4, Math.max(1, Math.round((380 / size) * 4) / 4));
}

function fitZoom(): void {
  zoom.value = fitZoomValue();
  previewRef.value?.resetPan();
}

function setZoom(value: number): void {
  zoom.value = Math.min(12, Math.max(0.5, Math.round(value * 100) / 100));
}

/** Ctrl+колесо на превью: плавный зум с сохранением панорамы. */
function zoomByFactor(factor: number): void {
  setZoom(zoom.value * factor);
}

/** Отладочный хук для автотестов (только dev-сборка). */
watch(
  () => template.value,
  (value) => {
    if (import.meta.env.DEV) {
      (window as unknown as { __SEAL_DESIGNER__?: StampTemplate }).__SEAL_DESIGNER__ = value;
    }
  },
  { deep: true, immediate: true },
);

/* ======================== Локальная история и клавиатура ======================== */

/** Текущее состояние — точка отсчёта для Ctrl+Z. */
function resetHistory(): void {
  if (historyTimer !== null) {
    window.clearTimeout(historyTimer);
    historyTimer = null;
  }
  undoStack = [JSON.stringify(template.value)];
  redoStack = [];
  historyApplying = false;
}

function pushHistory(): void {
  const snapshot = JSON.stringify(template.value);
  if (undoStack[undoStack.length - 1] === snapshot) return;
  undoStack.push(snapshot);
  if (undoStack.length > 80) undoStack.shift();
  redoStack = [];
}

function applyHistory(): void {
  const snapshot = undoStack[undoStack.length - 1];
  if (!snapshot) return;
  historyApplying = true;
  template.value = JSON.parse(snapshot) as StampTemplate;
  // Выбор мог указывать на удалённую строку/кольцо.
  if (
    selectedLineId.value &&
    !template.value.seal?.lines.some((line) => line.id === selectedLineId.value)
  ) {
    selectedLineId.value = null;
  }
  if (
    selectedCenterIndex.value !== null &&
    selectedCenterIndex.value >= template.value.lines.length
  ) {
    selectedCenterIndex.value = null;
  }
  if (
    selectedRingIndex.value !== null &&
    selectedRingIndex.value >= (template.value.seal?.rings.length ?? 0)
  ) {
    selectedRingIndex.value = null;
  }
  void nextTick(() => {
    historyApplying = false;
  });
}

function undo(): void {
  pushHistory();
  if (undoStack.length < 2) return;
  const current = undoStack.pop();
  if (current) redoStack.push(current);
  applyHistory();
}

function redo(): void {
  const snapshot = redoStack.pop();
  if (!snapshot) return;
  undoStack.push(snapshot);
  applyHistory();
}

// Каждое изменение шаблона попадает в историю (с небольшой задержкой, чтобы
// перетаскивание ползунка не создавало сотню шагов).
watch(
  () => template.value,
  () => {
    if (historyApplying) return;
    if (historyTimer !== null) window.clearTimeout(historyTimer);
    historyTimer = window.setTimeout(() => {
      historyTimer = null;
      pushHistory();
    }, 250);
  },
  { deep: true },
);

/** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y и Delete внутри конструктора. */
function onDesignerKeydown(event: KeyboardEvent): void {
  if (!ui.modals.sealDesigner) return;
  const target = event.target as HTMLElement | null;
  const typing = Boolean(
    target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable),
  );
  const mod = event.ctrlKey || event.metaKey;
  // event.code не зависит от раскладки: Ctrl+Z работает и на русской.
  const code = event.code;

  if (mod && !event.altKey && code === 'KeyZ') {
    // В поле ввода Ctrl+Z — родная отмена набора, её не перехватываем.
    if (typing) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && !event.altKey && code === 'KeyY') {
    if (typing) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    redo();
    return;
  }
    if (!mod && !event.altKey && (event.key === 'Delete' || event.key === 'Backspace')) {
    if (typing) return;
    if (multiSelectionCount.value > 1) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      deleteMultiSelection();
      return;
    }
    if (selectedLineId.value) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      deleteLine(selectedLineId.value);
      return;
    }
    if (selectedCenterIndex.value !== null) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      removeCenterLine(selectedCenterIndex.value);
      return;
    }
    if (selectedLogo.value) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      removeLogo(selectedLogoIndex.value ?? 0);
      return;
    }
    if (selectedReference.value) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      removeReference();
      return;
    }
    if (selectedRingIndex.value !== null) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      removeRing(selectedRingIndex.value);
    }
  }
}

/**
 * Клик вне печати снимает фокус со всего (строки, кольца, логотип, образец).
 * Клики по панели настроек и по самому превью не трогаем: превью само решает,
 * что выбрать, а в настройках можно продолжать править выбранный объект.
 */
function onGlobalPointerDown(event: PointerEvent): void {
  if (!ui.modals.sealDesigner) return;
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (target.closest('.seal-settings')) return;
  if (target.closest('[data-testid=seal-preview-canvas]')) return;
  if (target.closest('[data-testid=seal-text-menu]')) return;
  if (
    target.closest('[data-testid^=seal-handle-]') ||
    target.closest('[data-testid^=seal-center-handle-]') ||
    target.closest('[data-testid^=seal-logo-handle-]') ||
    target.closest('[data-testid=seal-logo-rotate]') ||
    target.closest('[data-testid^=seal-ref-handle-]') ||
    target.closest('[data-testid=seal-ref-rotate]')
  ) {
    return;
  }
  // Клик по подложке превью или по шапке/фону/футеру — снять фокус.
  clearSelection();
}

onMounted(() => {
  window.addEventListener('keydown', onDesignerKeydown, true);
  window.addEventListener('pointerdown', onGlobalPointerDown, true);
  if (import.meta.env.DEV) {
    // Отладочный хук для браузерных проверок.
    (
      window as unknown as {
        __SEAL_DESIGNER_KEYBOARD__?: {
          undo: () => void;
          redo: () => void;
          stackSize: () => number;
          handle: (event: KeyboardEvent) => void;
        };
      }
    ).__SEAL_DESIGNER_KEYBOARD__ = {
      undo: () => undo(),
      redo: () => redo(),
      stackSize: () => undoStack.length,
      handle: (event) => onDesignerKeydown(event),
    };
    // Отладочный доступ к образцу (для браузерных проверок).
    (
      window as unknown as {
        __SEAL_REFERENCE__?: {
          set: (value: SealReference | null) => void;
          get: () => SealReference | null;
        };
      }
    ).__SEAL_REFERENCE__ = {
      set: (value) => {
        reference.value = value;
      },
      get: () => reference.value,
    };
    // Состояние выделения — для браузерных проверок.
    (
      window as unknown as {
        __SEAL_DESIGNER_STATE__?: {
          get: () => {
            selectedLineId: string | null;
            selectedCenterIndex: number | null;
            selectedRingIndex: number | null;
            selectedLogoIndex: number | null;
            multi: SealMultiSelection | null;
          };
        };
      }
    ).__SEAL_DESIGNER_STATE__ = {
      get: () => ({
        selectedLineId: selectedLineId.value,
        selectedCenterIndex: selectedCenterIndex.value,
        selectedRingIndex: selectedRingIndex.value,
        selectedLogoIndex: selectedLogoIndex.value,
        multi: multiSelection.value,
      }),
    };
  }
});

/* ======================== Кольца ======================== */

function setDiameter(value: number): void {
  const settings = template.value.seal;
  if (!settings) return;
  const clamped = Math.min(SEAL_MAX_MM, Math.max(SEAL_MIN_MM, Math.round(value * 10) / 10));
  settings.diameterMm = clamped;
  const px = sealDiameterPx(clamped);
  template.value.width = px;
  template.value.height = px;
  if (zoom.value * px > 400) zoom.value = fitZoomValue();
}

/**
 * Снимок радиусов строк: нужен, чтобы структурные изменения колец
 * (добавление/удаление) не сдвигали уже нарисованный текст.
 */
function captureLineRadii(): Map<string, number> {
  const layout = computeStampLayout(template.value, (id) => fonts.familyOf(id));
  return new Map((layout.seal?.ringLines ?? []).map((line) => [line.lineId, line.radius]));
}

/** Возвращает строки на прежние радиусы, меняя только их собственные смещения. */
function restoreLineRadii(before: Map<string, number>): void {
  const settings = template.value.seal;
  if (!settings) return;
  const layout = computeStampLayout(template.value, (id) => fonts.familyOf(id));
  for (const geometry of layout.seal?.ringLines ?? []) {
    const target = before.get(geometry.lineId);
    if (target == null) continue;
    const line = settings.lines.find((item) => item.id === geometry.lineId);
    if (!line) continue;
    const base = geometry.radius - line.radiusOffset;
    line.radiusOffset = Math.round((target - base) * 10) / 10;
  }
}

/**
 * Добавить кольцо кнопкой.
 *
 * Новое кольцо всегда встаёт внутрь — под уже нарисованным текстом. Позиции
 * строк фиксируются до и восстанавливаются после, поэтому текст не «уезжает».
 */
function addRing(): void {
  const settings = template.value.seal;
  if (!settings || settings.rings.length >= SEAL_MAX_RINGS) return;
  const before = captureLineRadii();
  settings.rings.push(createSealRing(1, 4));
  restoreLineRadii(before);
  ui.notify.info('Кольцо добавлено', 'Оно встало внутрь — под текст, который уже есть на печати');
}

/** Удалить кольцо (минимум одно остаётся); текст остаётся на своих местах. */
function removeRing(index: number): void {
  const settings = template.value.seal;
  if (!settings || settings.rings.length <= 1) return;
  const before = captureLineRadii();
  settings.rings.splice(index, 1);
  settings.rings[0].gap = 0;
  for (const line of settings.lines) {
    line.slot = Math.min(line.slot, settings.rings.length - 1);
  }
  restoreLineRadii(before);
  if (selectedRingIndex.value !== null) {
    if (selectedRingIndex.value === index) selectedRingIndex.value = null;
    else if (selectedRingIndex.value > index) selectedRingIndex.value -= 1;
  }
}

/**
 * Кольцо потянули на превью: меняем расстояние до предыдущего кольца.
 * Текст при этом остаётся на своих местах.
 */
function onRingResize(ringIndex: number, radius: number): void {
  const settings = template.value.seal;
  if (!settings || ringIndex <= 0) return;
  const layout = computeStampLayout(template.value, (id) => fonts.familyOf(id));
  const rings = layout.seal?.ink.rings;
  const prev = rings?.[ringIndex - 1];
  const current = rings?.[ringIndex];
  if (!prev || !current) return;
  const before = captureLineRadii();
  const gap = prev.radius - prev.width / 2 - radius - current.width / 2;
  settings.rings[ringIndex].gap = Math.min(100, Math.max(0.5, Math.round(gap * 10) / 10));
  restoreLineRadii(before);
}

/** Удаление кольца из контекстного меню. */
function onRingDelete(ringIndex: number): void {
  removeRing(ringIndex);
}

/** Сколько строк уже стоит в зазоре (можно исключить одну — при переносе). */
function lineCountInSlot(slot: number, excludeId?: string): number {
  return seal.value.lines.filter((line) => line.slot === slot && line.id !== excludeId).length;
}

/* ======================== Строки по кольцам ======================== */

function lineIndex(lineId: string): number {
  return seal.value.lines.findIndex((line) => line.id === lineId);
}

/** Выбрать строку (и при желании показать её настройки справа). */
function selectLine(lineId: string | null, options: { reveal?: boolean } = {}): void {
  multiSelection.value = null;
  selectedLineId.value = lineId;
  selectedRingIndex.value = null;
  selectedLogo.value = false;
  selectedLogoIndex.value = null;
  selectedCenterIndex.value = null;
  selectedReference.value = false;
  if (!lineId || options.reveal === false) return;
  tab.value = 'text';
  void nextTick(() => {
    const index = lineIndex(lineId);
    if (index < 0) return;
    rightColumn.value
      ?.querySelector(`[data-testid="seal-line-${index}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

/** Выбрать кольцо: открыть «Кольца» и показать его карточку. */
function selectRing(index: number, options: { reveal?: boolean } = {}): void {
  multiSelection.value = null;
  selectedRingIndex.value = index;
  selectedLineId.value = null;
  selectedCenterIndex.value = null;
  selectedLogo.value = false;
  selectedLogoIndex.value = null;
  selectedReference.value = false;
  tab.value = 'rings';
  if (options.reveal === false) return;
  void nextTick(() => {
    rightColumn.value
      ?.querySelector(`[data-testid="seal-ring-${index}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

/** Выбрать строку центра: открыть «Центр» и показать её карточку. */
function selectCenterLine(index: number, options: { reveal?: boolean } = {}): void {
  multiSelection.value = null;
  selectedCenterIndex.value = index;
  selectedLineId.value = null;
  selectedRingIndex.value = null;
  selectedLogo.value = false;
  selectedLogoIndex.value = null;
  selectedReference.value = false;
  tab.value = 'center';
  if (options.reveal === false) return;
  void nextTick(() => {
    rightColumn.value
      ?.querySelector(`[data-testid="seal-center-card-${index}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

/** Снять фокус со всего: строки, кольца, логотип, образец. */
function clearSelection(): void {
  multiSelection.value = null;
  selectedLineId.value = null;
  selectedCenterIndex.value = null;
  selectedRingIndex.value = null;
  selectedLogo.value = false;
  selectedLogoIndex.value = null;
  selectedReference.value = false;
}

/** Клик по логотипу: выделяем его, чтобы показать углы и поворот. */
function selectLogo(index = 0): void {
  multiSelection.value = null;
  selectedLogo.value = true;
  selectedLogoIndex.value = index;
  selectedLineId.value = null;
  selectedCenterIndex.value = null;
  selectedRingIndex.value = null;
  selectedReference.value = false;
  tab.value = 'logo';
  void nextTick(() => {
    rightColumn.value
      ?.querySelector(`[data-testid=seal-logo-card-${index}]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

/** Выделение группы: снимаем одиночный фокус, чтобы не путать маркеры. */
function onSelectionChange(selection: SealMultiSelection | null): void {
  multiSelection.value = selection;
  if (!selection) return;
  selectedLineId.value = null;
  selectedCenterIndex.value = null;
  selectedRingIndex.value = null;
  selectedLogo.value = false;
  selectedLogoIndex.value = null;
  selectedReference.value = false;
}

/** Сдвиг группы: каждая строка пересчитывает свои смещения. */
function onGroupMove(dx: number, dy: number): void {
  const selection = multiSelection.value;
  if (!selection) return;
  const settings = template.value.seal;
  if (settings) {
    if (selection.lines.length > 0) {
      const layout = computeStampLayout(template.value, (id) => fonts.familyOf(id));
      const rad = Math.PI / 180;
      for (const lineId of selection.lines) {
        const geometry = layout.seal?.ringLines.find((item) => item.lineId === lineId);
        const line = settings.lines.find((item) => item.id === lineId);
        if (!geometry || !line) continue;
        const centerX = sizeCenter();
        const centerY = sizeCenter();
        const angle = geometry.centerAngle * rad;
        const point = {
          x: centerX + Math.cos(angle) * geometry.radius + dx,
          y: centerY + Math.sin(angle) * geometry.radius + dy,
        };
        const newRadius = Math.hypot(point.x - centerX, point.y - centerY);
        const newAngle = (Math.atan2(point.y - centerY, point.x - centerX) * 180) / Math.PI;
        let deltaAngle = newAngle - geometry.centerAngle;
        deltaAngle = ((deltaAngle % 360) + 540) % 360 - 180;
        line.radiusOffset = Math.round((line.radiusOffset + newRadius - geometry.radius) * 10) / 10;
        line.angleOffset = Math.round((((line.angleOffset + deltaAngle + 180) % 360) + 360) % 360 - 180);
      }
    }
    for (const layoutIndex of selection.centers) {
      const index = templateCenterIndex(layoutIndex);
      const line = template.value.lines[index];
      if (!line) continue;
      template.value.lines = template.value.lines.map((item, position) =>
        position === index
          ? {
              ...item,
              offsetX: Math.round(((item.offsetX ?? 0) + dx) * 10) / 10,
              offsetY: Math.round((item.offsetY + dy) * 10) / 10,
            }
          : item,
      );
    }
    // Группа текста притягивается к осям своим общим центром.
    if (selection.centers.length > 0) {
      const layout = computeStampLayout(template.value, (id) => fonts.familyOf(id));
      const boxes = selection.centers
        .map((layoutIndex) => layout.lines[layoutIndex])
        .filter((item) => Boolean(item));
      if (boxes.length > 0) {
        const left = Math.min(...boxes.map((item) => item.x));
        const right = Math.max(...boxes.map((item) => item.x + item.width));
        const top = Math.min(...boxes.map((item) => item.baseline - item.fontSize));
        const bottom = Math.max(...boxes.map((item) => item.baseline));
        const groupX = (left + right) / 2;
        const groupY = (top + bottom) / 2;
        const center = sizeCenter();
        const snapX = Math.abs(groupX - center) < 2 ? center - groupX : 0;
        const snapY = Math.abs(groupY - center) < 2 ? center - groupY : 0;
        if (snapX !== 0 || snapY !== 0) {
          for (const layoutIndex of selection.centers) {
            const index = templateCenterIndex(layoutIndex);
            const line = template.value.lines[index];
            if (!line) continue;
            template.value.lines[index] = {
              ...line,
              offsetX: Math.round(((line.offsetX ?? 0) + snapX) * 10) / 10,
              offsetY: Math.round((line.offsetY + snapY) * 10) / 10,
            };
          }
        }
      }
    }
  }
  for (const index of selection.logos) {
    const logo = stampLogos.value[index];
    if (!logo) continue;
    updateLogo(index, {
      offsetX: Math.round((logo.offsetX + dx) * 10) / 10,
      offsetY: Math.round((logo.offsetY + dy) * 10) / 10,
    });
  }
}

function sizeCenter(): number {
  return Math.max(24, Math.min(template.value.width, template.value.height)) / 2;
}

/** Удалить все выбранные объекты (Del или кнопка в карточке группы). */
function deleteMultiSelection(): void {
  const selection = multiSelection.value;
  if (!selection) return;
  const settings = template.value.seal;
  if (settings && selection.lines.length > 0) {
    const remove = new Set(selection.lines);
    settings.lines = settings.lines.filter((line) => !remove.has(line.id));
  }
  if (selection.centers.length > 0) {
    const visible = template.value.lines.filter((line) => line.text.trim().length > 0);
    const removeIndexes = new Set(
      selection.centers
        .map((layoutIndex) => template.value.lines.indexOf(visible[layoutIndex]))
        .filter((index) => index >= 0),
    );
    template.value.lines = template.value.lines.filter((_, index) => !removeIndexes.has(index));
  }
  if (selection.logos.length > 0) {
    const remove = new Set(selection.logos);
    const list = stampLogos.value.filter((_, index) => !remove.has(index));
    template.value.logos = list;
    template.value.logo = list[0] ?? null;
  }
  if (settings && selection.rings.length > 0) {
    const remove = [...selection.rings].sort((a, b) => b - a);
    for (const index of remove) {
      if (settings.rings.length > 1) settings.rings.splice(index, 1);
    }
    settings.rings[0].gap = 0;
    for (const line of settings.lines) {
      line.slot = Math.min(line.slot, settings.rings.length - 1);
    }
  }
  clearSelection();
}

function addLine(): void {
  const settings = template.value.seal;
  if (!settings) return;
  const active = settings.lines.find((line) => line.id === selectedLineId.value);

  // Ищем зазор со свободным местом: сначала текущий, потом остальные.
  const preferred = active ? active.slot : 0;
  let slot = preferred;
  if (lineCountInSlot(slot) >= MAX_LINES_PER_SLOT) {
    slot = settings.rings.findIndex((_, index) => lineCountInSlot(index) < MAX_LINES_PER_SLOT);
  }
  if (slot < 0) {
    ui.notify.warning(
      'В каждом зазоре уже по две строки',
      'Добавьте ещё кольцо или удалите строку — больше двух строк в зазоре не помещается',
    );
    return;
  }

  // В зазоре максимум две строки — по одной на верхнюю и нижнюю половину.
  const topTaken = settings.lines.some((line) => line.slot === slot && line.side === 'top');
  const side: 'top' | 'bottom' = topTaken ? 'bottom' : 'top';
  const line = createSealRingLine({
    text: 'Новая строка',
    slot,
    side,
    fontSize: active ? active.fontSize : 7,
    letterSpacing: active ? active.letterSpacing : 1,
    wordSpacing: active ? active.wordSpacing : 2,
  });
  settings.lines.push(line);
  selectLine(line.id, { reveal: true });
}

function updateLine(lineId: string, patch: Partial<SealRingLine>): void {
  const settings = template.value.seal;
  if (!settings) return;
  const current = settings.lines.find((line) => line.id === lineId);
  if (!current) return;
  // В один зазор — не больше двух строк.
  if (
    patch.slot !== undefined &&
    patch.slot !== current.slot &&
    lineCountInSlot(patch.slot, lineId) >= MAX_LINES_PER_SLOT
  ) {
    ui.notify.warning('В этом зазоре уже две строки', 'Выберите другой зазор или удалите строку');
    return;
  }
  settings.lines = settings.lines.map((line) =>
    line.id === lineId ? { ...line, ...patch } : line,
  );
}

function deleteLine(lineId: string): void {
  const settings = template.value.seal;
  if (!settings) return;
  settings.lines = settings.lines.filter((line) => line.id !== lineId);
  if (selectedLineId.value === lineId) selectedLineId.value = null;
}

function onSpanChange(lineId: string, angle: number): void {
  const settings = template.value.seal;
  if (!settings) return;
  const line = settings.lines.find((item) => item.id === lineId);
  if (!line) return;
  const target = Math.min(400, Math.max(1, angle));
  const layout = computeStampLayout(template.value, (id) => fonts.familyOf(id));
  const geometry = layout.seal?.ringLines.find((item) => item.lineId === lineId);
  const count = Array.from(line.text).length;
  if (!geometry || count === 0) {
    updateLine(lineId, { spanAngle: target });
    return;
  }
  // Тянем за маркер — меняем именно трекинг, чтобы ползунок «Между буквами»
  // показывал реальное значение. Угол при этом остаётся естественным.
  const actual = Math.abs(geometry.endAngle - geometry.startAngle);
  const delta = ((target - actual) * Math.PI * geometry.radius) / (180 * count);
  const letterSpacing = Math.round(((line.letterSpacing ?? 0) + delta) * 10) / 10;
  updateLine(lineId, {
    spanAngle: 1,
    letterSpacing: Math.min(60, Math.max(-4, letterSpacing)),
  });
}

function onLineMove(lineId: string, radiusOffset: number, angleOffset: number): void {
  updateLine(lineId, { radiusOffset, angleOffset });
}

/** Поставить фокус в поле и каретку в конец. */
function focusInput(input: HTMLInputElement | null | undefined): void {
  if (!input) return;
  input.focus();
  const end = input.value.length;
  try {
    input.setSelectionRange(end, end);
  } catch {
    /* не все типы input поддерживают выделение */
  }
}

/** Двойной клик по строке на превью: выбрать её и встать в текст. */
async function onTextHit(lineId: string): Promise<void> {
  selectedLineId.value = lineId;
  selectedCenterIndex.value = null;
  tab.value = 'text';
  await nextTick();
  const index = lineIndex(lineId);
  if (index < 0) return;
  focusInput(
    rightColumn.value?.querySelector<HTMLInputElement>(
      `[data-testid="seal-line-${index}-text"] input`,
    ),
  );
}

/** Двойной клик по строке центра. */
async function onCenterHit(lineIndexValue: number): Promise<void> {
  selectCenterLine(lineIndexValue, { reveal: false });
  await nextTick();
  const visible = template.value.lines.filter((line) => line.text.trim().length > 0);
  const line = visible[lineIndexValue] ?? visible[0];
  const index = line ? template.value.lines.indexOf(line) : 0;
  focusInput(
    rightColumn.value?.querySelector<HTMLInputElement>(
      `[data-testid="seal-center-line-${index}"] input`,
    ),
  );
}

/* ======================== Очистка ======================== */

/** Полностью очистить превью: убрать все тексты и логотип. */
async function clearPreview(): Promise<void> {
  const confirmed = await ui.askConfirm({
    title: 'Очистить превью?',
    text: 'Удалятся все строки текста (по кольцам и в центре) и логотип. Кольца, цвет и размеры останутся — с них удобно начинать заново.',
    confirmLabel: 'Очистить',
    danger: true,
  });
  if (!confirmed) return;
  const settings = template.value.seal;
  if (settings) settings.lines = [];
  template.value.lines = [];
  template.value.logo = null;
  selectedLineId.value = null;
  selectedCenterIndex.value = null;
  selectedRingIndex.value = null;
  ui.notify.info('Превью очищено', 'Остались кольца и настройки краски — можно собирать печать с нуля');
}

/* ======================== Центр ======================== */

/** Видимые строки центра — в том же порядке, что и в раскладке. */
function visibleCenterLines(): StampTextLine[] {
  return template.value.lines.filter((line) => line.text.trim().length > 0);
}

/** Индекс строки в шаблоне по индексу в раскладке. */
function templateCenterIndex(layoutIndex: number): number {
  const line = visibleCenterLines()[layoutIndex];
  return line ? template.value.lines.indexOf(line) : -1;
}

/** Запомнить, где строки центра стояли до структурного изменения. */
function captureCenterPositions(): Map<string, { x: number; y: number }> {
  const layout = computeStampLayout(template.value, (id) => fonts.familyOf(id));
  const map = new Map<string, { x: number; y: number }>();
  const visible = visibleCenterLines();
  layout.lines.forEach((geometry, index) => {
    const line = visible[index];
    if (line) map.set(line.id, { x: geometry.x, y: geometry.baseline });
  });
  return map;
}

/** Вернуть строки на прежние места: добавляение/удаление соседей их не двигает. */
function restoreCenterPositions(before: Map<string, { x: number; y: number }>): void {
  const layout = computeStampLayout(template.value, (id) => fonts.familyOf(id));
  const visible = visibleCenterLines();
  layout.lines.forEach((geometry, index) => {
    const line = visible[index];
    const target = line ? before.get(line.id) : undefined;
    if (!line || !target) return;
    line.offsetX = Math.round(((line.offsetX ?? 0) + target.x - geometry.x) * 10) / 10;
    line.offsetY = Math.round(((line.offsetY ?? 0) + target.y - geometry.baseline) * 10) / 10;
  });
  template.value.lines = [...template.value.lines];
}

function addCenterLine(): void {
  if (template.value.lines.length >= 3) return;
  const before = captureCenterPositions();
  template.value.lines.push(createStampLine('Новая строка', { fontSize: 9 }));
  restoreCenterPositions(before);
  // Новая строка не должна наехать на соседнюю — чуть опускаем её.
  const added = template.value.lines[template.value.lines.length - 1];
  if (added) added.offsetY = template.value.lines.length > 1 ? 14 : 0;
}

function removeCenterLine(index: number): void {
  const before = captureCenterPositions();
  template.value.lines = template.value.lines.filter((_, position) => position !== index);
  restoreCenterPositions(before);
  if (selectedCenterIndex.value !== null) {
    if (selectedCenterIndex.value === index) selectedCenterIndex.value = null;
    else if (selectedCenterIndex.value > index) selectedCenterIndex.value -= 1;
  }
}

function updateCenterLine(index: number, patch: Partial<StampTextLine>): void {
  template.value.lines = template.value.lines.map((line, position) =>
    position === index ? { ...line, ...patch } : line,
  );
}

/** Маркер растянул строку центра: меняем трекинг, кегль не трогаем. */
function onCenterStretch(layoutIndex: number, width: number): void {
  const index = templateCenterIndex(layoutIndex);
  if (index < 0) return;
  const line = template.value.lines[index];
  const layout = computeStampLayout(template.value, (id) => fonts.familyOf(id));
  const geometry = layout.lines[layoutIndex];
  if (!geometry) return;
  const chars = Math.max(1, Array.from(line.text).length);
  if (chars < 2) return;
  const delta = (width - geometry.width) / (chars - 1);
  updateCenterLine(index, {
    letterSpacing: Math.round(Math.min(60, Math.max(-10, line.letterSpacing + delta)) * 10) / 10,
  });
}

/** Строку центра перетащили — свободное положение в любом месте. */
function onCenterMove(layoutIndex: number, offsetX: number, offsetY: number): void {
  const index = templateCenterIndex(layoutIndex);
  if (index < 0) return;
  updateCenterLine(index, { offsetX, offsetY });
}

/* ======================== Логотип ======================== */

/** Обновить один логотип и синхронизировать совместимый `logo`. */
function updateLogo(index: number, patch: Partial<StampLogo>): void {
  const list = stampLogos.value.map((logo, position) =>
    position === index ? { ...logo, ...patch } : logo,
  );
  template.value.logos = list;
  template.value.logo = list[0] ?? null;
}

function onLogoMove(index: number, offsetX: number, offsetY: number): void {
  updateLogo(index, { offsetX, offsetY });
}

function onLogoResize(index: number, width: number, height: number): void {
  updateLogo(index, { width, height });
}

function onLogoRotate(index: number, rotation: number): void {
  updateLogo(index, { rotation: ((rotation % 360) + 360) % 360 });
}

/** Загрузка логотипа: он добавляется к уже имеющимся. */
async function uploadLogo(): Promise<void> {
  const { openFileDialog, readImageFile, ACCEPT } = await import('@/services/fileService');
  const files = await openFileDialog({ accept: ACCEPT.images });
  if (files.length === 0) return;
  const image = await readImageFile(files[0]);
  const maxSide = Math.min(template.value.width, template.value.height) * 0.5;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const logo: StampLogo = {
    id: createId('logo'),
    src: image.src,
    width: image.naturalWidth * scale,
    height: image.naturalHeight * scale,
    offsetX: 0,
    offsetY: 0,
    opacity: 1,
    rotation: 0,
  };
  const list = [...stampLogos.value, logo];
  template.value.logos = list;
  template.value.logo = list[0] ?? null;
  selectedLogo.value = true;
  selectedLogoIndex.value = list.length - 1;
  selectedLineId.value = null;
  selectedCenterIndex.value = null;
  selectedRingIndex.value = null;
  tab.value = 'logo';
}

function removeLogo(index = selectedLogoIndex.value ?? 0): void {
  const list = stampLogos.value.filter((_, position) => position !== index);
  template.value.logos = list;
  template.value.logo = list[0] ?? null;
  selectedLogo.value = false;
  selectedLogoIndex.value = null;
}

/* ======================== Образец печати под превью ======================== */

/** Выбрать образец: показываем его рамку, углы и маркер поворота. */
function selectReference(): void {
  multiSelection.value = null;
  selectedReference.value = true;
  selectedLineId.value = null;
  selectedCenterIndex.value = null;
  selectedRingIndex.value = null;
  selectedLogo.value = false;
  selectedLogoIndex.value = null;
  tab.value = 'sample';
  void nextTick(() => {
    rightColumn.value
      ?.querySelector('[data-testid=seal-reference-controls]')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

/** Загрузка картинки-образца из файла. */
async function uploadReference(): Promise<void> {
  const { openFileDialog, readImageFile, ACCEPT } = await import('@/services/fileService');
  const files = await openFileDialog({ accept: ACCEPT.images });
  if (files.length === 0) return;
  const image = await readImageFile(files[0]);
  const size = Math.max(24, Math.min(template.value.width, template.value.height));
  const width = size * 0.8;
  const height = Math.max(8, width * (image.naturalHeight / Math.max(1, image.naturalWidth)));
  reference.value = {
    src: image.src,
    x: size / 2,
    y: size / 2,
    width,
    height,
    rotation: 0,
    opacity: 0.6,
    visible: true,
  };
  selectReference();
}

function onReferenceMove(x: number, y: number): void {
  if (!reference.value) return;
  reference.value = { ...reference.value, x, y };
}

function onReferenceResize(width: number, height: number): void {
  if (!reference.value) return;
  reference.value = { ...reference.value, width, height };
}

function onReferenceRotate(rotation: number): void {
  if (!reference.value) return;
  reference.value = { ...reference.value, rotation: ((rotation % 360) + 360) % 360 };
}

function toggleReference(): void {
  if (!reference.value) return;
  reference.value = { ...reference.value, visible: !reference.value.visible };
}

function setReferenceOpacity(value: number): void {
  if (!reference.value) return;
  reference.value = { ...reference.value, opacity: Math.min(1, Math.max(0.05, value)) };
}

/** Замок образца: клики по нему больше не выбирают и не двигают его. */
function toggleReferenceLock(): void {
  if (!reference.value) return;
  const locked = !reference.value.locked;
  reference.value = { ...reference.value, locked };
  if (locked) selectedReference.value = false;
  ui.notify.info(
    locked ? 'Образец заблокирован' : 'Образец разблокирован',
    locked ? 'Клики по нему игнорируются — случайно не сдвинете' : 'Образец снова можно двигать и поворачивать',
  );
}

function removeReference(): void {
  reference.value = null;
  selectedReference.value = false;
}

/* ======================== Пресеты ======================== */

const presets: { label: string; build: () => StampTemplate }[] = [
  { label: 'Организация', build: () => createSealTemplate() },
  {
    label: 'ИП',
    build: () =>
      createSealTemplate({
        name: 'Печать ИП',
        lines: [
          createStampLine('ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ', { fontSize: 6, bold: true }),
          createStampLine('Иванов И. И.', { fontSize: 9, bold: true }),
        ],
        seal: createSealSettings({
          rings: [createSealRing(2.2, 0), createSealRing(1.1, 3.5)],
          lines: [
            createSealRingLine({
              text: 'ИНН 770123456789 · ОГРНИП 320770000000001',
              fontSize: 4.5,
              slot: 0,
              side: 'top',
            }),
            createSealRingLine({ text: 'г. Москва', fontSize: 6.5, slot: 0, side: 'bottom' }),
          ],
        }),
      }),
  },
  {
    label: 'Только кольца',
    build: () =>
      createSealTemplate({
        name: 'Пустая печать',
        lines: [],
        seal: createSealSettings({
          rings: [createSealRing(2.6, 0), createSealRing(1.2, 4), createSealRing(1, 3)],
          lines: [],
        }),
      }),
  },
];

/** Применить образец: сохраняем идентификатор (если печать уже существует). */
function applyPreset(builder: () => StampTemplate): void {
  const next = builder();
  template.value = withSealSettings({
    ...next,
    id: template.value.id || createId('seal'),
    name: next.name,
  });
  selectedLineId.value = null;
  selectedCenterIndex.value = null;
  selectedRingIndex.value = null;
  zoom.value = fitZoomValue();
  resetHistory();
}

/* ======================== Сохранение и вставка ======================== */

/** Сборка «чистого» шаблона без реактивных Proxy. */
function collectTemplate(): StampTemplate {
  const plain = JSON.parse(JSON.stringify(template.value)) as StampTemplate;
  const settings = normalizeSealSettings(plain.seal ?? sealSettingsFromTemplate(plain));
  const px = sealDiameterPx(settings.diameterMm);
  const now = new Date().toISOString();
  return {
    ...plain,
    id: plain.id || createId('seal'),
    kind: 'seal',
    shape: 'round',
    seal: settings,
    width: px,
    height: px,
    name: plain.name?.trim() || 'Печать',
    createdAt: plain.createdAt || now,
    updatedAt: now,
  };
}

async function saveToLibrary(): Promise<void> {
  isSaving.value = true;
  try {
    const value = collectTemplate();
    template.value = value;
    await library.saveStamp(value);
    library.activeType = 'seal';
    ui.notify.success('Печать сохранена в библиотеку', value.name);
  } catch (error) {
    ui.notify.error(
      'Не удалось сохранить печать',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    isSaving.value = false;
  }
}

/** «Добавить на документ» / «Применить» для уже стоящей печати. */
async function insertIntoDocument(): Promise<void> {
  const value = collectTemplate();
  template.value = value;

  // Библиотека — вторична: даже если хранилище недоступно, печать встанет.
  try {
    await library.saveStamp(value);
    library.activeType = 'seal';
  } catch (error) {
    ui.notify.warning(
      'Печать не сохранена в библиотеку',
      `${error instanceof Error ? error.message : String(error)} — объект добавлен только на страницу.`,
    );
  }

  if (targetObjectId.value) {
    objects.update(
      targetObjectId.value,
      { payload: { templateId: value.id, template: value } },
      'Обновление печати',
    );
    saveSealBackground(`object:${targetObjectId.value}`, previewBg.value);
    ui.notify.success('Печать обновлена на странице');
  } else {
    const object = createStampObject(value, {
      page: editor.currentPage,
      x: editor.pageSize.width / 2 - value.width / 2,
      y: editor.pageSize.height / 2 - value.height / 2,
      templateId: value.id,
    });
    objects.add([object], 'Добавление печати');
    // Запоминаем фон для этой печати, чтобы он вернулся при редактировании.
    saveSealBackground(`object:${object.id}`, previewBg.value);
    saveSealBackground(`template:${value.id}`, previewBg.value);
    ui.notify.success('Печать добавлена на страницу', 'Переместите, поверните или растяните её на холсте');
  }

  editor.toolOptions.lastStampId = value.id;
  clearSealDraft();
  restoredDraft.value = false;
  suppressDraftSave = true;
  ui.closeModal('sealDesigner');
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onDesignerKeydown, true);
  window.removeEventListener('pointerdown', onGlobalPointerDown, true);
  if (historyTimer !== null) {
    window.clearTimeout(historyTimer);
    historyTimer = null;
  }
  if (import.meta.env.DEV) {
    delete (window as unknown as { __SEAL_DESIGNER__?: StampTemplate }).__SEAL_DESIGNER__;
  }
});

/* ======================== Пипетка ======================== */

function onPickStart(): void {
  picking.value = true;
}

function onPickEnd(color: string | null): void {
  picking.value = false;
  if (color) ui.notify.info('Цвет взят с холста', color.toUpperCase());
}
</script>

<template>
  <AppModal
    v-model="isOpen"
    title="Конструктор печати"
    subtitle="Круглый оттиск: кольца, строки текста по кольцам, центр и краска"
    icon="seal"
    width="xl"
    body-class="lg:max-h-none lg:overflow-visible"
    :suspended="picking"
  >
    <div
      class="grid gap-5 lg:h-[min(62vh,700px)] lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]"
      data-testid="seal-designer"
    >
      <!-- ======================= Превью ======================= -->
      <div class="space-y-3 lg:h-full lg:overflow-y-auto lg:pr-2" data-testid="seal-left-column">
        <div
          v-if="restoredDraft"
          class="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30"
          data-testid="seal-draft-notice"
        >
          <span>Восстановлено незавершённое редактирование.</span>
          <button type="button" class="font-medium underline" @click="resetDraft">Сбросить</button>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span
              class="rounded-lg bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              data-testid="seal-size-label"
            >
              {{ seal.diameterMm }} мм · {{ Math.round(diameterPx) }} px
            </span>
            <span class="text-[11px] text-slate-400">
              {{ seal.rings.length }} кольца · {{ seal.lines.length }} строк
            </span>
          </div>
          <div class="flex items-center gap-1.5">
            <AppButton size="xs" variant="ghost" icon="zoomOut" @click="setZoom(zoom - 0.25)" />
            <input
              v-model.number="zoom"
              data-testid="seal-zoom"
              type="range"
              min="0.5"
              max="12"
              step="0.25"
              class="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-slate-200 accent-brand-600 dark:bg-slate-700"
            />
            <AppButton size="xs" variant="ghost" icon="zoomIn" @click="setZoom(zoom + 0.25)" />
            <span class="w-12 text-center font-mono text-[11px] text-slate-500">
              {{ Math.round(zoom * 100) }}%
            </span>
            <AppButton size="xs" variant="ghost" @click="fitZoom">Вписать</AppButton>
            <AppButton size="xs" variant="ghost" icon="trash" data-testid="seal-clear" @click="clearPreview">
              Очистить
            </AppButton>
          </div>
        </div>

        <!-- Большое превью -->
        <div
          class="relative flex h-[430px] items-center justify-center overflow-hidden rounded-xl border border-slate-200 p-0 transition-colors dark:border-slate-700"
          :class="previewBg ? '' : 'checker-bg'"
          :style="previewBg ? { backgroundColor: previewBg } : undefined"
          data-testid="seal-preview-box"
        >
          <SealPreview
            ref="previewRef"
            :template="template"
            :zoom="zoom"
            :reference="reference"
            :selected-line-id="selectedLineId"
            :selected-center-index="selectedCenterIndex"
            :selected-ring-index="selectedRingIndex"
            :selected-logo="selectedLogo"
            :selected-logo-index="selectedLogoIndex"
            :selection="multiSelection"
            :selected-reference="selectedReference"
            @select-line="selectLine($event)"
            @clear-selection="clearSelection"
            @span-change="onSpanChange"
            @line-move="onLineMove"
            @text-hit="onTextHit"
            @center-hit="onCenterHit"
            @center-select="selectCenterLine"
            @center-stretch="onCenterStretch"
            @center-move="onCenterMove"
            @ring-select="selectRing"
            @ring-resize="onRingResize"
            @ring-delete="onRingDelete"
            @logo-select="selectLogo"
            @logo-move="onLogoMove"
            @logo-resize="onLogoResize"
            @logo-rotate="onLogoRotate"
            @selection-change="onSelectionChange"
            @group-move="onGroupMove"
            @reference-select="selectReference"
            @reference-move="onReferenceMove"
            @reference-resize="onReferenceResize"
            @reference-rotate="onReferenceRotate"
            @add-ring="addRing"
            @add-text="addLine"
            @add-center-text="addCenterLine"
            @add-reference="uploadReference"
            @zoom-change="zoomByFactor"
            @edit-line="onTextHit"
            @delete-line="deleteLine"
          />
        </div>

        <!-- Фон превью: только подложка, в печать и PDF не попадает -->
        <div class="flex flex-wrap items-center gap-1.5" data-testid="seal-backgrounds">
          <span class="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Фон превью
          </span>
          <button
            v-for="item in previewBackgrounds"
            :key="item.id"
            type="button"
            class="flex h-6 items-center gap-1 rounded-md border px-1.5 text-[10px] transition-colors"
            :class="
              previewBg === item.color
                ? 'border-brand-500 text-brand-700 dark:text-brand-300'
                : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400'
            "
            :data-testid="`seal-bg-${item.id}`"
            @click="previewBg = item.color"
          >
            <span
              class="h-3.5 w-3.5 rounded-sm ring-1 ring-inset ring-slate-900/15"
              :class="item.color ? '' : 'checker-bg'"
              :style="item.color ? { backgroundColor: item.color } : undefined"
            />
            {{ item.label }}
          </button>
        </div>
        <p class="-mt-1 text-[11px] text-slate-400">
          Фон — только подложка превью: в документ, PDF и библиотеку он не попадает.
        </p>

        <p class="text-[11px] text-slate-400">
          Клик по строке выбирает её и показывает маркеры угла; строку можно тащить мышью,
          двойной клик — правка текста, правый клик — меню. Панорама — колесо мыши или
          перетаскивание средней кнопкой (или с зажатым пробелом).
        </p>
      </div>

      <!-- ======================= Настройки ======================= -->
      <div
        ref="rightColumn"
        class="seal-settings space-y-3 lg:h-full lg:overflow-y-auto lg:pr-2"
        data-testid="seal-right-column"
      >
        <AppInput v-model="template.name" label="Название печати" size="sm" />
        <AppTabs v-model="tab" :items="tabs" />

        <!-- Группа: несколько объектов, выделенных рамкой или Shift+кликом -->
        <div
          v-if="multiSelection && multiSelectionCount > 1"
          class="flex items-center justify-between gap-2 rounded-lg border border-brand-300 bg-brand-50/60 px-2.5 py-2 text-[12px] text-brand-800 dark:border-brand-500/50 dark:bg-brand-500/10 dark:text-brand-200"
          data-testid="seal-multi-card"
        >
          <span>Выбрано объектов: {{ multiSelectionCount }}</span>
          <AppButton
            size="xs"
            variant="ghost"
            icon="trash"
            data-testid="seal-multi-delete"
            @click="deleteMultiSelection"
          >
            Удалить
          </AppButton>
        </div>

        <!-- Кольца -->
        <div v-show="tab === 'rings'" class="space-y-3">
          <AppSection title="Размер" icon="circle">
            <AppSlider
              :model-value="seal.diameterMm"
              label="Диаметр"
              unit="мм"
              :min="SEAL_MIN_MM"
              :max="SEAL_MAX_MM"
              :step="0.5"
              :precision="1"
              data-testid="seal-diameter"
              @update:model-value="setDiameter(Number($event))"
            />
            <p class="text-[11px] text-slate-400">
              1 px = 1 pt: {{ Math.round(diameterPx) }} px на странице — ровно этот размер
              попадёт в PDF.
            </p>
          </AppSection>

          <AppSection title="Кольца" icon="circle">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[11px] text-slate-400">
                Новое кольцо встаёт внутрь — под уже нарисованный текст
              </span>
              <AppButton
                size="xs"
                icon="plus"
                :disabled="seal.rings.length >= SEAL_MAX_RINGS"
                data-testid="seal-add-ring"
                @click="addRing"
              >
                Кольцо
              </AppButton>
            </div>

            <div
              v-for="(ring, index) in seal.rings"
              :key="`ring-${index}`"
              class="rounded-lg border p-2 transition-colors"
              :class="
                selectedRingIndex === index
                  ? 'border-brand-400 bg-brand-50/40 dark:border-brand-500/60 dark:bg-brand-500/5'
                  : 'border-slate-200 dark:border-slate-700'
              "
              :data-testid="`seal-ring-${index}`"
              :data-active="selectedRingIndex === index ? 'true' : 'false'"
              @pointerdown="selectRing(index, { reveal: false })"
            >
              <div class="mb-1 flex items-center justify-between">
                <span
                  class="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400"
                >
                  Кольцо {{ index + 1 }}
                </span>
                <AppButton
                  size="xs"
                  variant="ghost"
                  icon="trash"
                  title="Удалить кольцо"
                  :disabled="seal.rings.length <= 1"
                  :data-testid="`seal-ring-${index}-delete`"
                  @click="removeRing(index)"
                />
              </div>
              <AppSlider
                :model-value="ring.width"
                label="Толщина"
                unit="pt"
                :min="0.2"
                :max="8"
                :step="0.1"
                :precision="1"
                @update:model-value="ring.width = Number($event)"
              />
              <AppSlider
                v-if="index > 0"
                :model-value="ring.gap"
                label="Расстояние до кольца"
                unit="pt"
                :min="0.5"
                :max="100"
                :step="0.1"
                :precision="1"
                @update:model-value="ring.gap = Number($event)"
              />
            </div>
          </AppSection>
        </div>

        <!-- Текст по кольцам -->
        <div v-show="tab === 'text'" class="space-y-3" data-testid="seal-text-tab">
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-slate-400">
              Строки центрируются по кольцевому зазору
            </span>
            <AppButton
              size="xs"
              icon="plus"
              data-testid="seal-add-ring-line"
              @click="addLine"
            >
              Строка
            </AppButton>
          </div>

          <p
            v-if="multiLineSlots.length > 0"
            class="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30"
            data-testid="seal-crowded-hint"
          >
            В зазоре «{{ multiLineSlots.map((slot) => slotOptions[slot]?.label).join('», «') }}»
            несколько строк. Если они не помещаются, увеличьте расстояние между кольцами или
            уменьшите кегль — строки центрируются по зазору и могут выйти за кольца.
          </p>

          <p
            v-if="seal.lines.length === 0"
            class="rounded-lg border border-dashed border-slate-200 p-4 text-center text-[11px] text-slate-400 dark:border-slate-700"
            data-testid="seal-no-lines"
          >
            Пока нет строк. Добавьте строку и выберите, между какими кольцами она стоит.
          </p>

          <SealLineControls
            v-for="(line, index) in seal.lines"
            :key="line.id"
            :line="line"
            :index="index"
            :slot-options="slotOptions"
            :font-options="fontOptions"
            :active="selectedLineId === line.id"
            :effective-span="lineSpans[line.id] ?? 0"
            @select="selectLine(line.id, { reveal: false })"
            @delete="deleteLine(line.id)"
          />
        </div>

        <!-- Центр -->
        <div v-show="tab === 'center'" class="space-y-3">
          <AppSection title="Текст в центре (до 3 строк)" icon="type">
            <div class="flex items-center justify-between">
              <span class="text-[11px] text-slate-400">Строки центрируются автоматически</span>
              <AppButton
                size="xs"
                icon="plus"
                :disabled="template.lines.length >= 3"
                data-testid="seal-add-line"
                @click="addCenterLine"
              >
                Строка
              </AppButton>
            </div>

            <div
              v-for="(line, index) in template.lines"
              :key="line.id"
              class="space-y-1.5 rounded-lg border p-2 transition-colors"
              :class="
                selectedCenterIndex === index
                  ? 'border-brand-400 bg-brand-50/40 dark:border-brand-500/60 dark:bg-brand-500/5'
                  : 'border-slate-200 dark:border-slate-700'
              "
              :data-testid="`seal-center-card-${index}`"
              :data-active="selectedCenterIndex === index ? 'true' : 'false'"
              @pointerdown="selectCenterLine(index, { reveal: false })"
            >
              <div class="flex items-center gap-1.5">
                <AppInput
                  :model-value="line.text"
                  size="sm"
                  placeholder="Текст строки"
                  class="flex-1"
                  :data-testid="`seal-center-line-${index}`"
                  @update:model-value="updateCenterLine(index, { text: String($event ?? '') })"
                />
                <AppButton
                  size="xs"
                  variant="ghost"
                  icon="trash"
                  title="Удалить строку"
                  @click="removeCenterLine(index)"
                />
              </div>
              <div class="grid grid-cols-2 gap-2">
                <AppSelect
                  :model-value="line.fontId ?? ''"
                  label="Шрифт"
                  size="sm"
                  :options="[{ value: '', label: 'Как у печати' }, ...fontOptions]"
                  @update:model-value="updateCenterLine(index, { fontId: String($event || '') || undefined })"
                />
                <div class="flex items-end gap-1.5">
                  <AppButton
                    size="sm"
                    :variant="line.bold ? 'primary' : 'subtle'"
                    icon="bold"
                    block
                    title="Жирный"
                    @click="updateCenterLine(index, { bold: !line.bold })"
                  >
                    Ж
                  </AppButton>
                  <AppButton
                    size="sm"
                    :variant="line.italic ? 'primary' : 'subtle'"
                    icon="italic"
                    block
                    title="Курсив"
                    @click="updateCenterLine(index, { italic: !line.italic })"
                  >
                    К
                  </AppButton>
                  <AppButton
                    size="sm"
                    variant="subtle"
                    icon="alignCenter"
                    block
                    title="Центрировать по вертикальной оси печати"
                    data-testid="seal-center-align"
                    @click="updateCenterLine(index, { offsetX: 0 })"
                  >
                    Ц
                  </AppButton>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <AppInput
                  :model-value="line.fontSize"
                  label="Кегль, pt"
                  type="number"
                  size="sm"
                  :min="3"
                  :max="24"
                  @update:model-value="updateCenterLine(index, { fontSize: Number($event) || 9 })"
                />
                <AppInput
                  :model-value="line.letterSpacing"
                  label="Между буквами, pt"
                  type="number"
                  size="sm"
                  :step="0.1"
                  @update:model-value="updateCenterLine(index, { letterSpacing: Number($event) || 0 })"
                />
                <AppInput
                  :model-value="line.wordSpacing ?? 0"
                  label="Между словами, pt"
                  type="number"
                  size="sm"
                  :step="0.1"
                  :data-testid="`seal-center-line-${index}-word`"
                  @update:model-value="updateCenterLine(index, { wordSpacing: Number($event) || 0 })"
                />
                <div class="flex items-end text-[11px] leading-tight text-slate-400">
                  Клик по строке на превью — маркеры растяжения; строку можно перетащить.
                </div>
              </div>
            </div>
          </AppSection>
        </div>

        <!-- Логотип или герб -->
        <div v-show="tab === 'logo'" class="space-y-3" data-testid="seal-logo-tab">
          <AppSection title="Логотип или герб" icon="image" data-testid="seal-logo-section">
            <div v-if="stampLogos.length" class="space-y-2">
              <div
                v-for="(logo, index) in stampLogos"
                :key="logo.id ?? index"
                class="space-y-1.5 rounded-lg border p-2 transition-colors"
                :class="
                  selectedLogoIndex === index
                    ? 'border-brand-400 bg-brand-50/40 dark:border-brand-500/60 dark:bg-brand-500/5'
                    : 'border-slate-200 dark:border-slate-700'
                "
                :data-testid="`seal-logo-card-${index}`"
                :data-active="selectedLogoIndex === index ? 'true' : 'false'"
                @pointerdown="selectLogo(index)"
              >
                <div class="flex items-center gap-3">
                  <span
                    class="checker-bg flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700"
                  >
                    <img :src="logo.src" alt="Логотип" class="h-full w-full object-contain" />
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="text-[12px] font-medium text-slate-700 dark:text-slate-200">
                      Логотип {{ index + 1 }}
                    </p>
                    <p class="text-[11px] text-slate-400">
                      Клик — выбрать; тяните, растягивайте, вращайте на превью.
                    </p>
                  </div>
                  <AppButton
                    size="xs"
                    variant="ghost"
                    icon="trash"
                    title="Удалить логотип"
                    :data-testid="`seal-logo-remove-${index}`"
                    @click.stop="removeLogo(index)"
                  />
                </div>
                <AppSlider
                  :model-value="logo.opacity"
                  label="Прозрачность"
                  :min="0.1"
                  :max="1"
                  :step="0.05"
                  :precision="2"
                  @update:model-value="updateLogo(index, { opacity: Number($event) })"
                />
              </div>
              <AppButton size="sm" icon="upload" block data-testid="seal-logo-add" @click="uploadLogo">
                Добавить логотип
              </AppButton>
              <p class="text-[11px] text-slate-400">
                Логотипов может быть несколько: у каждого своё положение, размер и поворот.
                Поддерживаются PNG, JPEG и SVG.
              </p>
            </div>
            <div v-else class="space-y-2">
              <AppButton size="sm" icon="upload" block data-testid="seal-logo-add" @click="uploadLogo">
                Загрузить логотип
              </AppButton>
              <p class="text-[11px] text-slate-400">
                PNG, JPEG или SVG. Логотип ставится в центр печати и ведёт себя как объект:
                его можно двигать, растягивать и вращать. Можно добавить несколько.
              </p>
            </div>
          </AppSection>
        </div>

        <!-- Образец: готовые шаблоны и картинка-подложка -->
        <div v-show="tab === 'sample'" class="space-y-3" data-testid="seal-sample-tab">
          <div
            v-if="reference"
            class="rounded-lg border border-slate-200 px-2.5 py-2 dark:border-slate-700"
            data-testid="seal-reference-lock"
          >
            <AppToggle
              :model-value="reference.locked === true"
              label="Замок образца"
              hint="Клики по образцу игнорируются: его нельзя случайно сдвинуть, растянуть или повернуть. Снимите замок, чтобы снова редактировать."
              @update:model-value="toggleReferenceLock"
            />
          </div>

          <AppSection title="Образцы печати" icon="layers">
            <div class="flex flex-wrap gap-1.5">
              <AppButton
                v-for="preset in presets"
                :key="preset.label"
                size="sm"
                variant="subtle"
                @click="applyPreset(preset.build)"
              >
                {{ preset.label }}
              </AppButton>
            </div>
            <p class="text-[11px] text-slate-400">
              Готовые шаблоны заменяют настройки печати целиком.
            </p>
          </AppSection>

          <AppSection title="Образец печати" icon="image" data-testid="seal-reference-controls">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[11px] text-slate-400">Картинка-подложка под оттиском</span>
              <AppButton
                size="xs"
                variant="subtle"
                icon="image"
                data-testid="seal-reference-add"
                @click="uploadReference"
              >
                {{ reference ? 'Заменить' : 'Из файла' }}
              </AppButton>
            </div>
            <template v-if="reference">
              <div class="flex flex-wrap items-center gap-1.5">
                <AppToggle
                  :model-value="reference.visible"
                  label="Показывать образец"
                  data-testid="seal-reference-visible"
                  @update:model-value="toggleReference"
                />
                <AppButton size="xs" variant="ghost" icon="trash" data-testid="seal-reference-remove" @click="removeReference">
                  Убрать
                </AppButton>
              </div>
              <AppSlider
                :model-value="reference.opacity"
                label="Прозрачность образца"
                unit=""
                :min="0.05"
                :max="1"
                :step="0.05"
                :precision="2"
                data-testid="seal-reference-opacity"
                @update:model-value="setReferenceOpacity(Number($event))"
              />
              <p class="text-[11px] text-slate-400">
                Образец лежит под оттиском: тяните за видимую часть, растягивайте за углы
                (Shift — пропорции), вращайте за круглый маркер. На печать и PDF он не влияет.
              </p>
            </template>
            <p v-else class="text-[11px] text-slate-400">
              Загрузите фото или скан готовой печати — он ляжет под превью, чтобы удобно было
              повторить оттиск. Образец не входит в печать.
            </p>
          </AppSection>
        </div>

        <!-- Краска и эффекты -->
        <div v-show="tab === 'ink'" class="space-y-3">
          <AppSection title="Интенсивность" icon="palette">
            <AppColorPicker
              v-model="template.color"
              label="Цвет оттиска"
              :presets="SEAL_COLORS"
              @pick-start="onPickStart"
              @pick-end="onPickEnd"
            />
            <p class="text-[11px] text-slate-400">
              Пипетка временно сворачивает окно — цвет можно взять прямо с холста.
            </p>
            <AppSlider
              v-model="template.opacity"
              label="Прозрачность оттиска"
              :min="0.15"
              :max="1"
              :step="0.05"
              :precision="2"
              data-testid="seal-opacity"
            />
            <p class="text-[11px] text-slate-400">
              Для «свежей» печати достаточно 0.75–0.9: бумага должна просвечивать.
            </p>
          </AppSection>

          <AppSection title="Неидеальность" icon="sliders">
            <AppToggle
              v-model="seal.ink.enabled"
              label="Эффект живой печати"
              hint="Неровные края, отдельные точки краски и второй прокат. По умолчанию выключен"
              data-testid="seal-ink-toggle"
            />
            <template v-if="seal.ink.enabled">
              <AppSlider
                :model-value="seal.ink.roughness"
                label="Неровность контуров"
                :min="0"
                :max="1"
                :step="0.05"
                :precision="2"
                @update:model-value="seal.ink.roughness = Number($event)"
              />
              <AppSlider
                :model-value="seal.ink.grain"
                label="Зернистость"
                :min="0"
                :max="1"
                :step="0.05"
                :precision="2"
                @update:model-value="seal.ink.grain = Number($event)"
              />
              <AppSlider
                :model-value="seal.ink.doubleStrike"
                label="Второй прокат"
                :min="0"
                :max="1"
                :step="0.05"
                :precision="2"
                @update:model-value="seal.ink.doubleStrike = Number($event)"
              />
              <AppSlider
                :model-value="seal.ink.strikeOffset"
                label="Смещение проката"
                unit="pt"
                :min="0"
                :max="3"
                :step="0.05"
                :precision="2"
                @update:model-value="seal.ink.strikeOffset = Number($event)"
              />
              <div class="flex items-end gap-2">
                <AppInput
                  :model-value="seal.ink.seed"
                  label="Зерно (seed)"
                  type="number"
                  size="sm"
                  class="flex-1"
                  @update:model-value="seal.ink.seed = Math.trunc(Number($event) || 1337)"
                />
                <AppButton
                  size="sm"
                  icon="refresh"
                  title="Другой рисунок краски"
                  @click="seal.ink.seed = Math.floor(Math.random() * 100000) + 1"
                >
                  Другой
                </AppButton>
              </div>
              <p class="text-[11px] text-slate-400">
                Рисунок краски воспроизводим: при одном и том же зерне оттиск на холсте и в
                PDF одинаковый.
              </p>
            </template>
          </AppSection>
        </div>
      </div>
    </div>

    <template #footer>
      <AppButton variant="ghost" @click="ui.closeModal('sealDesigner')">Отмена</AppButton>
      <AppButton icon="save" :loading="isSaving" @click="saveToLibrary">
        Сохранить в библиотеку
      </AppButton>
      <AppButton variant="primary" icon="check" data-testid="seal-insert" @click="insertIntoDocument">
        {{ targetObjectId ? 'Применить' : 'Добавить на документ' }}
      </AppButton>
    </template>
  </AppModal>
</template>

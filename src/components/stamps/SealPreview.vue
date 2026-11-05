<script setup lang="ts">
/**
 * Превью круглой печати с интерактивными строками текста.
 *
 * Рисуется тем же `computeStampLayout` + `paintStampLayout`, что и объект на
 * странице и экспорт в PDF, поэтому конструктор показывает ровно то, что
 * попадёт в документ.
 *
 * Взаимодействие:
 *  - клик по надписи выбирает строку, клик по пустому месту — снимает выбор;
 *  - у выбранной строки появляются два маркера: тянете — угол дуги растёт
 *    или сжимается;
 *  - саму строку можно тащить мышью: по радиусу (внутри её кольцевого
 *    зазора) и по окружности;
 *  - правый клик по надписи — меню «Редактировать / Удалить»;
 *  - двойной клик — переход в поле ввода строки.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { StampTemplate } from '@/types';
import { computeStampLayout, paintStampLayout } from '@/services/stampRenderService';
import { sealArcMinSpan } from '@/services/sealRenderService';
import { useFontsStore } from '@/stores/fonts';
import { loadImage } from '@/utils/image';

const props = withDefaults(
  defineProps<{
    template: StampTemplate;
    /** Масштаб показа: 1 — 1 pt печати = 1 px экрана. */
    zoom: number;
    /** Показывать ли маркеры выбранной строки. */
    handles?: boolean;
    /** Какая строка выбрана (null — никакая). */
    selectedLineId?: string | null;
  }>(),
  { handles: true, selectedLineId: null },
);

const emit = defineEmits<{
  /** Клик выбрал строку (null — снял выбор). */
  'select-line': [lineId: string | null];
  /** Маркер изменил угол дуги выбранной строки. */
  'span-change': [lineId: string, angle: number];
  /** Строку перетащили: смещение по радиусу (pt) и по углу (градусы). */
  'line-move': [lineId: string, radiusOffset: number, angleOffset: number];
  /** Двойной клик по строке — редактировать текст. */
  'text-hit': [lineId: string];
  /** Двойной клик по строке центра. */
  'center-hit': [lineIndex: number];
  /** Клик по строке центра — показать её свойства справа. */
  'center-select': [lineIndex: number];
  /** Пункт контекстного меню «Редактировать». */
  'edit-line': [lineId: string];
  /** Пункт контекстного меню «Удалить». */
  'delete-line': [lineId: string];
}>();

const fonts = useFontsStore();
const canvas = ref<HTMLCanvasElement | null>(null);
const logoImage = ref<HTMLImageElement | null>(null);

/** Размер печати в координатах шаблона. */
const size = computed(() => Math.max(24, Math.min(props.template.width, props.template.height)));
const displaySize = computed(() => Math.round(size.value * props.zoom * 100) / 100);
const layout = computed(() =>
  computeStampLayout(props.template, (fontId) => fonts.familyOf(fontId)),
);

/** Контекстное меню по правому клику. */
const menu = ref<{ lineId: string; x: number; y: number } | null>(null);

/* ======================== Отрисовка ======================== */

async function ensureLogo(): Promise<void> {
  const src = props.template.logo?.src;
  if (!src) {
    logoImage.value = null;
    return;
  }
  try {
    logoImage.value = await loadImage(src);
  } catch {
    logoImage.value = null;
  }
}

function draw(): void {
  const element = canvas.value;
  if (!element) return;
  const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const cssSize = displaySize.value;
  element.width = Math.max(1, Math.round(cssSize * ratio));
  element.height = Math.max(1, Math.round(cssSize * ratio));
  element.style.width = `${cssSize}px`;
  element.style.height = `${cssSize}px`;
  const context = element.getContext('2d');
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, element.width, element.height);
  context.scale((cssSize / size.value) * ratio, (cssSize / size.value) * ratio);
  paintStampLayout(context, layout.value, { logoImage: logoImage.value });
}

watch(() => props.template, async () => {
  await ensureLogo();
  draw();
}, { deep: true });
watch(() => props.zoom, () => draw());
watch(() => fonts.loadedOnce, () => draw());

/* ======================== Геометрия и попадания ======================== */

/** Точка окна → координаты печати. */
function toSealPoint(event: MouseEvent): { x: number; y: number } | null {
  const element = canvas.value;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / props.zoom,
    y: (event.clientY - rect.top) / props.zoom,
  };
}

/** Строка под курсором (по «чернилам» глифов). */
function hitRingLine(point: { x: number; y: number }): string | null {
  const seal = layout.value.seal;
  if (!seal) return null;
  for (const ringLine of seal.ringLines) {
    for (const char of ringLine.chars) {
      const radians = (char.angle * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const glyphWidth = char.fontSize * 0.6;
      const centerX = char.x + cos * (glyphWidth / 2) + sin * (char.fontSize * 0.35);
      const centerY = char.y + sin * (glyphWidth / 2) - cos * (char.fontSize * 0.35);
      const reach = Math.max(5, char.fontSize * 0.85);
      if (Math.hypot(point.x - centerX, point.y - centerY) <= reach) {
        return ringLine.lineId;
      }
    }
  }
  return null;
}

/** Строка центра под курсором. */
function hitCenterLine(point: { x: number; y: number }): number | null {
  for (const [index, line] of layout.value.lines.entries()) {
    if (
      point.x >= line.x - 2 &&
      point.x <= line.x + line.width + 2 &&
      point.y >= line.baseline - line.fontSize * 1.05 &&
      point.y <= line.baseline + line.fontSize * 0.3
    ) {
      return index;
    }
  }
  return null;
}

/** Выбранная строка в раскладке. */
const selectedGeometry = computed(() => {
  if (!props.selectedLineId) return null;
  return (
    layout.value.seal?.ringLines.find((item) => item.lineId === props.selectedLineId) ?? null
  );
});

/** Маркеры выбранной строки (в координатах превью). */
const handlePoints = computed(() => {
  const ringLine = selectedGeometry.value;
  if (!ringLine || ringLine.chars.length === 0) {
    return [] as { angle: number; x: number; y: number }[];
  }
  return [ringLine.startAngle, ringLine.endAngle].map((angle) => {
    const radians = (angle * Math.PI) / 180;
    return {
      angle,
      x: (ringLine.cx + Math.cos(radians) * ringLine.radius) * props.zoom,
      y: (ringLine.cy + Math.sin(radians) * ringLine.radius) * props.zoom,
    };
  });
});

/* ======================== Маркеры растяжения ======================== */

const MIN_SPAN = 8;
const MAX_SPAN = 340;

function onHandleDown(event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const lineId = props.selectedLineId;
  if (!lineId) return;
  emit('select-line', lineId);
  window.addEventListener('pointermove', onHandleMove);
  window.addEventListener('pointerup', onHandleUp, { once: true });
}

function onHandleMove(event: PointerEvent): void {
  const lineId = props.selectedLineId;
  const ringLine = selectedGeometry.value;
  const point = toSealPoint(event);
  if (!lineId || !ringLine || !point) return;
  const cx = size.value / 2;
  const cy = size.value / 2;
  const angle = (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI;
  let delta = angle - ringLine.centerAngle;
  delta = ((delta % 360) + 540) % 360 - 180;

  // Ниже этого угла буквы уже не помещаются — маркер туда не пускаем,
  // чтобы ползунок и картинка не расходились.
  const templateLine = props.template.seal?.lines.find((item) => item.id === lineId);
  const minimum = templateLine
    ? sealArcMinSpan({
        text: templateLine.text,
        radius: ringLine.radius,
        fontSize: ringLine.fontSize,
        letterSpacing: templateLine.letterSpacing,
        wordSpacing: templateLine.wordSpacing,
        family: fonts.familyOf(templateLine.fontId ?? props.template.fontId),
        bold: templateLine.bold,
        italic: templateLine.italic,
      })
    : 0;

  const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, minimum, Math.abs(delta) * 2));
  emit('span-change', lineId, Math.round(span * 10) / 10);
}

function onHandleUp(): void {
  window.removeEventListener('pointermove', onHandleMove);
}

/* ======================== Перетаскивание строки ======================== */

interface MoveState {
  lineId: string;
  startPointerAngle: number;
  startPointerRadius: number;
  startRadiusOffset: number;
  startAngleOffset: number;
  maxRadiusOffset: number;
  moved: boolean;
}

let moveState: MoveState | null = null;

/** Предел сдвига по радиусу — чтобы строка не уходила из своего зазора. */
function radiusLimit(lineId: string): number {
  const seal = layout.value.seal;
  const line = props.template.seal?.lines.find((item) => item.id === lineId);
  if (!seal || !line) return 10;
  const slot = seal.slots[Math.min(seal.slots.length - 1, Math.max(0, line.slot))];
  if (!slot) return 10;
  return Math.max(0, slot.thickness / 2);
}

function onCanvasDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const point = toSealPoint(event);
  if (!point) return;
  const lineId = hitRingLine(point);
  if (!lineId) {
    // Клик по тексту центра — показать его свойства, как у строк по кольцам.
    const centerIndex = hitCenterLine(point);
    if (centerIndex !== null) {
      emit('center-select', centerIndex);
      return;
    }
    emit('select-line', null);
    return;
  }
  emit('select-line', lineId);
  const ringLine = layout.value.seal?.ringLines.find((item) => item.lineId === lineId);
  const templateLine = props.template.seal?.lines.find((item) => item.id === lineId);
  if (!ringLine || !templateLine) return;
  const cx = size.value / 2;
  const cy = size.value / 2;
  moveState = {
    lineId,
    startPointerAngle: (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI,
    startPointerRadius: Math.hypot(point.x - cx, point.y - cy),
    startRadiusOffset: templateLine.radiusOffset,
    startAngleOffset: templateLine.angleOffset,
    maxRadiusOffset: radiusLimit(lineId),
    moved: false,
  };
  window.addEventListener('pointermove', onCanvasMove);
  window.addEventListener('pointerup', onCanvasUp, { once: true });
}

function onCanvasMove(event: PointerEvent): void {
  const state = moveState;
  const point = toSealPoint(event);
  if (!state || !point) return;
  const cx = size.value / 2;
  const cy = size.value / 2;
  const angle = (Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI;
  const radius = Math.hypot(point.x - cx, point.y - cy);
  let deltaAngle = angle - state.startPointerAngle;
  deltaAngle = ((deltaAngle % 360) + 540) % 360 - 180;
  const deltaRadius = radius - state.startPointerRadius;
  if (!state.moved && Math.abs(deltaAngle) < 1 && Math.abs(deltaRadius) < 0.5) return;
  state.moved = true;
  const radiusOffset = Math.round(
    Math.min(state.maxRadiusOffset, Math.max(-state.maxRadiusOffset, state.startRadiusOffset + deltaRadius)) * 10,
  ) / 10;
  const angleOffset = Math.round((state.startAngleOffset + deltaAngle) * 10) / 10;
  emit('line-move', state.lineId, radiusOffset, angleOffset);
}

function onCanvasUp(): void {
  window.removeEventListener('pointermove', onCanvasMove);
  moveState = null;
}

/* ======================== Клики и меню ======================== */

function onDoubleClick(event: MouseEvent): void {
  const point = toSealPoint(event);
  if (!point) return;
  const lineId = hitRingLine(point);
  if (lineId) {
    emit('text-hit', lineId);
    return;
  }
  const centerIndex = hitCenterLine(point);
  if (centerIndex !== null) emit('center-hit', centerIndex);
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  const point = toSealPoint(event);
  if (!point) return;
  const lineId = hitRingLine(point);
  if (!lineId) {
    menu.value = null;
    return;
  }
  emit('select-line', lineId);
  const element = canvas.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  menu.value = {
    lineId,
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function closeMenu(): void {
  menu.value = null;
}

function onWindowDown(event: PointerEvent): void {
  if (!menu.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('[data-testid=seal-text-menu]')) return;
  closeMenu();
}

function onEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenu();
}

function pickEdit(): void {
  if (!menu.value) return;
  const lineId = menu.value.lineId;
  closeMenu();
  emit('edit-line', lineId);
}

function pickDelete(): void {
  if (!menu.value) return;
  const lineId = menu.value.lineId;
  closeMenu();
  emit('delete-line', lineId);
}

onMounted(async () => {
  await ensureLogo();
  draw();
  window.addEventListener('pointerdown', onWindowDown, true);
  window.addEventListener('keydown', onEscape);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onHandleMove);
  window.removeEventListener('pointermove', onCanvasMove);
  window.removeEventListener('pointerup', onHandleUp);
  window.removeEventListener('pointerup', onCanvasUp);
  window.removeEventListener('pointerdown', onWindowDown, true);
  window.removeEventListener('keydown', onEscape);
  logoImage.value = null;
});
</script>

<template>
  <div
    class="relative inline-flex items-center justify-center"
    :style="{ width: `${displaySize}px`, height: `${displaySize}px` }"
  >
    <canvas
      ref="canvas"
      data-testid="seal-preview-canvas"
      class="block cursor-pointer rounded-sm"
      @pointerdown="onCanvasDown"
      @dblclick="onDoubleClick"
      @contextmenu="onContextMenu"
    />

    <!-- Маркеры растяжения/сужения выбранной строки -->
    <template v-if="handles && selectedLineId">
      <button
        v-for="(point, index) in handlePoints"
        :key="`top-${index}`"
        type="button"
        :data-testid="`seal-handle-${index}`"
        class="absolute z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-white bg-brand-500 shadow ring-1 ring-brand-700/40 transition-transform hover:scale-125"
        :style="{ left: `${point.x}px`, top: `${point.y}px` }"
        title="Потяните, чтобы растянуть или сжать строку"
        @pointerdown="onHandleDown"
      />
    </template>

    <!-- Контекстное меню по правому клику на строке -->
    <div
      v-if="menu"
      data-testid="seal-text-menu"
      class="absolute z-20 min-w-[150px] animate-fade-in rounded-lg border border-slate-200 bg-white py-1 shadow-floating dark:border-slate-700 dark:bg-slate-900"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
        data-testid="seal-menu-edit"
        @click="pickEdit"
      >
        Редактировать
      </button>
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
        data-testid="seal-menu-delete"
        @click="pickDelete"
      >
        Удалить
      </button>
    </div>
  </div>
</template>

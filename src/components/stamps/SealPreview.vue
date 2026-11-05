<script setup lang="ts">
/**
 * Превью круглой печати.
 *
 * Рисуется тем же `computeStampLayout` + `paintStampLayout`, что и объект на
 * странице и экспорт в PDF, поэтому конструктор показывает ровно то, что
 * попадёт в документ.
 *
 * Особенность — маркеры растяжения дуг: две точки на верхней и две на нижней
 * дуге. Потянув за маркер, пользователь задаёт угол дуги, текст равномерно
 * расходится по ней (трекинг пересчитывается, глифы не деформируются).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { StampTemplate } from '@/types';
import { computeStampLayout, paintStampLayout } from '@/services/stampRenderService';
import { useFontsStore } from '@/stores/fonts';
import { loadImage } from '@/utils/image';

const props = withDefaults(
  defineProps<{
    template: StampTemplate;
    /** Масштаб показа: 1 — 1 px печати = 1 px экрана. */
    zoom: number;
    /** Показывать ли маркеры растяжения дуг. */
    handles?: boolean;
  }>(),
  { handles: true },
);

const emit = defineEmits<{
  /** Пользователь потянул маркер дуги: новый угол в градусах. */
  'span-change': [side: 'top' | 'bottom', angle: number];
  /**
   * Двойной клик по тексту на превью: какую подпись редактировать.
   * `center` — строки в центре (`lineIndex` — номер строки).
   */
  'text-hit': [target: 'top' | 'bottom' | 'center', lineIndex: number];
}>();

const fonts = useFontsStore();
const canvas = ref<HTMLCanvasElement | null>(null);
const logoImage = ref<HTMLImageElement | null>(null);
const dragging = ref<'top' | 'bottom' | null>(null);

/** Размер печати в «пикселях печати». */
const size = computed(() => Math.max(24, Math.min(props.template.width, props.template.height)));

/** Размер на экране. */
const displaySize = computed(() => Math.round(size.value * props.zoom * 100) / 100);

/** Раскладка — общая для рисования и для позиций маркеров. */
const layout = computed(() =>
  computeStampLayout(props.template, (fontId) => fonts.familyOf(fontId)),
);

/** Минимальный и максимальный угол дуги. */
const MIN_SPAN = 20;
const MAX_SPAN = 340;

/**
 * Маркеры дуг в координатах превью (CSS-пиксели).
 * У дуги два маркера — начало и конец; тянем любой, угол меняется
 * симметрично относительно центра дуги.
 */
const handlePoints = computed(() => {
  const seal = layout.value.seal;
  if (!seal) return [] as { side: 'top' | 'bottom'; angle: number; x: number; y: number }[];
  const points: { side: 'top' | 'bottom'; angle: number; x: number; y: number }[] = [];
  for (const arc of seal.arcs) {
    if (!arc.enabled || arc.chars.length === 0) continue;
    for (const angle of [arc.startAngle, arc.endAngle]) {
      const radians = (angle * Math.PI) / 180;
      points.push({
        side: arc.side,
        angle,
        x: (arc.cx + Math.cos(radians) * arc.radius) * props.zoom,
        y: (arc.cy + Math.sin(radians) * arc.radius) * props.zoom,
      });
    }
  }
  return points;
});

/** Загрузка логотипа (единоразово на источник). */
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

/** Перерисовка. */
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

/* ======================== Маркеры растяжения ======================== */

/** Нормализация угла в диапазон (-180, 180]. */
function normalizeAngle(angle: number): number {
  let value = angle % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return value;
}

/** Текущий центр дуги, градусы. */
function arcCenterAngle(side: 'top' | 'bottom'): number {
  const arc = layout.value.seal?.arcs.find((item) => item.side === side);
  return arc ? (arc.startAngle + arc.endAngle) / 2 : side === 'top' ? 270 : 90;
}

function onPointerDown(event: PointerEvent, side: 'top' | 'bottom'): void {
  event.preventDefault();
  event.stopPropagation();
  dragging.value = side;
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function onPointerMove(event: PointerEvent): void {
  const side = dragging.value;
  const element = canvas.value;
  if (!side || !element) return;
  const rect = element.getBoundingClientRect();
  // Экран → координаты печати.
  const x = (event.clientX - rect.left) / props.zoom;
  const y = (event.clientY - rect.top) / props.zoom;
  const cx = size.value / 2;
  const cy = size.value / 2;
  const angle = (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
  const delta = Math.abs(normalizeAngle(angle - arcCenterAngle(side)));
  // Текущий фактический угол: ниже него дуга не сжимается (иначе кегль
  // пришлось бы уменьшать, а он у нас стабилен).
  const arc = layout.value.seal?.arcs.find((item) => item.side === side);
  const natural = arc ? Math.abs(arc.endAngle - arc.startAngle) : 0;
  const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, natural, delta * 2));
  emit('span-change', side, Math.round(span * 10) / 10);
}

function onPointerUp(): void {
  dragging.value = null;
  window.removeEventListener('pointermove', onPointerMove);
}

/* ======================== Двойной клик по тексту ======================== */

/**
 * Что находится под курсором.
 *
 * Для дуг перебираем глифы и проверяем расстояние до центра «чернильного»
 * прямоугольника буквы; для центра — прямоугольники строк. Этого достаточно,
 * чтобы двойной клик по надписи попадал в неё, а не в пустое поле печати.
 */
function hitText(event: MouseEvent): { target: 'top' | 'bottom' | 'center'; lineIndex: number } | null {
  const element = canvas.value;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const x = (event.clientX - rect.left) / props.zoom;
  const y = (event.clientY - rect.top) / props.zoom;
  const seal = layout.value.seal;

  for (const arc of seal?.arcs ?? []) {
    if (!arc.enabled) continue;
    for (const char of arc.chars) {
      const radians = (char.angle * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const glyphWidth = char.fontSize * 0.6;
      // Центр глифа: середина по базовой линии, приподнятая на пол-кегля.
      const centerX = char.x + cos * (glyphWidth / 2) + sin * (char.fontSize * 0.35);
      const centerY = char.y + sin * (glyphWidth / 2) - cos * (char.fontSize * 0.35);
      const reach = Math.max(4, char.fontSize * 0.8);
      if (Math.hypot(x - centerX, y - centerY) <= reach) {
        return { target: arc.side, lineIndex: -1 };
      }
    }
  }

  for (const [index, line] of layout.value.lines.entries()) {
    if (
      x >= line.x - 2 &&
      x <= line.x + line.width + 2 &&
      y >= line.baseline - line.fontSize * 1.05 &&
      y <= line.baseline + line.fontSize * 0.3
    ) {
      return { target: 'center', lineIndex: index };
    }
  }
  return null;
}

function onDoubleClick(event: MouseEvent): void {
  const hit = hitText(event);
  if (hit) emit('text-hit', hit.target, hit.lineIndex);
}

onMounted(async () => {
  await ensureLogo();
  draw();
});

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  logoImage.value = null;
});
</script>

<template>
  <div class="relative inline-flex items-center justify-center" :style="{ width: `${displaySize}px`, height: `${displaySize}px` }">
    <canvas
      ref="canvas"
      data-testid="seal-preview-canvas"
      class="block rounded-sm"
      :class="dragging ? 'cursor-grabbing' : 'cursor-default'"
      @dblclick="onDoubleClick"
    />

    <!-- Маркеры дуг: тянутся мышью, задавая угол дуги -->
    <template v-if="handles">
      <button
        v-for="(point, index) in handlePoints"
        :key="`${point.side}-${index}`"
        type="button"
        :data-testid="`seal-handle-${point.side}-${index}`"
        class="absolute z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-brand-500 shadow ring-1 ring-brand-700/40 transition-transform hover:scale-125"
        :style="{ left: `${point.x}px`, top: `${point.y}px` }"
        :title="`Потяните, чтобы растянуть ${point.side === 'top' ? 'верхнюю' : 'нижнюю'} дугу`"
        @pointerdown="onPointerDown($event, point.side)"
      />
    </template>
  </div>
</template>

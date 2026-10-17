<script setup lang="ts">
/**
 * Полотно для рисования от руки: используется редактором подписей и рисунков.
 * Работает с мышью, пальцем и стилусом, поддерживает давление пера.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { StrokeData, StrokePoint } from '@/types';
import { paintStrokes } from '@/services/strokeService';

const model = defineModel<StrokeData[]>({ default: () => [] });

const props = withDefaults(
  defineProps<{
    width: number;
    height: number;
    color?: string;
    strokeWidth?: number;
    penOnly?: boolean;
    showGrid?: boolean;
  }>(),
  { color: '#111827', strokeWidth: 2.4, penOnly: false, showGrid: false },
);

const emit = defineEmits<{ change: [] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
const isDrawing = ref(false);
const ratio = typeof window !== 'undefined' ? Math.min(3, window.devicePixelRatio || 1) : 2;

const activeStroke = ref<StrokeData | null>(null);

function ctx2d(): CanvasRenderingContext2D | null {
  const element = canvas.value;
  if (!element) return null;
  return element.getContext('2d');
}

/** Полная перерисовка полотна. */
function redraw(): void {
  const context = ctx2d();
  if (!context) return;
  const { width, height } = props;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width * ratio, height * ratio);
  context.scale(ratio, ratio);

  if (props.showGrid) {
    context.save();
    context.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    context.lineWidth = 0.5;
    const step = 20;
    context.beginPath();
    for (let x = step; x < width; x += step) {
      context.moveTo(x, 0);
      context.lineTo(x, height);
    }
    for (let y = step; y < height; y += step) {
      context.moveTo(0, y);
      context.lineTo(width, y);
    }
    context.stroke();
    context.restore();
  }

  paintStrokes(context, model.value);

  // Базовая линия подписи (подсказка).
  if (!props.penOnly && model.value.length === 0 && !isDrawing.value) {
    context.save();
    context.strokeStyle = 'rgba(148, 163, 184, 0.6)';
    context.setLineDash([6, 6]);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(width * 0.08, height * 0.72);
    context.lineTo(width * 0.92, height * 0.72);
    context.stroke();
    context.restore();
  }

  if (activeStroke.value) {
    paintStrokes(context, [activeStroke.value]);
  }

  context.restore();
}

/** Координаты события в локальной системе полотна. */
function eventPoint(event: PointerEvent): StrokePoint {
  const element = canvas.value;
  if (!element) return { x: 0, y: 0, pressure: 0.5 };
  const rect = element.getBoundingClientRect();
  const scaleX = props.width / rect.width;
  const scaleY = props.height / rect.height;
  const pressure = event.pressure > 0 && Math.abs(event.pressure - 0.5) > 0.001 ? event.pressure : 0.5;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
    pressure,
  };
}

function onPointerDown(event: PointerEvent): void {
  event.preventDefault();
  if (props.penOnly && event.pointerType === 'mouse') return;
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  isDrawing.value = true;
  activeStroke.value = {
    tool: 'brush',
    color: props.color,
    width: props.strokeWidth,
    opacity: 1,
    points: [eventPoint(event)],
    smooth: true,
  };
  redraw();
}

function onPointerMove(event: PointerEvent): void {
  if (!isDrawing.value || !activeStroke.value) return;
  const point = eventPoint(event);
  const last = activeStroke.value.points[activeStroke.value.points.length - 1];
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.6) return;
  activeStroke.value.points.push(point);
  redraw();
}

function onPointerUp(): void {
  if (!isDrawing.value) return;
  isDrawing.value = false;
  const stroke = activeStroke.value;
  activeStroke.value = null;
  if (stroke && stroke.points.length > 0) {
    model.value = [...model.value, stroke];
    emit('change');
  }
  redraw();
}

/** Отменить последний штрих. */
function undoStroke(): void {
  if (model.value.length === 0) return;
  model.value = model.value.slice(0, -1);
  emit('change');
  redraw();
}

/** Очистить полотно. */
function clear(): void {
  model.value = [];
  activeStroke.value = null;
  emit('change');
  redraw();
}

/** Перекрасить все штрихи. */
function recolor(color: string): void {
  model.value = model.value.map((stroke) => ({ ...stroke, color }));
}

/** Изменить толщину всех штрихов. */
function rescale(width: number): void {
  const reference = model.value[0]?.width ?? props.strokeWidth;
  const factor = width / Math.max(0.1, reference);
  model.value = model.value.map((stroke) => ({ ...stroke, width: Math.max(0.2, stroke.width * factor) }));
}

const isEmpty = computed(() => model.value.length === 0);

onMounted(() => {
  const element = canvas.value;
  if (!element) return;
  element.width = props.width * ratio;
  element.height = props.height * ratio;
  redraw();
});

watch(
  () => [props.width, props.height, props.showGrid, model.value.length] as const,
  () => {
    const element = canvas.value;
    if (element) {
      element.width = props.width * ratio;
      element.height = props.height * ratio;
    }
    redraw();
  },
  { deep: true },
);

watch(() => [props.color, props.strokeWidth], () => redraw());

onBeforeUnmount(() => {
  activeStroke.value = null;
});

defineExpose({ undoStroke, clear, recolor, rescale, redraw, isEmpty });
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      class="relative overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950"
      :style="{ aspectRatio: `${width} / ${height}` }"
    >
      <canvas
        ref="canvas"
        class="h-full w-full touch-none"
        :style="{ cursor: 'crosshair' }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerUp"
      />
      <div
        v-if="isEmpty && !isDrawing"
        class="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[11px] text-slate-400"
      >
        Нарисуйте подпись мышью, пальцем или стилусом
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <slot name="toolbar" :undo="undoStroke" :clear="clear" :recolor="recolor" :rescale="rescale" />
    </div>
  </div>
</template>

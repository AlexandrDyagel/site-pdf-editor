<script setup lang="ts">
/**
 * Подсказка при наведении (тултип).
 *
 * Пузырёк рендерится телепортом в `body` с `position: fixed` — почему так:
 *   - шапка редактора использует `backdrop-blur`, а он создаёт собственный
 *     контекст наложения, поэтому `absolute z-50` внутри шапки оказывался
 *     НИЖЕ холста и боковых панелей и подсказку было не видно;
 *   - панели обрезают содержимое через `overflow-hidden`, и подсказка у края
 *     панели обрезалась.
 * Теперь подсказка всегда поверх интерфейса, не обрезается и не выходит за
 * пределы окна (положение считается по `getBoundingClientRect` кнопки).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    text?: string;
    shortcut?: string;
    placement?: 'top' | 'bottom' | 'left' | 'right';
    disabled?: boolean;
    delay?: number;
  }>(),
  { placement: 'bottom', disabled: false, delay: 120 },
);

/** Отступ от элемента, px. */
const GAP = 8;
/** Минимальный отступ от края окна, px. */
const VIEWPORT_MARGIN = 8;

const visible = ref(false);
const wrapper = ref<HTMLElement | null>(null);
const bubble = ref<HTMLElement | null>(null);
const position = ref({ left: 0, top: 0, transform: 'translateX(-50%)' });
let timer: number | null = null;
let hideOnScrollBound = false;

const bubbleStyle = computed(() => ({
  left: `${position.value.left}px`,
  top: `${position.value.top}px`,
  transform: position.value.transform,
}));

/** Положение подсказки относительно кнопки. */
function measure(): void {
  const element = wrapper.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  let left = rect.left + rect.width / 2;
  let top = rect.bottom + GAP;
  let transform = 'translateX(-50%)';

  switch (props.placement) {
    case 'top':
      top = rect.top - GAP;
      transform = 'translate(-50%, -100%)';
      break;
    case 'left':
      left = rect.left - GAP;
      top = rect.top + rect.height / 2;
      transform = 'translate(-100%, -50%)';
      break;
    case 'right':
      left = rect.right + GAP;
      top = rect.top + rect.height / 2;
      transform = 'translate(0, -50%)';
      break;
    default:
      break;
  }
  position.value = { left, top, transform };
}

/** Не даём подсказке выйти за пределы окна. */
async function keepInViewport(): Promise<void> {
  await nextTick();
  const element = bubble.value;
  if (!element) return;
  const box = element.getBoundingClientRect();
  const anchor = position.value;

  let shift = 0;
  if (box.right > window.innerWidth - VIEWPORT_MARGIN) {
    shift = window.innerWidth - VIEWPORT_MARGIN - box.right;
  } else if (box.left < VIEWPORT_MARGIN) {
    shift = VIEWPORT_MARGIN - box.left;
  }

  let top = anchor.top;
  // Не хватает места внизу — показываем над элементом.
  if (box.bottom > window.innerHeight - VIEWPORT_MARGIN) {
    top = Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - box.height);
  }
  if (box.top < VIEWPORT_MARGIN) top += VIEWPORT_MARGIN - box.top;

  if (shift !== 0 || top !== anchor.top) {
    position.value = { ...anchor, left: anchor.left + shift, top };
  }
}

function show(): void {
  if (props.disabled || (!props.text && !props.shortcut)) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    measure();
    visible.value = true;
    void keepInViewport();
  }, props.delay);
}

function hide(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  visible.value = false;
}

/** Прокрутка (в том числе внутри панелей) сдвигает кнопку — подсказку скрываем. */
function onScroll(): void {
  if (visible.value) visible.value = false;
}

function onResize(): void {
  if (!visible.value) return;
  measure();
  void keepInViewport();
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  hideOnScrollBound = true;
});

onBeforeUnmount(() => {
  if (timer !== null) window.clearTimeout(timer);
  if (hideOnScrollBound) {
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
  }
});
</script>

<template>
  <span
    ref="wrapper"
    class="relative inline-flex"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
  >
    <slot />
  </span>

  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-100"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-75"
      leave-to-class="opacity-0"
    >
      <span
        v-if="visible && (text || shortcut)"
        ref="bubble"
        role="tooltip"
        class="pointer-events-none fixed z-[240] max-w-64 whitespace-normal rounded-lg bg-slate-900 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-floating dark:bg-slate-700"
        :style="bubbleStyle"
      >
        <span class="block">{{ text }}</span>
        <span
          v-if="shortcut"
          class="mt-0.5 block font-mono text-[10px] text-slate-300"
          >{{ shortcut }}</span
        >
      </span>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * Подсказка при наведении (тултип). Позиционируется относительно элемента,
 * закрывается по уходу курсора, доступна с клавиатуры.
 */
import { computed, onBeforeUnmount, ref } from 'vue';

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

const visible = ref(false);
const wrapper = ref<HTMLElement | null>(null);
let timer: number | null = null;

const placementClass = computed(() => {
  switch (props.placement) {
    case 'top':
      return 'bottom-full left-1/2 -translate-x-1/2 mb-2';
    case 'left':
      return 'right-full top-1/2 -translate-y-1/2 mr-2';
    case 'right':
      return 'left-full top-1/2 -translate-y-1/2 ml-2';
    case 'bottom':
    default:
      return 'top-full left-1/2 -translate-x-1/2 mt-2';
  }
});

function show(): void {
  if (props.disabled || (!props.text && !props.shortcut)) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    visible.value = true;
  }, props.delay);
}

function hide(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  visible.value = false;
}

onBeforeUnmount(() => {
  if (timer !== null) window.clearTimeout(timer);
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
    <Transition
      enter-active-class="transition duration-100"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-75"
      leave-to-class="opacity-0"
    >
      <span
        v-if="visible && (text || shortcut)"
        class="pointer-events-none absolute z-50 max-w-64 whitespace-normal rounded-lg bg-slate-900 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-floating dark:bg-slate-700"
        :class="placementClass"
        role="tooltip"
      >
        <span class="block">{{ text }}</span>
        <span
          v-if="shortcut"
          class="mt-0.5 block font-mono text-[10px] text-slate-300"
          >{{ shortcut }}</span
        >
      </span>
    </Transition>
  </span>
</template>

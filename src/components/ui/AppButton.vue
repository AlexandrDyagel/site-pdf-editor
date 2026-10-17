<script setup lang="ts">
/** Кнопка с вариантами оформления, состоянием загрузки и подсказкой. */
import { computed } from 'vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppSpinner from '@/components/ui/AppSpinner.vue';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle' | 'success';
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'icon';

const props = withDefaults(
  defineProps<{
    variant?: Variant;
    size?: Size;
    icon?: string;
    iconRight?: string;
    loading?: boolean;
    disabled?: boolean;
    active?: boolean;
    block?: boolean;
    title?: string;
    type?: 'button' | 'submit' | 'reset';
  }>(),
  { variant: 'secondary', size: 'md', loading: false, disabled: false, active: false, block: false, type: 'button' },
);

const emit = defineEmits<{ click: [event: MouseEvent] }>();

const variantClass = computed(() => {
  switch (props.variant) {
    case 'primary':
      return 'bg-brand-600 text-white hover:bg-brand-500 active:bg-brand-700 shadow-sm disabled:bg-brand-600/50';
    case 'danger':
      return 'bg-rose-600 text-white hover:bg-rose-500 active:bg-rose-700 shadow-sm';
    case 'success':
      return 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-sm';
    case 'ghost':
      return 'bg-transparent text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800';
    case 'subtle':
      return 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700';
    case 'secondary':
    default:
      return 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800';
  }
});

const sizeClass = computed(() => {
  switch (props.size) {
    case 'xs':
      return 'h-6 px-2 text-[11px] gap-1 rounded-md';
    case 'sm':
      return 'h-8 px-2.5 text-xs gap-1.5 rounded-lg';
    case 'lg':
      return 'h-11 px-5 text-sm gap-2 rounded-xl';
    case 'icon':
      return 'h-9 w-9 justify-center rounded-lg';
    case 'md':
    default:
      return 'h-9 px-3.5 text-[13px] gap-2 rounded-lg';
  }
});

const iconSize = computed(() => (props.size === 'xs' ? 13 : props.size === 'lg' ? 20 : 16));

const activeClass = computed(() =>
  props.active
    ? 'ring-2 ring-brand-500/70 bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-200'
    : '',
);
</script>

<template>
  <button
    :type="type"
    :title="title"
    :disabled="disabled || loading"
    class="inline-flex select-none items-center justify-center font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:cursor-not-allowed disabled:opacity-60"
    :class="[variantClass, sizeClass, activeClass, block ? 'w-full' : '']"
    @click="(event) => emit('click', event)"
  >
    <AppSpinner v-if="loading" :size="iconSize" />
    <AppIcon v-else-if="icon" :name="icon" :size="iconSize" />
    <slot />
    <AppIcon v-if="iconRight && !loading" :name="iconRight" :size="iconSize" />
  </button>
</template>

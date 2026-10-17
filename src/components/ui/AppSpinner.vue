<script setup lang="ts">
/** Индикатор загрузки. */
import { computed } from 'vue';

const props = withDefaults(defineProps<{ size?: number | string; label?: string }>(), {
  size: 16,
});

const pixelSize = computed(() =>
  typeof props.size === 'number' ? `${props.size}px` : props.size,
);
</script>

<template>
  <span class="inline-flex items-center gap-2">
    <svg
      :width="pixelSize"
      :height="pixelSize"
      viewBox="0 0 24 24"
      fill="none"
      class="animate-spin"
      role="status"
      aria-label="Загрузка"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
      />
    </svg>
    <span v-if="label" class="text-xs text-slate-500 dark:text-slate-400">{{ label }}</span>
  </span>
</template>

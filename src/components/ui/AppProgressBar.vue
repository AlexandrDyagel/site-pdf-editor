<script setup lang="ts">
/** Полоса прогресса длительных операций. */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    value: number;
    label?: string;
    detail?: string;
    showPercent?: boolean;
  }>(),
  { showPercent: true },
);

const percent = computed(() => Math.round(Math.max(0, Math.min(1, props.value)) * 100));
</script>

<template>
  <div class="w-full">
    <div v-if="label || showPercent" class="mb-1 flex items-center justify-between gap-2">
      <span v-if="label" class="truncate text-[11px] text-slate-500 dark:text-slate-400">
        {{ label }}
      </span>
      <span v-if="showPercent" class="font-mono text-[11px] text-slate-400">{{ percent }}%</span>
    </div>
    <div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
      <div
        class="h-full rounded-full bg-brand-600 transition-all duration-200"
        :style="{ width: `${percent}%` }"
      />
    </div>
    <p v-if="detail" class="mt-1 truncate text-[11px] text-slate-400">{{ detail }}</p>
  </div>
</template>

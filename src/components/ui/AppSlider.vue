<script setup lang="ts">
/** Ползунок для числовых параметров. */
import { computed } from 'vue';

const model = defineModel<number>({ default: 0 });

const props = withDefaults(
  defineProps<{
    label?: string;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    precision?: number;
    disabled?: boolean;
  }>(),
  { min: 0, max: 100, step: 1, unit: '', precision: 0, disabled: false },
);

const displayValue = computed(() => {
  const value = Number.isFinite(model.value) ? model.value : props.min;
  return `${value.toFixed(props.precision)}${props.unit ? ` ${props.unit}` : ''}`;
});

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  model.value = Number(target.value);
}
</script>

<template>
  <div class="block">
    <div class="mb-1 flex items-center justify-between">
      <span
        v-if="label"
        class="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400"
      >
        {{ label }}
      </span>
      <span class="font-mono text-[11px] text-slate-500 dark:text-slate-400">{{ displayValue }}</span>
    </div>
    <input
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="model"
      :disabled="disabled"
      class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-brand-600 disabled:cursor-not-allowed dark:bg-slate-700"
      @input="onInput"
    />
  </div>
</template>

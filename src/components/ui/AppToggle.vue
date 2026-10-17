<script setup lang="ts">
/** Переключатель (switch). */
const model = defineModel<boolean>({ default: false });

withDefaults(defineProps<{ label?: string; hint?: string; disabled?: boolean }>(), {
  disabled: false,
});
</script>

<template>
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <p v-if="label" class="text-[13px] text-slate-700 dark:text-slate-200">{{ label }}</p>
      <p v-if="hint" class="text-[11px] text-slate-400">{{ hint }}</p>
    </div>
    <button
      type="button"
      role="switch"
      :aria-checked="model"
      :disabled="disabled"
      class="relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      :class="model ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-600'"
      @click="model = !model"
    >
      <span
        class="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all"
        :class="model ? 'left-[18px]' : 'left-0.5'"
      />
    </button>
  </div>
</template>

<script setup lang="ts">
/** Пустое состояние: иконка, заголовок, пояснение и действия. */
import AppIcon from '@/components/ui/AppIcon.vue';

withDefaults(
  defineProps<{
    icon?: string;
    title: string;
    text?: string;
    compact?: boolean;
  }>(),
  { icon: 'info', compact: false },
);
</script>

<template>
  <div
    class="flex flex-col items-center justify-center text-center"
    :class="compact ? 'gap-2 px-3 py-6' : 'gap-3 px-6 py-12'"
  >
    <span
      class="flex items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500"
      :class="compact ? 'h-9 w-9' : 'h-12 w-12'"
    >
      <AppIcon :name="icon" :size="compact ? 18 : 24" />
    </span>
    <div>
      <p
        class="font-medium text-slate-700 dark:text-slate-200"
        :class="compact ? 'text-[13px]' : 'text-sm'"
      >
        {{ title }}
      </p>
      <p v-if="text" class="mt-1 max-w-sm text-[12px] leading-snug text-slate-400">
        {{ text }}
      </p>
    </div>
    <div v-if="$slots.default" class="mt-1 flex flex-wrap items-center justify-center gap-2">
      <slot />
    </div>
  </div>
</template>

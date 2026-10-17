<script setup lang="ts">
/** Вкладки. */
import AppIcon from '@/components/ui/AppIcon.vue';

export interface TabItem {
  id: string;
  label: string;
  icon?: string;
  badge?: string | number;
}

const model = defineModel<string>({ default: '' });

withDefaults(defineProps<{ items: TabItem[]; size?: 'sm' | 'md' }>(), { size: 'md' });
</script>

<template>
  <div
    class="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800/80"
    role="tablist"
  >
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      role="tab"
      :aria-selected="model === item.id"
      class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md font-medium transition-colors"
      :class="[
        size === 'sm' ? 'h-7 px-2 text-[11px]' : 'h-8 px-3 text-xs',
        model === item.id
          ? 'bg-white text-slate-800 shadow-sm dark:bg-slate-950 dark:text-slate-100'
          : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
      ]"
      @click="model = item.id"
    >
      <AppIcon v-if="item.icon" :name="item.icon" :size="14" />
      <span class="truncate">{{ item.label }}</span>
      <span
        v-if="item.badge !== undefined"
        class="rounded bg-slate-200 px-1 text-[10px] font-mono text-slate-600 dark:bg-slate-700 dark:text-slate-300"
      >
        {{ item.badge }}
      </span>
    </button>
  </div>
</template>

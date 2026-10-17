<script setup lang="ts">
/** Сворачиваемая секция для панелей свойств. */
import { ref } from 'vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const props = withDefaults(
  defineProps<{ title: string; icon?: string; defaultOpen?: boolean; dense?: boolean }>(),
  { defaultOpen: true, dense: false },
);

const open = ref(props.defaultOpen);
</script>

<template>
  <section class="border-b border-slate-200/80 dark:border-slate-800">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
      @click="open = !open"
    >
      <span class="flex items-center gap-2">
        <AppIcon v-if="icon" :name="icon" :size="14" class="text-slate-400" />
        <span
          class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
        >
          {{ title }}
        </span>
      </span>
      <AppIcon
        :name="open ? 'chevronUp' : 'chevronDown'"
        :size="14"
        class="text-slate-400"
      />
    </button>
    <div v-show="open" class="space-y-3 px-3 pb-3" :class="dense ? 'pt-0' : 'pt-1'">
      <slot />
    </div>
  </section>
</template>

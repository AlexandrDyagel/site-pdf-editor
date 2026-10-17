<script setup lang="ts">
/** Всплывающие уведомления. */
import { storeToRefs } from 'pinia';
import { useUiStore } from '@/stores/ui';
import AppIcon from '@/components/ui/AppIcon.vue';
import type { ToastMessage } from '@/types';

const ui = useUiStore();
const { toasts } = storeToRefs(ui);

const styles: Record<ToastMessage['type'], { wrap: string; icon: string; name: string }> = {
  info: {
    wrap: 'ring-brand-200 bg-white dark:bg-slate-900 dark:ring-brand-500/30',
    icon: 'bg-brand-50 text-brand-600 dark:bg-brand-500/20 dark:text-brand-300',
    name: 'info',
  },
  success: {
    wrap: 'ring-emerald-200 bg-white dark:bg-slate-900 dark:ring-emerald-500/30',
    icon: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300',
    name: 'check',
  },
  warning: {
    wrap: 'ring-amber-200 bg-white dark:bg-slate-900 dark:ring-amber-500/30',
    icon: 'bg-amber-50 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300',
    name: 'alert',
  },
  error: {
    wrap: 'ring-rose-200 bg-white dark:bg-slate-900 dark:ring-rose-500/30',
    icon: 'bg-rose-50 text-rose-600 dark:bg-rose-500/20 dark:text-rose-300',
    name: 'alert',
  },
};
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-80 flex-col gap-2">
      <TransitionGroup
        enter-active-class="transition duration-150 ease-out"
        enter-from-class="opacity-0 translate-y-2"
        leave-active-class="transition duration-100 ease-in"
        leave-to-class="opacity-0 translate-x-4"
      >
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="pointer-events-auto flex items-start gap-3 rounded-xl p-3 shadow-floating ring-1"
          :class="styles[toast.type].wrap"
        >
          <span
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
            :class="styles[toast.type].icon"
          >
            <AppIcon :name="styles[toast.type].name" :size="15" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-[13px] font-medium text-slate-800 dark:text-slate-100">
              {{ toast.title }}
            </p>
            <p
              v-if="toast.text"
              class="mt-0.5 break-words text-[11px] leading-snug text-slate-500 dark:text-slate-400"
            >
              {{ toast.text }}
            </p>
          </div>
          <button
            type="button"
            class="rounded p-0.5 text-slate-400 transition-colors hover:text-slate-600"
            title="Закрыть"
            @click="ui.dismissToast(toast.id)"
          >
            <AppIcon name="x" :size="13" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

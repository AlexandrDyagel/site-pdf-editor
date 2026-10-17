<script setup lang="ts">
/** Диалог подтверждения опасных действий. */
import { storeToRefs } from 'pinia';
import { useUiStore } from '@/stores/ui';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const ui = useUiStore();
const { confirmState } = storeToRefs(ui);
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="confirmState.open"
        class="fixed inset-0 z-[300] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
        @click.self="ui.resolveConfirm(false)"
      >
        <div
          class="w-full max-w-md animate-scale-in rounded-2xl bg-white p-5 shadow-floating ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800"
          role="alertdialog"
          aria-modal="true"
        >
          <div class="flex items-start gap-3">
            <span
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
              :class="
                confirmState.danger
                  ? 'bg-rose-50 text-rose-600 dark:bg-rose-500/20 dark:text-rose-300'
                  : 'bg-brand-50 text-brand-600 dark:bg-brand-500/20 dark:text-brand-300'
              "
            >
              <AppIcon :name="confirmState.danger ? 'alert' : 'info'" :size="18" />
            </span>
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {{ confirmState.title }}
              </h2>
              <p
                v-if="confirmState.text"
                class="mt-1 whitespace-pre-line text-[13px] leading-snug text-slate-500 dark:text-slate-400"
              >
                {{ confirmState.text }}
              </p>
            </div>
          </div>
          <div class="mt-5 flex justify-end gap-2">
            <AppButton variant="ghost" @click="ui.resolveConfirm(false)">
              {{ confirmState.cancelLabel }}
            </AppButton>
            <AppButton
              :variant="confirmState.danger ? 'danger' : 'primary'"
              @click="ui.resolveConfirm(true)"
            >
              {{ confirmState.confirmLabel }}
            </AppButton>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

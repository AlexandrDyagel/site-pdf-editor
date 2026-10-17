<script setup lang="ts">
/** Модальное окно с заголовком, телом и подвалом. */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    subtitle?: string;
    icon?: string;
    width?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
    closeOnBackdrop?: boolean;
    hideFooter?: boolean;
  }>(),
  { width: 'md', closeOnBackdrop: true, hideFooter: false },
);

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const panel = ref<HTMLElement | null>(null);

const widthClass = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-6xl',
  full: 'max-w-[95vw]',
} as const;

function close(): void {
  emit('update:modelValue', false);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.modelValue) {
    event.stopPropagation();
    close();
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = open ? 'hidden' : '';
  },
);

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="modelValue"
        class="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center"
        @click.self="closeOnBackdrop && close()"
      >
        <div
          ref="panel"
          class="w-full animate-scale-in rounded-2xl bg-white shadow-floating ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800"
          :class="widthClass[width]"
          role="dialog"
          aria-modal="true"
        >
          <header
            class="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-3.5 dark:border-slate-800"
          >
            <div class="flex items-start gap-3">
              <span
                v-if="icon"
                class="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-600/20 dark:text-brand-300"
              >
                <AppIcon :name="icon" :size="17" />
              </span>
              <div>
                <h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {{ title }}
                </h2>
                <p v-if="subtitle" class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {{ subtitle }}
                </p>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <slot name="header-actions" />
              <button
                type="button"
                class="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                title="Закрыть"
                @click="close"
              >
                <AppIcon name="x" :size="17" />
              </button>
            </div>
          </header>

          <div class="max-h-[70vh] overflow-y-auto px-5 py-4">
            <slot />
          </div>

          <footer
            v-if="!hideFooter"
            class="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800"
          >
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

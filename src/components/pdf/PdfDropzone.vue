<script setup lang="ts">
/** Зона загрузки PDF-файла: клик или перетаскивание. */
import { ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppSpinner from '@/components/ui/AppSpinner.vue';

const props = withDefaults(
  defineProps<{ loading?: boolean; compact?: boolean; title?: string; text?: string }>(),
  {
    loading: false,
    compact: false,
    title: 'Перетащите PDF-файл сюда',
    text: 'Файл обрабатывается локально в браузере и никуда не отправляется',
  },
);

const emit = defineEmits<{ select: [files: File[]] }>();

const input = ref<HTMLInputElement | null>(null);
const isOver = ref(false);

function openDialog(): void {
  input.value?.click();
}

function onChange(event: Event): void {
  const target = event.target as HTMLInputElement;
  const files = target.files ? Array.from(target.files) : [];
  target.value = '';
  if (files.length > 0) emit('select', files);
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  isOver.value = false;
  const files = event.dataTransfer?.files;
  if (files && files.length > 0) emit('select', Array.from(files));
}

function onDragOver(event: DragEvent): void {
  event.preventDefault();
  isOver.value = true;
}

function onDragLeave(): void {
  isOver.value = false;
}
</script>

<template>
  <div
    class="relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed text-center transition-colors"
    :class="[
      compact ? 'gap-2 px-4 py-5' : 'gap-3 px-6 py-10',
      isOver
        ? 'border-brand-400 bg-brand-50 dark:border-brand-500 dark:bg-brand-600/10'
        : 'border-slate-300 bg-white/60 hover:border-brand-300 dark:border-slate-700 dark:bg-slate-900/60',
    ]"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <span
      class="flex items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-600/20 dark:text-brand-300"
      :class="compact ? 'h-9 w-9' : 'h-12 w-12'"
    >
      <AppSpinner v-if="loading" :size="compact ? 16 : 22" />
      <AppIcon v-else name="file" :size="compact ? 18 : 24" />
    </span>

    <div>
      <p :class="compact ? 'text-[13px] font-medium' : 'text-sm font-semibold'">
        {{ title }}
      </p>
      <p class="mt-0.5 text-[11px] leading-snug text-slate-400">{{ text }}</p>
    </div>

    <AppButton :icon="compact ? undefined : 'folder'" size="sm" variant="primary" @click="openDialog">
      Выбрать файл
    </AppButton>

    <input ref="input" type="file" accept="application/pdf,.pdf" class="hidden" @change="onChange" />
  </div>
</template>

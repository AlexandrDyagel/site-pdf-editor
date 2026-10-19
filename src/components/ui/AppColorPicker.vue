<script setup lang="ts">
/** Выбор цвета: палитра, системный пипет и ручной ввод HEX. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { COLOR_PALETTE } from '@/constants';
import { isLightColor } from '@/utils/pdf';
import { startEyedropper } from '@/services/eyedropperService';
import AppIcon from '@/components/ui/AppIcon.vue';

const model = defineModel<string>({ default: '#000000' });

const props = withDefaults(
  defineProps<{
    label?: string;
    presets?: string[];
    allowNull?: boolean;
    compact?: boolean;
  }>(),
  { allowNull: false, compact: false },
);

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const swatches = computed(() => props.presets ?? COLOR_PALETTE);
const current = computed(() => model.value || '#ffffff');

function pick(color: string): void {
  model.value = color;
}

function onHexInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  let value = target.value.trim();
  if (!value.startsWith('#')) value = `#${value}`;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) model.value = value;
}

function onNativeColor(event: Event): void {
  model.value = (event.target as HTMLInputElement).value;
}

/** Пипетка: закрываем палитру и берём цвет со следующего клика по холсту. */
async function pickFromCanvas(): Promise<void> {
  open.value = false;
  const color = await startEyedropper();
  if (color) model.value = color;
}

function onDocumentClick(event: MouseEvent): void {
  if (!open.value) return;
  if (root.value && !root.value.contains(event.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener('mousedown', onDocumentClick));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentClick));
</script>

<template>
  <div ref="root" class="relative">
    <span
      v-if="label"
      class="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400"
    >
      {{ label }}
    </span>
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-left transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:hover:bg-slate-900"
      data-testid="color-trigger"
      @click="open = !open"
    >
      <span
        class="h-5 w-5 shrink-0 rounded-md ring-1 ring-inset ring-slate-900/15"
        :style="{ backgroundColor: current }"
      >
        <AppIcon
          v-if="isLightColor(current)"
          name="palette"
          :size="12"
          class="m-auto mt-1 text-slate-500"
        />
      </span>
      <span v-if="!compact" class="flex-1 truncate font-mono text-[11px] text-slate-600 dark:text-slate-300">
        {{ current.toUpperCase() }}
      </span>
      <AppIcon name="chevronDown" :size="13" class="text-slate-400" />
    </button>

    <div
      v-if="open"
      class="absolute left-0 z-50 mt-1 w-56 animate-fade-in rounded-xl border border-slate-200 bg-white p-3 shadow-floating dark:border-slate-700 dark:bg-slate-900"
    >
      <div class="grid grid-cols-8 gap-1.5">
        <button
          v-for="color in swatches"
          :key="color"
          type="button"
          class="h-5 w-5 rounded-md ring-1 ring-inset ring-slate-900/15 transition-transform hover:scale-110"
          :style="{ backgroundColor: color }"
          :title="color"
          @click="pick(color)"
        />
      </div>
      <button
        type="button"
        class="mt-3 flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-900"
        data-testid="color-eyedropper"
        @click="pickFromCanvas"
      >
        <AppIcon name="pipette" :size="13" class="text-brand-600 dark:text-brand-300" />
        Пипетка — взять цвет с холста
      </button>
      <div class="mt-2 flex items-center gap-2">
        <input
          type="color"
          :value="current"
          class="h-8 w-10 cursor-pointer rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950"
          @input="onNativeColor"
        />
        <input
          type="text"
          :value="current"
          class="h-8 flex-1 rounded-lg border border-slate-200 bg-white px-2 font-mono text-xs uppercase text-slate-700 focus:border-brand-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
          @input="onHexInput"
        />
      </div>
      <button
        v-if="allowNull"
        type="button"
        class="mt-2 w-full rounded-lg bg-slate-100 px-2 py-1.5 text-[11px] text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
        @click="model = ''"
      >
        Без цвета
      </button>
    </div>
  </div>
</template>

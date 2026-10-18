<script setup lang="ts">
/** Текстовое или числовое поле ввода с подписью и подсказкой. */
import { computed, ref } from 'vue';

const model = defineModel<string | number | null>({ default: '' });

const props = withDefaults(
  defineProps<{
    label?: string;
    type?: 'text' | 'number' | 'password' | 'search' | 'email';
    placeholder?: string;
    hint?: string;
    error?: string;
    size?: 'sm' | 'md';
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    readonly?: boolean;
    monospace?: boolean;
    suffix?: string;
  }>(),
  { type: 'text', size: 'md', disabled: false, readonly: false, monospace: false },
);

const emit = defineEmits<{ enter: []; blur: [] }>();

const sizeClass = computed(() =>
  props.size === 'sm' ? 'h-8 px-2 text-xs' : 'h-9 px-3 text-[13px]',
);

const inputClass = computed(() => [
  'w-full rounded-lg border bg-white text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-slate-50 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500',
  props.error
    ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-200 dark:border-rose-500/60 dark:focus:ring-rose-500/30'
    : 'border-slate-200 focus:border-brand-400 focus:ring-brand-100 dark:border-slate-700 dark:focus:border-brand-500 dark:focus:ring-brand-500/20',
  sizeClass.value,
  props.monospace ? 'font-mono' : '',
]);

/**
 * Пока поле в фокусе, показываем ровно то, что набрал пользователь.
 *
 * Без этого нельзя было набрать, например, «12» в поле с `min="3"`: после
 * первой цифры значение подставлялось к минимуму и получалось «3». Проверка
 * min/max теперь выполняется при потере фокуса и по Enter.
 */
const draft = ref<string | null>(null);
const displayValue = computed(() =>
  draft.value !== null ? draft.value : (model.value ?? ''),
);

/** Приводит число к допустимым границам (min/max). */
function clampNumber(value: number): number {
  let result = value;
  if (!Number.isFinite(result)) result = props.min ?? 0;
  if (props.min !== undefined) result = Math.max(props.min, result);
  if (props.max !== undefined) result = Math.min(props.max, result);
  return result;
}

function onFocus(): void {
  draft.value = String(model.value ?? '');
}

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  draft.value = target.value;
  if (props.type === 'number') {
    const parsed = target.value === '' ? null : Number(target.value);
    model.value = parsed === null || Number.isNaN(parsed) ? null : parsed;
    return;
  }
  model.value = target.value;
}

/** Завершение ввода: фиксируем окончательное (ограниченное) значение. */
function commitValue(): void {
  if (props.type === 'number') {
    const raw = draft.value !== null ? Number(draft.value) : model.value;
    const numeric = typeof raw === 'number' && Number.isFinite(raw) ? raw : (props.min ?? 0);
    model.value = clampNumber(numeric);
  } else if (draft.value !== null) {
    model.value = draft.value;
  }
  draft.value = null;
}

function onBlur(): void {
  commitValue();
  emit('blur');
}

function onEnter(): void {
  commitValue();
  emit('enter');
}
</script>

<template>
  <label class="block">
    <span
      v-if="label"
      class="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400"
    >
      {{ label }}
    </span>
    <span class="relative flex items-center">
      <input
        :type="type"
        :value="displayValue"
        :placeholder="placeholder"
        :min="min"
        :max="max"
        :step="step"
        :disabled="disabled"
        :readonly="readonly"
        :class="inputClass"
        @focus="onFocus"
        @input="onInput"
        @blur="onBlur"
        @keydown.enter="onEnter"
      />
      <span
        v-if="suffix"
        class="pointer-events-none absolute right-2.5 text-[11px] text-slate-400"
        >{{ suffix }}</span
      >
    </span>
    <span v-if="error" class="mt-1 block text-[11px] text-rose-500">{{ error }}</span>
    <span v-else-if="hint" class="mt-1 block text-[11px] text-slate-400">{{ hint }}</span>
  </label>
</template>

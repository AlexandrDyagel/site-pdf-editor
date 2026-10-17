<script setup lang="ts">
/** Выпадающий список (нативный select со стилизацией). */
import { computed } from 'vue';
import AppIcon from '@/components/ui/AppIcon.vue';

export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
  group?: string;
}

const model = defineModel<string | number | null>({ default: null });

const props = withDefaults(
  defineProps<{
    label?: string;
    options: SelectOption[];
    placeholder?: string;
    hint?: string;
    size?: 'sm' | 'md';
    disabled?: boolean;
  }>(),
  { size: 'md', disabled: false },
);

const sizeClass = computed(() =>
  props.size === 'sm' ? 'h-8 pl-2 pr-7 text-xs' : 'h-9 pl-3 pr-8 text-[13px]',
);

/** Группировка опций, если указано поле group. */
const grouped = computed(() => {
  const map = new Map<string, SelectOption[]>();
  for (const option of props.options) {
    const key = option.group ?? '';
    const list = map.get(key) ?? [];
    list.push(option);
    map.set(key, list);
  }
  return Array.from(map.entries());
});

function onChange(event: Event): void {
  const target = event.target as HTMLSelectElement;
  const raw = target.value;
  const match = props.options.find((option) => String(option.value) === raw);
  model.value = match ? match.value : raw;
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
      <select
        :value="model === null ? '' : String(model)"
        :disabled="disabled"
        class="w-full appearance-none rounded-lg border border-slate-200 bg-white text-slate-800 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-brand-500 dark:focus:ring-brand-500/20"
        :class="sizeClass"
        @change="onChange"
      >
        <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
        <template v-for="[groupName, list] in grouped" :key="groupName">
          <optgroup v-if="groupName" :label="groupName">
            <option
              v-for="option in list"
              :key="option.value"
              :value="String(option.value)"
              :disabled="option.disabled"
            >
              {{ option.label }}
            </option>
          </optgroup>
          <template v-else>
            <option
              v-for="option in list"
              :key="option.value"
              :value="String(option.value)"
              :disabled="option.disabled"
            >
              {{ option.label }}
            </option>
          </template>
        </template>
      </select>
      <AppIcon
        name="chevronDown"
        :size="14"
        class="pointer-events-none absolute right-2.5 text-slate-400"
      />
    </span>
    <span v-if="hint" class="mt-1 block text-[11px] text-slate-400">{{ hint }}</span>
  </label>
</template>

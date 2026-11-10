<script setup lang="ts">
/**
 * Настройки одной строки текста по кольцу.
 *
 * Строки независимы: у каждой свой шрифт, начертание, кегль, трекинг,
 * межсловный интервал, положение (зазор между кольцами и половина кольца) и
 * угол дуги. Компонент работает с тем же объектом `SealRingLine`, что лежит
 * в шаблоне: правки сразу видны в превью.
 */
import { computed, ref } from 'vue';
import type { SealRingLine } from '@/types';
import AppInput from '@/components/ui/AppInput.vue';
import AppSlider from '@/components/ui/AppSlider.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppButton from '@/components/ui/AppButton.vue';

const props = defineProps<{
  line: SealRingLine;
  index: number;
  /** Варианты зазоров: 0 — между 1-м и 2-м кольцом, последний — под кольцом. */
  slotOptions: { value: number; label: string }[];
  fontOptions: { value: string; label: string; group?: string }[];
  /** Строка выбрана в превью/списке. */
  active: boolean;
  /** Фактический угол с учётом растяжения/сжатия, градусы. */
  effectiveSpan: number;
}>();

const emit = defineEmits<{
  select: [];
  delete: [];
}>();

const root = ref<HTMLElement | null>(null);

/** Фокус в поле текста с кареткой в конце (двойной клик по превью). */
function focusText(): void {
  const input = root.value?.querySelector<HTMLInputElement>(
    `[data-testid="seal-line-${props.index}-text"] input`,
  );
  if (!input) return;
  input.focus();
  const end = input.value.length;
  try {
    input.setSelectionRange(end, end);
  } catch {
    /* не все типы input поддерживают выделение */
  }
}

function scrollIntoView(): void {
  root.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

defineExpose({ focusText, scrollIntoView });

const spanHint = computed(() => {
  if (props.line.spanAngle <= 1.001) {
    return `1° — по ширине текста (фактически ${Math.round(props.effectiveSpan)}°)`;
  }
  return `Фактически ${Math.round(props.effectiveSpan)}°`;
});
</script>

<template>
  <div
    ref="root"
    class="space-y-2 rounded-xl border p-3 transition-colors"
    :class="
      props.active
        ? 'border-brand-400 bg-brand-50/40 dark:border-brand-500/60 dark:bg-brand-500/5'
        : 'border-slate-200 dark:border-slate-700'
    "
    :data-testid="`seal-line-${props.index}`"
    @pointerdown="emit('select')"
  >
    <div class="flex items-center justify-between gap-2">
      <p class="text-[13px] font-medium text-slate-700 dark:text-slate-200">
        Строка {{ props.index + 1 }}
      </p>
      <div class="flex items-center gap-1">
        <AppButton
          size="xs"
          variant="ghost"
          icon="trash"
          title="Удалить строку"
          :data-testid="`seal-line-${props.index}-delete`"
          @click.stop="emit('delete')"
        />
      </div>
    </div>

    <AppInput
      :model-value="props.line.text"
      label="Текст"
      size="sm"
      placeholder="Текст по кольцу"
      :data-testid="`seal-line-${props.index}-text`"
      @update:model-value="props.line.text = String($event ?? '')"
    />

    <div class="grid grid-cols-2 gap-2">
      <AppSelect
        :model-value="String(props.line.slot)"
        label="Где"
        size="sm"
        :options="props.slotOptions.map((item) => ({ value: String(item.value), label: item.label }))"
        :data-testid="`seal-line-${props.index}-slot`"
        @update:model-value="props.line.slot = Number($event)"
      />
      <AppSelect
        :model-value="props.line.side"
        label="Половина"
        size="sm"
        :options="[
          { value: 'top', label: 'Верх' },
          { value: 'bottom', label: 'Низ' },
        ]"
        :data-testid="`seal-line-${props.index}-side`"
        @update:model-value="props.line.side = $event === 'bottom' ? 'bottom' : 'top'"
      />
    </div>

    <div class="grid grid-cols-2 gap-2">
      <AppSelect
        :model-value="props.line.fontId ?? ''"
        label="Шрифт"
        size="sm"
        :options="[{ value: '', label: 'Как у печати' }, ...props.fontOptions]"
        @update:model-value="props.line.fontId = String($event || '') || undefined"
      />
      <div class="flex items-end gap-1.5">
        <AppButton
          size="sm"
          :variant="props.line.bold ? 'primary' : 'subtle'"
          block
          title="Полужирный (B)"
          @click.stop="props.line.bold = !props.line.bold"
        >
          <span class="text-[15px] font-semibold leading-none">B</span>
        </AppButton>
        <AppButton
          size="sm"
          :variant="props.line.italic ? 'primary' : 'subtle'"
          icon="italic"
          block
          title="Курсив"
          @click.stop="props.line.italic = !props.line.italic"
        />
        <AppButton
          size="sm"
          :variant="props.line.underline ? 'primary' : 'subtle'"
          icon="underline"
          block
          title="Подчёркнутый"
          data-testid="seal-line-underline"
          @click.stop="props.line.underline = !props.line.underline"
        />
        <AppButton
          size="sm"
          variant="subtle"
          icon="alignCenter"
          block
          title="Центрировать между кольцами"
          data-testid="seal-line-align-gap"
          @click.stop="props.line.radiusOffset = 0"
        />
      </div>
    </div>

    <AppSlider
      :model-value="props.line.fontSize"
      label="Кегль"
      unit="pt"
      :min="3"
      :max="26"
      :step="0.5"
      :precision="1"
      :data-testid="`seal-line-${props.index}-size`"
      @update:model-value="props.line.fontSize = Number($event)"
    />

    <div class="grid grid-cols-2 gap-2">
      <AppSlider
        :model-value="props.line.letterSpacing"
        label="Между буквами"
        unit="pt"
        :min="-2"
        :max="20"
        :step="0.2"
        :precision="1"
        :data-testid="`seal-line-${props.index}-tracking`"
        @update:model-value="props.line.letterSpacing = Number($event); props.line.spanAngle = 1"
      />
      <AppSlider
        :model-value="props.line.wordSpacing"
        label="Между словами"
        unit="pt"
        :min="0"
        :max="30"
        :step="0.5"
        :precision="1"
        :data-testid="`seal-line-${props.index}-word`"
        @update:model-value="props.line.wordSpacing = Number($event); props.line.spanAngle = 1"
      />
    </div>

    <AppSlider
      :model-value="props.effectiveSpan"
      label="Угол дуги"
      unit="°"
      :min="1"
      :max="400"
      :step="1"
      :data-testid="`seal-line-${props.index}-span`"
      @update:model-value="props.line.spanAngle = Number($event)"
    />
    <p class="-mt-1 text-[11px] text-slate-400">{{ spanHint }}. Дугу можно тянуть за маркеры на превью.</p>

    <AppSlider
      :model-value="props.line.radiusOffset"
      label="Смещение от центра зазора"
      unit="pt"
      :min="-20"
      :max="20"
      :step="0.5"
      :precision="1"
      :data-testid="`seal-line-${props.index}-offset`"
      @update:model-value="props.line.radiusOffset = Number($event)"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * Настройки одной дуги печати (верхней или нижней).
 *
 * Вынесено в отдельный компонент: верхняя и нижняя дуги настраиваются
 * одинаково, и дублировать полсотни полей в конструкторе не хочется.
 *
 * Компонент работает с тем же объектом `SealArcText`, что лежит в шаблоне
 * печати: изменения сразу видны в превью (родитель — глубоко реактивный ref).
 */
import type { SealArcText } from '@/types';
import AppInput from '@/components/ui/AppInput.vue';
import AppSlider from '@/components/ui/AppSlider.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppToggle from '@/components/ui/AppToggle.vue';
import AppButton from '@/components/ui/AppButton.vue';

const props = defineProps<{
  arc: SealArcText;
  title: string;
  /** Сторона печати — нужна для test-id и подсказок. */
  side: 'top' | 'bottom';
  /** Подсказка под заголовком. */
  hint?: string;
  /** Варианты шрифтов. */
  fontOptions: { value: string; label: string; group?: string }[];
  /** Максимальный радиус дуги, px (половина печати). */
  maxRadius: number;
}>();
</script>

<template>
  <div class="space-y-2.5 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="text-[13px] font-medium text-slate-700 dark:text-slate-200">{{ props.title }}</p>
        <p v-if="props.hint" class="text-[11px] text-slate-400">{{ props.hint }}</p>
      </div>
      <AppToggle v-model="props.arc.enabled" />
    </div>

    <template v-if="props.arc.enabled">
      <AppInput
        v-model="props.arc.text"
        label="Текст"
        size="sm"
        placeholder="Текст по дуге"
        :data-testid="`seal-arc-${props.side}-text`"
      />

      <div class="grid grid-cols-2 gap-2">
        <AppSelect
          :model-value="props.arc.fontId ?? ''"
          label="Шрифт"
          size="sm"
          :options="[{ value: '', label: 'Как у печати' }, ...props.fontOptions]"
          @update:model-value="props.arc.fontId = String($event || '') || undefined"
        />
        <div class="flex items-end gap-1.5">
          <AppButton
            size="sm"
            :variant="props.arc.bold ? 'primary' : 'subtle'"
            icon="bold"
            block
            @click="props.arc.bold = !props.arc.bold"
          >
            Ж
          </AppButton>
          <AppButton
            size="sm"
            :variant="props.arc.italic ? 'primary' : 'subtle'"
            icon="italic"
            block
            @click="props.arc.italic = !props.arc.italic"
          >
            К
          </AppButton>
        </div>
      </div>

      <AppSlider
        :model-value="props.arc.fontSize"
        label="Размер шрифта"
        unit="px"
        :min="4"
        :max="26"
        :step="0.5"
        :precision="1"
        :data-testid="`seal-arc-${props.side}-size`"
        @update:model-value="props.arc.fontSize = Number($event)"
      />

      <div class="grid grid-cols-2 gap-2">
        <AppSlider
          :model-value="props.arc.letterSpacing"
          label="Между буквами"
          unit="px"
          :min="-2"
          :max="20"
          :step="0.2"
          :precision="1"
          @update:model-value="props.arc.letterSpacing = Number($event)"
        />
        <AppSlider
          :model-value="props.arc.wordSpacing"
          label="Между словами"
          unit="px"
          :min="0"
          :max="30"
          :step="0.5"
          :precision="1"
          @update:model-value="props.arc.wordSpacing = Number($event)"
        />
      </div>

      <AppSlider
        :model-value="props.arc.spanAngle"
        label="Угол дуги (0 — по тексту)"
        unit="°"
        :min="0"
        :max="340"
        :step="1"
        @update:model-value="props.arc.spanAngle = Number($event)"
      />
      <p class="-mt-1 text-[11px] text-slate-400">
        Дугу можно растянуть и мышью — за маркеры на превью.
      </p>

      <div class="grid grid-cols-2 gap-2">
        <AppInput
          :model-value="props.arc.radius"
          label="Радиус, px (0 — авто)"
          type="number"
          size="sm"
          :min="0"
          :max="Math.round(props.maxRadius)"
          @update:model-value="props.arc.radius = Math.max(0, Number($event) || 0)"
        />
        <AppInput
          :model-value="props.arc.gap"
          label="Отступ от кольца"
          type="number"
          size="sm"
          :min="0"
          :max="40"
          @update:model-value="props.arc.gap = Math.max(0, Number($event) || 0)"
        />
      </div>
    </template>
  </div>
</template>

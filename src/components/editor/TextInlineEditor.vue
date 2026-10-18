<script setup lang="ts">
/**
 * ============================================================================
 *  Редактирование текста прямо на холсте.
 * ============================================================================
 *
 *  Поверх выделенного текстового объекта показывается прозрачное поле ввода:
 *  браузер сам рисует мигающую каретку, выделение и обрабатывает ввод. Объект
 *  в это время скрыт (`useObjectRenderer`), поэтому текст виден ровно так, как
 *  его набирают, а рамка объекта растёт по мере набора.
 */

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useEditorStore } from '@/stores/editor';
import { useObjectsStore } from '@/stores/objects';
import type { TextPayload } from '@/types';
import { computeTextBlockLayout } from '@/services/textRenderService';

const editor = useEditorStore();
const objects = useObjectsStore();

const field = ref<HTMLTextAreaElement | null>(null);
/** Один шаг истории на всю правку, а не на каждый символ. */
let editActive = false;

const object = computed(() => {
  const id = editor.editingTextId;
  if (!id) return null;
  const found = objects.byId(id);
  return found && found.type === 'text' ? found : null;
});

const payload = computed(() => (object.value?.payload as TextPayload | undefined) ?? null);

/** Положение и размеры поля в пикселях рабочей области. */
const box = computed(() => {
  const obj = object.value;
  if (!obj) return null;
  const zoom = editor.zoom;
  const padding = Math.max(0, payload.value?.padding ?? 0) * zoom;
  return {
    left: editor.pan.x + obj.x * zoom,
    top: editor.pan.y + obj.y * zoom,
    width: Math.max(14, obj.width * zoom),
    height: Math.max(14, obj.height * zoom),
    fontSize: Math.max(6, (payload.value?.fontSize ?? 12) * zoom),
    lineHeight: String(payload.value?.lineHeight ?? 1.25),
    letterSpacing: `${(payload.value?.letterSpacing ?? 0) * zoom}px`,
    padding: `${padding}px`,
  };
});

const style = computed(() => {
  const data = payload.value;
  if (!data || !box.value) return {};
  return {
    left: `${box.value.left}px`,
    top: `${box.value.top}px`,
    width: `${box.value.width}px`,
    height: `${box.value.height}px`,
    fontFamily: data.fontFamily || 'sans-serif',
    fontSize: `${box.value.fontSize}px`,
    lineHeight: box.value.lineHeight,
    letterSpacing: box.value.letterSpacing,
    fontWeight: data.bold ? '700' : '400',
    fontStyle: data.italic ? 'italic' : 'normal',
    textDecoration: data.underline ? 'underline' : 'none',
    textAlign: data.align === 'justify' ? 'left' : data.align,
    color: data.color,
    padding: box.value.padding,
    caretColor: '#355ef0',
    background: 'transparent',
  };
});

/** Применяет каретку из запроса (место клика) или ставит её в конец. */
async function focusField(): Promise<void> {
  await nextTick();
  const element = field.value;
  const data = payload.value;
  if (!element || !data) return;
  const requested = editor.textCaretOffset;
  const caret = requested === null ? data.text.length : Math.min(requested, data.text.length);
  element.focus({ preventScroll: true });
  const start = Math.max(0, Math.min(data.text.length, requested === null ? data.text.length : caret));
  element.setSelectionRange(start, start);
  editor.textCaretOffset = null;
}

watch(
  () => object.value?.id ?? null,
  (id) => {
    editActive = false;
    if (id) void focusField();
  },
  { immediate: true },
);

/** Ввод: текст и рамка растут по содержимому. */
function onInput(): void {
  const obj = object.value;
  const element = field.value;
  const data = payload.value;
  if (!obj || !element || !data) return;
  if (!editActive) {
    objects.commit('Изменение текста');
    editActive = true;
  }

  const text = element.value;
  const next: TextPayload = { ...data, text };
  // Раскладку считаем «без переноса» (широкая рамка): так получаем
  // естественную ширину текста, по которой и растёт область.
  const natural = computeTextBlockLayout(next, 100000, Math.max(4, obj.height));
  const padding = Math.max(0, next.padding) * 2;
  // Рамка только растёт: так текст не «прыгает» при удалении символов.
  const width = Math.max(obj.width, natural.contentWidth + padding + 1);
  const height = Math.max(next.fontSize * 1.2, natural.boxHeight);
  objects.patchSilent(obj.id, { payload: { text }, width, height });
}

function finish(): void {
  if (!editor.editingTextId) return;
  editActive = false;
  editor.stopTextEditing();
}

/**
 * Потеря фокуса.
 *
 * Браузер переводит фокус на холст сразу после клика, которым мы открыли
 * редактирование, — это не повод закрывать ввод, иначе каретка пропадала.
 * Завершаем только при осознанном переходе в другое поле интерфейса.
 */
function onBlur(event: FocusEvent): void {
  const next = event.relatedTarget as HTMLElement | null;
  const inField = Boolean(
    next && (next.tagName === 'INPUT' || next.tagName === 'TEXTAREA' || next.isContentEditable),
  );
  if (inField) {
    finish();
    return;
  }
  // Возвращаем фокус обратно, чтобы можно было продолжать печатать.
  window.setTimeout(() => {
    if (editor.editingTextId) field.value?.focus({ preventScroll: true });
  }, 0);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    finish();
    return;
  }
  // Enter — перевод строки; остальные клавиши не должны доходить до холста.
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    finish();
    return;
  }
  event.stopPropagation();
}

onBeforeUnmount(() => {
  editActive = false;
});
</script>

<template>
  <textarea
    v-if="object && payload && box"
    ref="field"
    :value="payload.text"
    class="text-inline-editor absolute z-20 resize-none overflow-hidden border-0 bg-transparent outline-none"
    :style="style"
    data-testid="text-inline-editor"
    spellcheck="false"
    autocomplete="off"
    @input="onInput"
    @blur="onBlur"
    @keydown="onKeydown"
    @pointerdown.stop
    @click.stop
    @dblclick.stop
  />
</template>

<style scoped>
.text-inline-editor {
  /* Тонкая подсветка активной области, чтобы было видно, что идёт ввод. */
  box-shadow: 0 0 0 1px rgb(53 94 240 / 55%);
  border-radius: 2px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

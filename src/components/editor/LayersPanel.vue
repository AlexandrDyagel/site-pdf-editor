<script setup lang="ts">
/** Панель слоёв: список объектов текущей страницы. */
import { computed } from 'vue';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useUiStore } from '@/stores/ui';
import { usePdfStore } from '@/stores/pdf';
import AppButton from '@/components/ui/AppButton.vue';
import AppEmptyState from '@/components/ui/AppEmptyState.vue';
import AppTooltip from '@/components/ui/AppTooltip.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const objects = useObjectsStore();
const editor = useEditorStore();
const ui = useUiStore();
const pdf = usePdfStore();

/** Объекты страницы: сверху — самые «верхние» слои. */
const layers = computed(() => objects.forPage(editor.currentPage).slice().reverse());

const typeIcons: Record<string, string> = {
  text: 'type',
  image: 'image',
  shape: 'square',
  drawing: 'brush',
  signature: 'signature',
  stamp: 'stamp',
  whiteout: 'whiteout',
  highlight: 'highlight',
};

const typeNames: Record<string, string> = {
  text: 'Текст',
  image: 'Изображение',
  shape: 'Фигура',
  drawing: 'Рисунок',
  signature: 'Подпись',
  stamp: 'Штамп',
  whiteout: 'Закрашивание',
  highlight: 'Выделение',
};

function label(objectId: string): string {
  const obj = objects.byId(objectId);
  if (!obj) return '';
  if (obj.name) return obj.name;
  if (obj.type === 'text') {
    const text = (obj.payload as { text?: string }).text ?? '';
    return text.slice(0, 40) || 'Текст';
  }
  return typeNames[obj.type] ?? obj.type;
}

async function removeSelected(objectId: string): Promise<void> {
  const confirmed = await ui.askConfirm({
    title: 'Удалить объект?',
    text: label(objectId),
    confirmLabel: 'Удалить',
    danger: true,
  });
  if (confirmed) objects.remove([objectId]);
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Слои страницы {{ editor.currentPage + 1 }}
      </span>
      <span class="font-mono text-[11px] text-slate-400">{{ layers.length }}</span>
    </div>

    <div v-if="layers.length === 0" class="flex-1">
      <AppEmptyState
        compact
        icon="layers"
        title="Слоёв пока нет"
        text="Добавьте текст, фигуру, подпись или штамп — объект появится в списке."
      >
        <AppButton size="sm" icon="book" @click="ui.setLeftTab('library')">
          Открыть библиотеку
        </AppButton>
      </AppEmptyState>
    </div>

    <div v-else class="flex-1 overflow-y-auto">
      <div
        v-for="layer in layers"
        :key="layer.id"
        class="group flex items-center gap-1.5 border-b border-slate-100 px-2 py-1.5 transition-colors dark:border-slate-800/60"
        :class="
          objects.selectedIds.includes(layer.id)
            ? 'bg-brand-50 dark:bg-brand-600/15'
            : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
        "
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          @click="objects.selectOne(layer.id, $event.shiftKey)"
          @dblclick="
            objects.select([layer.id]);
            layer.type === 'text' ? (editor.editingTextId = layer.id) : undefined;
            ui.setRightTab('properties');
          "
        >
          <span class="text-slate-400">
            <AppIcon :name="typeIcons[layer.type] ?? 'square'" :size="15" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[12px] text-slate-700 dark:text-slate-200">
              {{ label(layer.id) }}
            </span>
            <span class="block truncate text-[10px] text-slate-400">
              z={{ layer.zIndex }} · {{ Math.round(layer.width) }}×{{ Math.round(layer.height) }} pt
              <template v-if="layer.groupId"> · группа</template>
            </span>
          </span>
        </button>

        <div class="flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          <AppTooltip :text="layer.visible ? 'Скрыть' : 'Показать'">
            <AppButton
              :icon="layer.visible ? 'eye' : 'eyeOff'"
              size="xs"
              variant="ghost"
              @click="objects.setVisible([layer.id], !layer.visible)"
            />
          </AppTooltip>
          <AppTooltip :text="layer.locked ? 'Разблокировать' : 'Заблокировать'">
            <AppButton
              :icon="layer.locked ? 'lock' : 'unlock'"
              size="xs"
              variant="ghost"
              @click="objects.setLocked([layer.id], !layer.locked)"
            />
          </AppTooltip>
          <AppTooltip text="Удалить">
            <AppButton
              icon="trash"
              size="xs"
              variant="ghost"
              @click="removeSelected(layer.id)"
            />
          </AppTooltip>
        </div>
      </div>
    </div>

    <div
      v-if="layers.length > 0"
      class="flex items-center gap-1 border-t border-slate-200 px-2 py-1.5 dark:border-slate-800"
    >
      <AppTooltip text="Поднять выделенные">
        <AppButton
          icon="moveUp"
          size="sm"
          variant="ghost"
          :disabled="!objects.hasSelection"
          @click="objects.bringForward()"
        />
      </AppTooltip>
      <AppTooltip text="Опустить выделенные">
        <AppButton
          icon="moveDown"
          size="sm"
          variant="ghost"
          :disabled="!objects.hasSelection"
          @click="objects.sendBackward()"
        />
      </AppTooltip>
      <div class="flex-1" />
      <AppButton
        size="sm"
        variant="ghost"
        icon="trash"
        :disabled="!objects.hasSelection"
        @click="objects.remove(objects.selectedIds)"
      >
        Удалить
      </AppButton>
    </div>

    <div
      v-if="pdf.isLoaded"
      class="border-t border-slate-200 px-3 py-2 text-[10px] text-slate-400 dark:border-slate-800"
    >
      Всего объектов в документе: {{ objects.objects.length }}
    </div>
  </div>
</template>

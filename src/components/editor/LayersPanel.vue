<script setup lang="ts">
/** Панель слоёв: список объектов текущей страницы. */
import { computed } from 'vue';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useUiStore } from '@/stores/ui';
import { usePdfStore } from '@/stores/pdf';
import { layerAccentColor, layerBaseName, layerDetail, layerLabels } from '@/utils/layers';
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

/**
 * Подписи слоёв: название инструмента + номер для одинаковых («Эллипс 1»,
 * «Прямоугольник 2»). Нумеруем снизу вверх, поэтому новые объекты сверху
 * не сбивают номера у уже существующих.
 */
const labels = computed(() => layerLabels(objects.forPage(editor.currentPage)));

function label(objectId: string): string {
  const obj = objects.byId(objectId);
  if (!obj) return '';
  return labels.value.get(objectId) ?? layerBaseName(obj);
}

/** Подсказка строки: название + содержимое (текст, название штампа). */
function hint(objectId: string): string {
  const obj = objects.byId(objectId);
  if (!obj) return '';
  const detail = layerDetail(obj);
  const base = label(objectId);
  return detail ? `${base} · ${detail}` : base;
}

/** Цвет индикатора слоя. */
function accent(objectId: string): string | null {
  const obj = objects.byId(objectId);
  return obj ? layerAccentColor(obj) : null;
}

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

async function removeSelected(objectId: string): Promise<void> {
  const confirmed = await ui.askConfirm({
    title: 'Удалить объект?',
    text: label(objectId),
    confirmLabel: 'Удалить',
    danger: true,
  });
  if (confirmed) objects.remove([objectId]);
}

/**
 * Сдвиг слоя на одну позицию.
 *
 * Кнопки всегда активны: если слой уже на самом верху или в самом низу,
 * пользователь получает понятное сообщение, а не «мёртвую» кнопку без
 * подсказки (у отключённых кнопок подсказка не показывается и клик не
 * срабатывает — именно это выглядело как «не работает»).
 */
function moveLayer(objectId: string, direction: 1 | -1, index: number): void {
  if (direction > 0 && index === 0) {
    ui.notify.info('Слой уже наверху', 'Выше на этой странице слоёв нет.');
    return;
  }
  if (direction < 0 && index === layers.value.length - 1) {
    ui.notify.info('Слой уже внизу', 'Ниже на этой странице слоёв нет.');
    return;
  }
  if (direction > 0) objects.bringForward([objectId]);
  else objects.sendBackward([objectId]);
}

/** Сдвиг выделенных слоёв (кнопки внизу панели). */
function moveSelected(direction: 1 | -1): void {
  if (!objects.hasSelection) {
    ui.notify.info('Слой не выбран', 'Нажмите на строку слоя — или на объект на странице.');
    return;
  }
  if (direction > 0) objects.bringForward();
  else objects.sendBackward();
}

/** Перенос выделенных на самый верх / в самый низ. */
function moveSelectedToEdge(edge: 'front' | 'back'): void {
  if (!objects.hasSelection) {
    ui.notify.info('Слой не выбран', 'Нажмите на строку слоя — или на объект на странице.');
    return;
  }
  if (edge === 'front') objects.bringToFront();
  else objects.sendToBack();
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
        v-for="(layer, index) in layers"
        :key="layer.id"
        :data-layer-id="layer.id"
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
          :title="hint(layer.id)"
          @click="objects.selectOne(layer.id, $event.shiftKey)"
          @dblclick="
            objects.select([layer.id]);
            layer.type === 'text' ? (editor.editingTextId = layer.id) : undefined;
            ui.setRightTab('properties');
          "
        >
          <!-- Индикатор основного цвета: заливка фигуры, цвет текста и т. п. -->
          <span
            v-if="accent(layer.id)"
            class="flex h-[15px] w-[15px] shrink-0 items-center justify-center"
            :title="accent(layer.id) ?? ''"
          >
            <span
              data-layer-color
              class="block h-3 w-3 rounded-full ring-1 ring-slate-300 dark:ring-slate-600"
              :style="{ backgroundColor: accent(layer.id) ?? 'transparent' }"
            />
          </span>
          <span v-else class="text-slate-400">
            <AppIcon :name="typeIcons[layer.type] ?? 'square'" :size="15" />
          </span>
          <span class="min-w-0 flex-1">
            <span
              data-layer-label
              class="block truncate text-[12px] text-slate-700 dark:text-slate-200"
            >
              {{ label(layer.id) }}
            </span>
            <span class="block truncate text-[10px] text-slate-400">
              z={{ layer.zIndex }} · {{ Math.round(layer.width) }}×{{ Math.round(layer.height) }} pt
              <template v-if="layer.groupId"> · группа</template>
            </span>
          </span>
        </button>

        <div class="flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          <!-- Порядок слоя: сразу из списка, без выделения объекта -->
          <AppTooltip text="Выше (ближе к зрителю)">
            <AppButton
              icon="moveUp"
              size="xs"
              variant="ghost"
              title="Выше"
              :class="{ 'opacity-40': index === 0 }"
              @click="moveLayer(layer.id, 1, index)"
            />
          </AppTooltip>
          <AppTooltip text="Ниже (дальше от зрителя)">
            <AppButton
              icon="moveDown"
              size="xs"
              variant="ghost"
              title="Ниже"
              :class="{ 'opacity-40': index === layers.length - 1 }"
              @click="moveLayer(layer.id, -1, index)"
            />
          </AppTooltip>
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
      <AppTooltip text="Поверх всех выделенных" shortcut="]">
        <AppButton
          icon="front"
          size="sm"
          variant="ghost"
          title="Поверх всех"
          @click="moveSelectedToEdge('front')"
        />
      </AppTooltip>
      <AppTooltip text="Поднять выделенные">
        <AppButton
          icon="moveUp"
          size="sm"
          variant="ghost"
          title="Поднять"
          @click="moveSelected(1)"
        />
      </AppTooltip>
      <AppTooltip text="Опустить выделенные">
        <AppButton
          icon="moveDown"
          size="sm"
          variant="ghost"
          title="Опустить"
          @click="moveSelected(-1)"
        />
      </AppTooltip>
      <AppTooltip text="Позади всех выделенных" shortcut="[">
        <AppButton
          icon="back"
          size="sm"
          variant="ghost"
          title="Позади всех"
          @click="moveSelectedToEdge('back')"
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

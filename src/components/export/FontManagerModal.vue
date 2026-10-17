<script setup lang="ts">
/** Управление шрифтами: встроенные и пользовательские TTF/OTF. */
import { computed, ref } from 'vue';
import { useFontsStore } from '@/stores/fonts';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';
import { formatBytes } from '@/utils/download';
import { ACCEPT, openFileDialog } from '@/services/fileService';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSection from '@/components/ui/AppSection.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppSpinner from '@/components/ui/AppSpinner.vue';

const fonts = useFontsStore();
const settings = useSettingsStore();
const ui = useUiStore();

const testText = ref('Съешь ещё этих мягких французских булок, да выпей чаю. Ёжик, Ёлка, №12');
const coverage = ref<{ fontId: string; missing: string[] } | null>(null);
const checking = ref(false);

const isOpen = computed({
  get: () => ui.modals.fonts,
  set: (value: boolean) => (value ? ui.openModal('fonts') : ui.closeModal('fonts')),
});

async function upload(): Promise<void> {
  const files = await openFileDialog({ accept: ACCEPT.fonts, multiple: true });
  if (files.length === 0) return;

  // Один и тот же шрифт может прийти несколькими файлами (обычный, жирный,
  // курсив, жирный курсив) — сообщаем о нём один раз, перечисляя начертания.
  const touched = new Map<string, { name: string; faces: string[]; cyrillic: boolean }>();
  for (const file of files) {
    try {
      const asset = await fonts.uploadFont(file);
      touched.set(asset.id, {
        name: asset.name,
        faces: fonts.faceLabels(asset.id),
        cyrillic: asset.supportsCyrillic,
      });
    } catch (error) {
      ui.notify.error(
        `Не удалось загрузить «${file.name}»`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  for (const entry of touched.values()) {
    ui.notify.success(
      `Шрифт «${entry.name}» готов`,
      entry.faces.length > 0 ? `Начертания: ${entry.faces.join(', ')}` : 'Добавлен в список шрифтов',
    );
    if (!entry.cyrillic) {
      ui.notify.warning(
        'В шрифте нет кириллицы',
        'Русский текст этим шрифтом будет отображаться заглушками. Загрузите шрифт с поддержкой кириллицы.',
      );
    }
  }
}

async function remove(id: string, name: string): Promise<void> {
  const confirmed = await ui.askConfirm({
    title: 'Удалить шрифт?',
    text: `Шрифт «${name}» будет удалён из браузера. Объекты, которые его используют, останутся, но при экспорте будет подобран другой шрифт.`,
    confirmLabel: 'Удалить',
    danger: true,
  });
  if (!confirmed) return;
  await fonts.removeFont(id);
  ui.notify.info('Шрифт удалён', name);
}

/** Проверка покрытия глифов для тестовой строки. */
async function check(fontId: string): Promise<void> {
  checking.value = true;
  try {
    const result = await fonts.checkCoverage(fontId, testText.value);
    coverage.value = { fontId, missing: result.missing };
  } finally {
    checking.value = false;
  }
}

function setDefault(fontId: string): void {
  settings.update({ defaultFontId: fontId });
  ui.notify.success('Шрифт по умолчанию изменён', fonts.familyOf(fontId));
}

function vk(id: string): string {
  const asset = fonts.byId(id);
  return asset?.source === 'user' ? 'Пользовательский' : 'Встроенный';
}
</script>

<template>
  <AppModal
    v-model="isOpen"
    title="Шрифты"
    subtitle="Кириллица в PDF встраивается вместе с документом — «кракозябр» не будет"
    icon="font"
    width="lg"
  >
    <div class="space-y-4">
      <AppSection title="Проверка кириллицы" icon="check">
        <AppInput v-model="testText" label="Тестовый текст" size="sm" />
        <p class="text-[11px] leading-snug text-slate-400">
          Наберите текст и нажмите «Проверить» у нужного шрифта — приложение покажет символы,
          которых в шрифте нет.
        </p>
      </AppSection>

      <AppSection title="Доступные шрифты" icon="book">
        <div v-if="fonts.isLoading" class="flex items-center gap-2 py-2">
          <AppSpinner :size="16" label="Загрузка шрифтов…" />
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="font in fonts.fonts"
            :key="font.id"
            class="rounded-xl border border-slate-200 p-2.5 dark:border-slate-700"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="flex items-center gap-1.5 text-[13px] font-medium text-slate-800 dark:text-slate-100">
                  {{ font.name }}
                  <span
                    v-if="font.supportsCyrillic"
                    class="rounded bg-emerald-100 px-1 text-[10px] text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                  >
                    кириллица
                  </span>
                  <span
                    v-else
                    class="rounded bg-rose-100 px-1 text-[10px] text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
                  >
                    нет кириллицы
                  </span>
                </p>
                <p class="mt-0.5 text-[11px] text-slate-400">
                  {{ vk(font.id) }} · начертаний: {{ Object.keys(font.faces).length }}
                  <template v-if="fonts.faceLabels(font.id).length">
                    ({{ fonts.faceLabels(font.id).join(', ') }})
                  </template>
                  <template v-if="font.size"> · {{ formatBytes(font.size) }}</template>
                  <template v-if="font.license"> · {{ font.license }}</template>
                  <template v-if="font.subsetSafe === false">
                    · встраивается в PDF целиком
                  </template>
                  <template v-else-if="font.source === 'user'">
                    · встраивается подмножеством (файл компактный)
                  </template>
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <AppButton
                  size="xs"
                  variant="ghost"
                  icon="check"
                  :loading="checking && coverage?.fontId === font.id"
                  @click="check(font.id)"
                >
                  Проверить
                </AppButton>
                <AppButton
                  size="xs"
                  :variant="settings.settings.defaultFontId === font.id ? 'primary' : 'subtle'"
                  @click="setDefault(font.id)"
                >
                  {{ settings.settings.defaultFontId === font.id ? 'По умолчанию' : 'Сделать основным' }}
                </AppButton>
                <AppButton
                  v-if="font.source === 'user'"
                  size="xs"
                  variant="ghost"
                  icon="trash"
                  @click="remove(font.id, font.name)"
                />
              </div>
            </div>
            <p
              :style="{ fontFamily: `'${font.family}'` }"
              class="mt-1.5 truncate text-[15px] text-slate-700 dark:text-slate-200"
            >
              {{ testText }}
            </p>
            <p
              v-if="coverage?.fontId === font.id"
              class="mt-1 text-[11px]"
              :class="coverage.missing.length === 0 ? 'text-emerald-600' : 'text-rose-500'"
            >
              {{
                coverage.missing.length === 0
                  ? 'Все символы тестовой строки поддерживаются.'
                  : `Нет символов: ${coverage.missing.join(' ')}`
              }}
            </p>
          </div>
        </div>
      </AppSection>

      <AppSection title="Свой шрифт" icon="upload">
        <AppButton icon="upload" block :loading="fonts.isUploading" @click="upload">
          Загрузить TTF или OTF
        </AppButton>
        <div class="space-y-2 text-[11px] leading-snug text-slate-400">
          <p>
            Шрифт сохраняется в браузере (IndexedDB) и используется как для предпросмотра, так и
            для встраивания в PDF. Файлы не покидают ваше устройство.
          </p>
          <p>
            Можно выбрать сразу несколько файлов: обычный, жирный, курсив и жирный курсив с
            одинаковым названием семейства объединятся в один шрифт, и редактор будет
            подставлять нужное начертание сам.
          </p>
          <p>
            Сразу после загрузки приложение проверяет, можно ли встраивать шрифт подмножеством
            (это уменьшает PDF в десятки раз): делает два пробных документа и сравнивает
            отрисовку. Если подмножество искажает глифы, шрифт встраивается целиком.
          </p>
          <p>
            Где взять файлы: Windows —
            <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">C:\Windows\Fonts</code>
            (Times New Roman: <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">times.ttf</code>,
            <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">timesbd.ttf</code>,
            <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">timesi.ttf</code>,
            <code class="rounded bg-slate-100 px-1 dark:bg-slate-800">timesbi.ttf</code>);
            macOS — «Шрифты» в Font Book (ПКМ → «Показать в Finder»).
          </p>
          <p>
            Как встраивается шрифт, видно в списке выше: «подмножеством» — файл компактный,
            «целиком» — надёжнее для шрифтов, которые подмножество искажает. Убедитесь, что у
            вас есть право использовать этот шрифт в документах; если нужен свободный аналог
            Times New Roman, подойдёт Liberation Serif или Tinos.
          </p>
        </div>
      </AppSection>

      <div class="flex items-start gap-2 rounded-xl bg-brand-50 p-3 text-[11px] leading-snug text-brand-800 dark:bg-brand-600/15 dark:text-brand-200">
        <AppIcon name="info" :size="15" class="mt-0.5" />
        <div class="space-y-1">
          <p>
            Стандартные шрифты PDF (Helvetica, Times) не содержат кириллицы в кодировке WinAnsi,
            поэтому приложение всегда встраивает TTF-шрифты с поддержкой Unicode — русский текст
            в готовом PDF остаётся корректным.
          </p>
          <p>
            Часть шрифтов (Inter, Noto Sans, PT Mono) встраивается целиком: подмножества таких
            шрифтов повреждают глифы. Файл получается немного больше, зато текст гарантированно
            отображается правильно. Для пользовательских шрифтов это проверяется автоматически
            при загрузке.
          </p>
        </div>
      </div>
    </div>

    <template #footer>
      <AppButton variant="primary" @click="ui.closeModal('fonts')">Готово</AppButton>
    </template>
  </AppModal>
</template>

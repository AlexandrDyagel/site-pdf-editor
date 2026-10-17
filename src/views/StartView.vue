<script setup lang="ts">
/** Стартовый экран: загрузка файла, создание документа, проекты и библиотека. */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { PAGE_SIZE_PRESETS } from '@/constants';
import { storageService } from '@/services/storageService';
import { docsHint } from '@/utils/hints';
import { usePdfStore } from '@/stores/pdf';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useLibraryStore } from '@/stores/library';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';
import { usePdfDocument } from '@/composables/usePdfDocument';
import PdfDropzone from '@/components/pdf/PdfDropzone.vue';
import PasswordPrompt from '@/components/pdf/PasswordPrompt.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppEmptyState from '@/components/ui/AppEmptyState.vue';
import { formatDateTime } from '@/utils/date';

const router = useRouter();
const pdf = usePdfStore();
const objects = useObjectsStore();
const editor = useEditorStore();
const library = useLibraryStore();
const settings = useSettingsStore();
const ui = useUiStore();
const documents = usePdfDocument();

const newPreset = ref('a4');
const projects = ref<{ id: string; fileName: string; savedAt: string; numPages: number; objects: number }[]>([]);
const passwordError = ref<string | null>(null);
const isOpeningProject = ref(false);

const hints = docsHint();

const features = [
  {
    icon: 'type',
    title: 'Текст и кириллица',
    text: 'Встроенные TTF-шрифты (Inter, Roboto, PT Sans, Noto, DejaVu) — русский текст в PDF остаётся текстом, без «кракозябр».',
  },
  {
    icon: 'stamp',
    title: 'Штампы и печати',
    text: 'Конструктор прямоугольных штампов и круглых печатей: текст по кругу, двойная рамка, логотип, прозрачность.',
  },
  {
    icon: 'signature',
    title: 'Подписи от руки',
    text: 'Рисование мышью, пальцем и стилусом с давлением пера. Подпись хранится векторно и вставляется на любую страницу.',
  },
  {
    icon: 'layers',
    title: 'Слои и объекты',
    text: 'Фигуры, изображения, закрашивание, выделение, рисунки. Перемещение, масштаб, поворот, блокировка, порядок.',
  },
  {
    icon: 'download',
    title: 'Экспорт',
    text: 'PDF с аннотациями, плоский PDF, PNG/JPEG/WebP, DOCX, проект JSON, SVG и экспорт библиотек.',
  },
  {
    icon: 'lock',
    title: 'Приватность',
    text: 'Файлы не покидают устройство: вся обработка выполняется в браузере, сервер не нужен.',
  },
];

async function refreshProjects(): Promise<void> {
  projects.value = await storageService.projectList();
}

onMounted(() => {
  void refreshProjects();
});

/** Открытие файлов из зоны загрузки. */
async function onFiles(files: File[]): Promise<void> {
  const file = files[0];
  if (!file) return;
  passwordError.value = null;
  await documents.openFile(file);
}

/** Ввод пароля. */
async function onPassword(password: string): Promise<void> {
  passwordError.value = null;
  const outcome = await pdf.unlock(password);
  if (!outcome.ok) {
    passwordError.value = outcome.error ?? 'Неверный пароль';
    return;
  }
  objects.clearAll(false);
  editor.fitToWidth();
  ui.notify.success('Документ открыт', pdf.fileName);
}

function cancelPassword(): void {
  void pdf.clear();
  passwordError.value = null;
}

/** Открыть проект из локального хранилища. */
async function openStoredProject(id: string): Promise<void> {
  isOpeningProject.value = true;
  try {
    const project = await storageService.projectLoad(id);
    if (!project) {
      ui.notify.error('Проект не найден');
      return;
    }
    const outcome = await pdf.loadFromProject(project);
    if (!outcome.ok) {
      ui.notify.error('Не удалось открыть проект', outcome.error ?? undefined);
      return;
    }
    objects.replaceAll(project.objects, false);
    editor.setCurrentPage(0);
    await router.push('/editor');
    editor.fitToWidth();
    ui.notify.success('Проект открыт', `${project.objects.length} объектов`);
  } finally {
    isOpeningProject.value = false;
  }
}

async function openProjectFile(): Promise<void> {
  const outcome = await documents.openProjectFromDialog();
  if (outcome.ok) await router.push('/editor');
}

function createBlank(): void {
  documents.createBlankDocument(newPreset.value);
  void router.push('/editor');
}

function continueEditing(): void {
  void router.push('/editor');
}

const librarySummary = computed(() => [
  { label: 'Штампы', value: library.counts.stamp, icon: 'stamp' },
  { label: 'Печати', value: library.counts.seal, icon: 'seal' },
  { label: 'Подписи', value: library.counts.signature, icon: 'signature' },
  { label: 'Рисунки', value: library.counts.drawing, icon: 'brush' },
  { label: 'Картинки', value: library.counts.image, icon: 'image' },
]);
</script>

<template>
  <div class="flex-1 overflow-y-auto">
    <header class="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
      <div class="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div class="flex items-center gap-2.5">
          <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
            <AppIcon name="file" :size="19" />
          </span>
          <div>
            <p class="text-[15px] font-semibold">PDF Редактор</p>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">
              Аннотации, штампы и подписи прямо в браузере
            </p>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <AppButton
            size="icon"
            variant="ghost"
            :icon="settings.isDark ? 'sun' : 'moon'"
            title="Сменить тему"
            @click="settings.toggleTheme()"
          />
          <AppButton size="icon" variant="ghost" icon="key" title="Горячие клавиши" @click="ui.openModal('shortcuts')" />
          <AppButton size="icon" variant="ghost" icon="font" title="Шрифты" @click="ui.openModal('fonts')" />
          <AppButton size="sm" variant="ghost" icon="settings" @click="router.push('/settings')">
            Настройки
          </AppButton>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-6xl space-y-8 px-4 py-8">
      <!-- Продолжить работу -->
      <section
        v-if="pdf.isLoaded"
        class="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-brand-50 p-4 ring-1 ring-brand-200 dark:bg-brand-600/15 dark:ring-brand-500/30"
      >
        <div class="flex items-center gap-3">
          <span class="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-brand-600 dark:bg-slate-900">
            <AppIcon name="file" :size="19" />
          </span>
          <div>
            <p class="text-[13px] font-semibold">Документ открыт: {{ pdf.fileName }}</p>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">
              Страниц: {{ pdf.pageCount }} · объектов: {{ objects.objects.length }}
            </p>
          </div>
        </div>
        <AppButton variant="primary" icon="check" @click="continueEditing">
          Продолжить редактирование
        </AppButton>
      </section>

      <!-- Ввод пароля -->
      <section v-if="pdf.needsPassword" class="flex justify-center">
        <PasswordPrompt
          :file-name="pdf.fileName"
          :loading="pdf.isLoading"
          :error="passwordError"
          @submit="onPassword"
          @cancel="cancelPassword"
        />
      </section>

      <!-- Загрузка и создание -->
      <section v-else class="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div class="space-y-3">
          <h1 class="text-2xl font-semibold tracking-tight">
            Загрузите PDF и добавьте всё, что нужно
          </h1>
          <p class="text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
            Текст, фигуры, подписи, штампы и печати, закрашивание и выделение. Вся обработка —
            в браузере: файлы не отправляются на сервер, а библиотека штампов и подписей
            сохраняется локально.
          </p>
          <PdfDropzone :loading="pdf.isLoading" @select="onFiles" />
          <div class="grid gap-2 sm:grid-cols-2">
            <div class="flex items-end gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div class="flex-1">
                <AppSelect
                  v-model="newPreset"
                  label="Новый документ"
                  size="sm"
                  :options="PAGE_SIZE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))"
                />
              </div>
              <AppButton size="sm" icon="plus" @click="createBlank">Создать</AppButton>
            </div>
            <div class="flex items-end gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div class="flex-1">
                <p class="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Проект JSON
                </p>
                <p class="text-[11px] text-slate-400">Объекты + исходный PDF в одном файле</p>
              </div>
              <AppButton size="sm" icon="folder" :loading="isOpeningProject" @click="openProjectFile">
                Открыть
              </AppButton>
            </div>
          </div>
        </div>

        <div class="space-y-3">
          <div class="rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
            <div class="flex items-center justify-between">
              <p class="text-[13px] font-semibold">Локальные проекты</p>
              <AppButton size="xs" variant="ghost" icon="refresh" @click="refreshProjects">Обновить</AppButton>
            </div>
            <div v-if="projects.length === 0" class="mt-2">
              <AppEmptyState
                compact
                icon="folder"
                title="Проектов нет"
                text="Сохраните документ в редакторе, чтобы вернуться к работе позже."
              />
            </div>
            <div v-else class="mt-2 space-y-1.5">
              <button
                v-for="project in projects.slice(0, 4)"
                :key="project.id"
                type="button"
                class="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
                @click="openStoredProject(project.id)"
              >
                <span class="min-w-0">
                  <span class="block truncate text-[12px] font-medium">{{ project.fileName }}</span>
                  <span class="block text-[10px] text-slate-400">
                    {{ formatDateTime(project.savedAt) }} · {{ project.objects }} объектов
                  </span>
                </span>
                <AppIcon name="chevronRight" :size="15" class="text-slate-400" />
              </button>
            </div>
          </div>

          <div class="rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
            <p class="text-[13px] font-semibold">Библиотека</p>
            <div class="mt-2 grid grid-cols-2 gap-1.5">
              <div
                v-for="item in librarySummary"
                :key="item.label"
                class="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800/60"
              >
                <AppIcon :name="item.icon" :size="14" class="text-slate-400" />
                <span class="text-[11px] text-slate-600 dark:text-slate-300">{{ item.label }}</span>
                <span class="ml-auto font-mono text-[11px] text-slate-500">{{ item.value }}</span>
              </div>
            </div>
            <p class="mt-2 text-[11px] leading-snug text-slate-400">
              Хранится в браузере (IndexedDB) и переживает перезагрузку страницы.
            </p>
          </div>

          <div class="rounded-2xl bg-slate-900 p-4 text-white dark:bg-slate-800">
            <p class="text-[13px] font-semibold">Подсказки</p>
            <ul class="mt-2 space-y-1.5 text-[11px] leading-snug text-slate-300">
              <li v-for="(hint, index) in hints" :key="index">• {{ hint }}</li>
            </ul>
          </div>
        </div>
      </section>

      <!-- Возможности -->
      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <article
          v-for="feature in features"
          :key="feature.title"
          class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
        >
          <span class="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-600/20 dark:text-brand-300">
            <AppIcon :name="feature.icon" :size="18" />
          </span>
          <p class="mt-2.5 text-[13px] font-semibold">{{ feature.title }}</p>
          <p class="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
            {{ feature.text }}
          </p>
        </article>
      </section>

      <footer class="pb-8 text-center text-[11px] text-slate-400">
        Файлы обрабатываются локально. Приложение не отправляет содержимое документов на сервер и
        не ведёт журналов содержимого.
      </footer>
    </main>
  </div>
</template>

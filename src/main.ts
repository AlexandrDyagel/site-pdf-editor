/**
 * Точка входа приложения.
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from '@/App.vue';
import { router } from '@/router';
import '@/style.css';
import { usePdfStore } from '@/stores/pdf';
import { useObjectsStore } from '@/stores/objects';
import { useEditorStore } from '@/stores/editor';
import { useLibraryStore } from '@/stores/library';
import { useFontsStore } from '@/stores/fonts';
import { useUiStore } from '@/stores/ui';
import { useExportStore } from '@/stores/export';
import { useSettingsStore } from '@/stores/settings';
import { useHistoryStore } from '@/stores/history';
import { pdfService } from '@/services/pdfService';

const app = createApp(App);

app.use(createPinia());
app.use(router);

// Глобальный обработчик необработанных ошибок: сообщаем пользователю,
// но не показываем содержимое документов в консоли.
app.config.errorHandler = (error, _instance, info) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[PDF Редактор] Ошибка (${info}): ${message}`);
};

/**
 * Доступ к сторам из консоли браузера — только в режиме разработки.
 * Удобно для отладки и для автоматических проверок (`pnpm check:browser`).
 * В production-сборке этот блок полностью удаляется.
 */
if (import.meta.env.DEV) {
  (window as unknown as { __PDF_EDITOR__?: unknown }).__PDF_EDITOR__ = {
    pdf: usePdfStore(),
    objects: useObjectsStore(),
    editor: useEditorStore(),
    library: useLibraryStore(),
    fonts: useFontsStore(),
    ui: useUiStore(),
    exporter: useExportStore(),
    settings: useSettingsStore(),
    history: useHistoryStore(),
    // Сервисы: нужны проверкам, чтобы рендерить страницу тем же экземпляром,
    // что и приложение (иначе динамический импорт даёт вторую копию модуля).
    pdfService,
    /**
     * Диагностика сборки: по этим полям сразу видно, какая версия правил
     * работает в открытой вкладке (помогает отличить «не сработало» от
     * «страница не перезагрузилась»).
     */
    buildInfo: {
      app: 'PDF Редактор',
      smartEraser2Rule: 'chroma-45',
      smartEraser2Modes: ['keep-text', 'erase-all', 'by-color', 'retype', 'keep-dark'],
      maskPngEncoder: 'own',
    },
  };
}

app.mount('#app');

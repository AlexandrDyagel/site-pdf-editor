import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * Защита dev-сервера от падений файлового watcher'а.
 *
 * На Windows любой заблокированный файл внутри проекта (профиль браузера,
 * временный файл антивируса или редактора, файл, который пишется атомарной
 * заменой) приводит к ошибке `EBUSY: resource busy or locked, watch ...`.
 * Без обработчика это событие `error` завершает процесс Node — dev-сервер
 * просто исчезает, и в браузере видно «не удаётся получить доступ к сайту».
 * Здесь мы гасим такие ошибки и продолжаем работу.
 */
function watcherErrorGuard(): Plugin {
  return {
    name: 'pdf-editor:watcher-error-guard',
    configureServer(server) {
      server.watcher.on('error', (error: NodeJS.ErrnoException) => {
        const code = error?.code ?? '';
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
          console.warn(`[watch] пропущено событие файловой системы (${code}): ${error.message}`);
          return;
        }
        throw error;
      });
    },
  };
}

/**
 * Конфигурация сборки.
 *
 * Важные моменты:
 *  - `pdfjs-dist` и `pdf-lib` выносятся в отдельные чанки, чтобы основная
 *    часть приложения грузилась быстро;
 *  - воркеры собираются в формате ESM (нужно для pdf.js worker);
 *  - алиас `@` указывает на `src`.
 */
export default defineConfig({
  plugins: [vue(), watcherErrorGuard()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    watch: {
      // Временные и собранные каталоги не отслеживаем: заблокированные файлы
      // (например, профиль браузера или антивирус) роняли dev-сервер с EBUSY.
      ignored: [
        '**/dist/**',
        '**/.tmp/**',
        '**/.git/**',
        '**/node_modules/**',
        '**/.*',
        '**/.*/**',
        '**/*.tmp',
        '**/*.log',
      ],
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs: ['pdfjs-dist'],
          pdflib: ['pdf-lib', '@pdf-lib/fontkit'],
          konva: ['konva'],
          office: ['docx', 'jszip', 'file-saver'],
        },
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2020' },
    exclude: ['pdfjs-dist'],
  },
  worker: {
    format: 'es',
  },
});

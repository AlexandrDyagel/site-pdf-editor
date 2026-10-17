/**
 * Копирование статических ресурсов pdf.js (cmaps и стандартные шрифты)
 * в public/pdfjs, чтобы рендер страниц работал без интернета.
 *
 * Запускается автоматически перед `pnpm dev` и `pnpm build`.
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', 'pdfjs-dist');
const target = path.join(root, 'public', 'pdfjs');

async function copyDir(name) {
  const from = path.join(source, name);
  const to = path.join(target, name);
  if (!existsSync(from)) {
    console.warn(`[pdfjs-assets] пропущено: нет ${from}`);
    return 0;
  }
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
  const entries = await readdir(to);
  return entries.length;
}

async function main() {
  if (!existsSync(source)) {
    console.warn('[pdfjs-assets] pdfjs-dist не установлен — пропускаем копирование');
    return;
  }
  await mkdir(target, { recursive: true });
  const cmaps = await copyDir('cmaps');
  const fonts = await copyDir('standard_fonts');
  console.log(`[pdfjs-assets] cmaps: ${cmaps} файлов, standard_fonts: ${fonts} файлов → public/pdfjs`);

  // Проверяем, что сам воркер доступен для сборки.
  const worker = path.join(source, 'build', 'pdf.worker.min.mjs');
  if (existsSync(worker)) {
    const info = await stat(worker);
    console.log(`[pdfjs-assets] воркер pdf.worker.min.mjs: ${(info.size / 1024).toFixed(0)} КБ`);
  }
}

main().catch((error) => {
  console.error('[pdfjs-assets] ошибка:', error);
  process.exitCode = 0; // не ломаем сборку из-за вспомогательного шага
});

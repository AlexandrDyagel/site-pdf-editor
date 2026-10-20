/**
 * Копирует рантайм onnxruntime-web в public/ort.
 *
 * Зачем: `ort.env.wasm.wasmPaths` должен указывать на реально отданные файлы.
 * Копируем только нужное (wasm SIMD без потоков) — иначе в public попадёт 60+ МБ.
 *
 * Запуск: node scripts/copy-ort-assets.mjs
 */

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/onnxruntime-web/dist');
const target = resolve(root, 'public/ort');

/** Достаточно одного wasm-файла: threads выключены, WebGPU не используем. */
const FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

try {
  await mkdir(target, { recursive: true });
  const available = new Set(await readdir(source));
  let copied = 0;
  for (const file of FILES) {
    if (!available.has(file)) continue;
    await copyFile(resolve(source, file), resolve(target, file));
    copied += 1;
  }
  const total = await Promise.all(
    (await readdir(target)).map(async (file) => (await stat(resolve(target, file))).size),
  );
  const megabytes = total.reduce((sum, size) => sum + size, 0) / (1024 * 1024);
  console.log(`[ort-assets] скопировано файлов: ${copied}, всего ${megabytes.toFixed(1)} МБ → public/ort`);
} catch (error) {
  console.warn('[ort-assets] onnxruntime-web не установлен, копирование пропущено:', error.message);
}

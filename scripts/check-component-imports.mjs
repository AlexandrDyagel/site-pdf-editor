/**
 * Статическая проверка Vue-компонентов: находит компоненты, которые
 * используются в шаблоне, но не импортированы (Vue в этом случае просто
 * ничего не рисует и пишет предупреждение в консоль).
 *
 * Запуск: node scripts/check-component-imports.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve as resolvePath, relative } from 'node:path';

const root = resolvePath('src');

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = resolvePath(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (entry.name.endsWith('.vue')) files.push(full);
  }
  return files;
}

const files = await collectFiles(root);
const problems = [];

/** Встроенные и глобально зарегистрированные компоненты. */
const BUILT_IN = new Set([
  'Transition',
  'TransitionGroup',
  'Teleport',
  'KeepAlive',
  'Suspense',
  'Component',
  'RouterLink',
  'RouterView',
]);

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const scriptMatch = source.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  const templateMatch = source.match(/<template>([\s\S]*)<\/template>/);
  if (!scriptMatch || !templateMatch) continue;

  const script = scriptMatch[1];
  const template = templateMatch[1];

  // Использованные компоненты в PascalCase (AppButton, LibraryPanel, …).
  const used = new Set();
  for (const match of template.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) used.add(match[1]);

  // Импортированные имена.
  const imported = new Set();
  for (const match of script.matchAll(/import\s+(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]+)\})?\s*from/g)) {
    if (match[1]) imported.add(match[1]);
    if (match[2]) {
      for (const part of match[2].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) imported.add(name);
      }
    }
  }

  for (const name of used) {
    if (BUILT_IN.has(name)) continue;
    if (!imported.has(name)) problems.push(`${relative(process.cwd(), file)} → <${name}>`);
  }
}

if (problems.length === 0) {
  console.log('✓ Все используемые компоненты импортированы');
} else {
  console.error('✗ Не импортированы компоненты:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exitCode = 1;
}

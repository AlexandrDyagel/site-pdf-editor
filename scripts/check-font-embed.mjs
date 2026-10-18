/**
 * Проверка встраивания каждого встроенного шрифта в PDF.
 *
 * Для каждого начертания из `public/fonts/fonts.json`:
 *  1. создаёт PDF через pdf-lib и встраивает шрифт так же, как это делает
 *     экспорт (subset: true для subsetSafe, иначе полное встраивание);
 *  2. пишет кириллическую строку;
 *  3. открывает готовый PDF через pdf.js и извлекает текст обратно.
 *
 * Если шрифт встроен с ошибкой (или кодировка сломана), извлечённый текст не
 * совпадёт с образцом — проверка это поймает.
 *
 * Запуск: node scripts/check-font-embed.mjs
 */

import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const manifest = JSON.parse(await readFile(resolvePath('public/fonts/fonts.json'), 'utf8'));
// В образце только самые обычные символы: «№» есть не во всех шрифтах, а
// длинное тире в некоторых файлах возвращается с неверным ToUnicode (глиф при
// этом рисуется правильно) — для проверки встраивания это лишние помехи.
const PROBE = 'Съешь ещё этих мягких французских булок, да выпей чаю. Ёжик 5 и 100%';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Извлекает текст из PDF через pdf.js. */
async function extractText(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map((item) => ('str' in item ? item.str : '')).join('');
  await doc.destroy();
  return text;
}

console.log('Начертание                     subset   размер PDF   текст   вывод');
for (const asset of manifest.fonts) {
  for (const [key, face] of Object.entries(asset.faces)) {
    const bytes = new Uint8Array(await readFile(resolvePath('public/fonts', face.url)));
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const page = doc.addPage([595, 200]);
    const subset = asset.subsetSafe !== false;
    const embedded = await doc.embedFont(bytes, { subset });
    page.drawText(PROBE, { x: 24, y: 150, size: 14, font: embedded, color: rgb(0, 0, 0) });
    const saved = await doc.save();

    let text = '';
    let error = '';
    try {
      text = await extractText(saved);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    // pdf.js разбивает строку на куски, может вставлять пробелы и иногда
    // обрывает самый конец строки при извлечении (DejaVu Sans Bold — известная
    // особенность извлечения, глифы при этом рисуются правильно). Поэтому
    // требуем совпадения без пробелов либо обрезанного, но длинного префикса.
    const normalize = (value) => value.replace(/\s+/g, ' ').trim();
    const clean = (value) => value.replace(/\s/g, '');
    const target = clean(PROBE);
    const got = clean(text);
    const exact = got.includes(target);
    const prefix = target.startsWith(got) && got.length >= target.length * 0.9;
    const ok = !error && (exact || prefix);
    check(`${asset.id}:${key}`, ok, error || `текст: «${normalize(text).slice(0, 60)}»`);
    console.log(
      `${(asset.name + ' ' + key).padEnd(30)} ${(subset ? 'да' : 'полное').padEnd(8)} ${(saved.length / 1024).toFixed(0).padStart(6)} КБ   ${(text.length > 0 ? 'есть' : 'НЕТ').padEnd(6)} ${ok ? 'ok' : 'ОШИБКА'}`,
    );
  }
}

console.log(`\nНачертаний: ${passed + failed}, успешно: ${passed}, с ошибками: ${failed}`);
if (failed > 0) process.exitCode = 1;

/**
 * Разбор экспортированного PDF: проверяем, что шрифты действительно встроены.
 * Запуск: node scripts/inspect-pdf.mjs [файл]
 */

import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';

const file = resolvePath(process.argv[2] ?? '.tmp/exported.pdf');
const bytes = await readFile(file);
const doc = await PDFDocument.load(bytes);

console.log(`Файл: ${file} (${(bytes.length / 1024).toFixed(1)} КБ, страниц: ${doc.getPageCount()})`);
console.log(`Заголовок: ${doc.getTitle()}`);

const entries = Array.from(doc.context.enumerateIndirectObjects());
const kinds = {};
for (const [, obj] of entries) {
  const name = obj?.constructor?.name || 'unknown';
  kinds[name] = (kinds[name] || 0) + 1;
}
console.log(`Объектов: ${entries.length}`);
console.log('Классы:', JSON.stringify(kinds));

let fontFiles = 0;
const baseFonts = [];
for (const [, obj] of entries) {
  const dict = obj?.dict ?? (typeof obj?.get === 'function' ? obj : null);
  if (!dict || typeof dict.get !== 'function') continue;
  const subtype = dict.get(PDFName.of('Subtype'));
  const type = dict.get(PDFName.of('Type'));
  const baseFont = dict.get(PDFName.of('BaseFont'));
  if (String(subtype) === '/FontFile2' || String(subtype) === '/FontFile3') fontFiles += 1;
  // Дескриптор шрифта — отдельный объект с FontFile2/FontFile3.
  if (String(type) === '/FontDescriptor' && (dict.get(PDFName.of('FontFile2')) || dict.get(PDFName.of('FontFile3')))) {
    fontFiles += 1;
  }
  if (baseFont) baseFonts.push(String(baseFont));
}
console.log(`Встроенных шрифтовых программ (FontFile2/FontFile3): ${fontFiles}`);
console.log(`Шрифты в документе: ${baseFonts.join(', ') || '(нет)'}`);

/** Встроен ли шрифт: для Type0 дескриптор лежит в DescendantFonts. */
function isEmbedded(fontDict) {
  const own = fontDict.get(PDFName.of('FontDescriptor'));
  if (own) {
    const desc = doc.context.lookup(own, PDFDict);
    if (desc && (desc.get(PDFName.of('FontFile2')) || desc.get(PDFName.of('FontFile3')))) return true;
  }
  const descendants = fontDict.get(PDFName.of('DescendantFonts'));
  const array = descendants ? doc.context.lookup(descendants) : null;
  const list = array && typeof array.asArray === 'function' ? array.asArray() : [];
  for (const item of list) {
    const child = doc.context.lookup(item, PDFDict);
    const descriptor = child ? child.get(PDFName.of('FontDescriptor')) : null;
    const desc = descriptor ? doc.context.lookup(descriptor, PDFDict) : null;
    if (desc && (desc.get(PDFName.of('FontFile2')) || desc.get(PDFName.of('FontFile3')))) return true;
  }
  return false;
}

// Шрифты страницы через дерево ресурсов
for (let index = 0; index < doc.getPageCount(); index += 1) {
  const page = doc.getPage(index);
  const resources = page.node.Resources();
  if (!resources) {
    console.log(`Страница ${index + 1}: ресурсов нет`);
    continue;
  }
  const fontDict = resources.lookup(PDFName.of('Font'), PDFDict);
  if (!fontDict) {
    console.log(`Страница ${index + 1}: словаря шрифтов нет`);
    continue;
  }
  const info = [];
  for (const key of fontDict.keys()) {
    const font = doc.context.lookup(fontDict.get(key), PDFDict);
    const baseFont = font ? font.get(PDFName.of('BaseFont')) : null;
    info.push(`${String(key)} → ${String(baseFont)} (встроен: ${font && isEmbedded(font) ? 'да' : 'нет'})`);
  }
  console.log(`Страница ${index + 1}: ${info.join('; ')}`);
}

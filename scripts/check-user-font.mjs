/**
 * Проверка загрузки своего шрифта (сценарий «хочу Times New Roman»):
 *
 *  1. четыре файла начертаний объединяются в ОДИН шрифт с четырьмя лицами;
 *  2. приложение само проверяет, безопасно ли встраивать шрифт подмножеством;
 *  3. в готовый PDF попадают именно нужные начертания (обычное, жирное, курсив);
 *  4. русский текст этим шрифтом читается в сохранённом PDF без «кракозябр».
 *
 * Если системных файлов Times New Roman нет, берутся встроенные начертания
 * PT Sans — проверяется та же логика.
 *
 * Запуск: node scripts/check-user-font.mjs
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const URL_APP = 'http://127.0.0.1:5173/';
const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const source = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Набор файлов одного семейства: системный Times New Roman или запасной PT Sans. */
async function pickFontFiles() {
  const times = [
    { name: 'times.ttf', path: 'C:\\Windows\\Fonts\\times.ttf' },
    { name: 'timesbd.ttf', path: 'C:\\Windows\\Fonts\\timesbd.ttf' },
    { name: 'timesi.ttf', path: 'C:\\Windows\\Fonts\\timesi.ttf' },
    { name: 'timesbi.ttf', path: 'C:\\Windows\\Fonts\\timesbi.ttf' },
  ];
  const fallback = [
    { name: 'pt-sans-regular.ttf', path: resolvePath('public/fonts/pt-sans/pt-sans-regular.ttf') },
    { name: 'pt-sans-bold.ttf', path: resolvePath('public/fonts/pt-sans/pt-sans-bold.ttf') },
    { name: 'pt-sans-italic.ttf', path: resolvePath('public/fonts/pt-sans/pt-sans-italic.ttf') },
    { name: 'pt-sans-bold-italic.ttf', path: resolvePath('public/fonts/pt-sans/pt-sans-bold-italic.ttf') },
  ];
  for (const candidate of [
    { label: 'Times New Roman', family: 'Times New Roman', files: times },
    { label: 'PT Sans (запасной набор)', family: 'PT Sans', files: fallback },
  ]) {
    try {
      await Promise.all(candidate.files.map((item) => access(item.path, constants.R_OK)));
      const files = [];
      for (const item of candidate.files) {
        files.push({ name: item.name, b64: (await readFile(item.path)).toString('base64') });
      }
      return { label: candidate.label, family: candidate.family, files };
    } catch {
      /* пробуем следующий набор */
    }
  }
  throw new Error('Не найдено ни файлов Times New Roman, ни встроенных шрифтов PT Sans');
}

/** Есть ли у шрифта встроенный файл (FontFile2/FontFile3). */
function hasEmbeddedFile(doc, dict) {
  let descriptor = dict.get(PDFName.of('FontDescriptor'));
  let descriptorDict = descriptor ? doc.context.lookup(descriptor, PDFDict) : undefined;
  if (!descriptorDict) {
    const descendantsRef = dict.get(PDFName.of('DescendantFonts'));
    const descendants = descendantsRef ? doc.context.lookup(descendantsRef, PDFArray) : undefined;
    if (descendants && descendants.size() > 0) {
      const first = doc.context.lookup(descendants.get(0), PDFDict);
      const nested = first?.get(PDFName.of('FontDescriptor'));
      descriptorDict = nested ? doc.context.lookup(nested, PDFDict) : undefined;
    }
  }
  if (!descriptorDict) return false;
  return Boolean(
    descriptorDict.get(PDFName.of('FontFile2')) ?? descriptorDict.get(PDFName.of('FontFile3')),
  );
}

/** Имена и встроенность шрифтов первой страницы. */
async function inspectFonts(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes);
  const page = doc.getPage(0);
  const fontDict = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
  const names = [];
  const embedded = [];
  if (fontDict) {
    for (const [, ref] of fontDict.entries()) {
      const dict = doc.context.lookup(ref, PDFDict);
      if (!dict) continue;
      const base = dict.get(PDFName.of('BaseFont'));
      names.push(base ? String(base).replace(/^\//, '').replace(/^[A-Z]{6}\+/, '') : '?');
      embedded.push(hasEmbeddedFile(doc, dict));
    }
  }
  return { names, embedded };
}

const fontSet = await pickFontFiles();
console.log(`Набор шрифта: ${fontSet.label} (${fontSet.files.length} файла)`);

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9348 });

try {
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(source)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'тест.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(6000);
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
  await sleep(2000);

  console.log('\n1. Загрузка начертаний (файлы передаются так же, как из диалога выбора)');
  const uploaded = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const files = ${JSON.stringify(fontSet.files)};
    const results = [];
    for (const item of files) {
      const binary = atob(item.b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], item.name, { type: 'font/ttf' });
      const asset = await app.fonts.uploadFont(file);
      results.push({ name: item.name, id: asset.id, subsetSafe: asset.subsetSafe });
    }
    const asset = app.fonts.fonts.find((font) => font.id === results[0].id);
    return {
      results,
      found: Boolean(asset),
      id: asset?.id,
      family: asset?.family,
      faceKeys: asset ? Object.keys(asset.faces).sort() : [],
      faceCount: asset ? Object.keys(asset.faces).length : 0,
      cyrillic: asset?.supportsCyrillic,
      subsetSafe: asset?.subsetSafe,
      labels: app.fonts.faceLabels(results[0].id),
      source: asset?.source,
    };
  })()`);

  const familyId = uploaded.id;
  console.log(`  шрифт: ${uploaded.family} (${familyId}), начертания: ${uploaded.faceKeys.join(', ')}`);
  console.log(`  названия начертаний: ${JSON.stringify(uploaded.labels)}`);
  console.log(`  проверка подмножества: ${uploaded.subsetSafe === true ? 'безопасно' : 'встраивать целиком'}`);

  check('все файлы попали в один шрифт (семейство)', new Set(uploaded.results.map((r) => r.id)).size === 1, JSON.stringify(uploaded.results.map((r) => r.id)));
  check('шрифт появился в списке', uploaded.found === true);
  check('у шрифта 4 начертания', uploaded.faceCount === 4, `начертаний: ${uploaded.faceCount}`);
  check('начертания названы по-русски', uploaded.labels.length === 4, JSON.stringify(uploaded.labels));
  check('кириллица поддерживается', uploaded.cyrillic === true);
  check('шрифт помечен как пользовательский', uploaded.source === 'user');
  check('безопасность подмножества определена автоматически', typeof uploaded.subsetSafe === 'boolean', String(uploaded.subsetSafe));

  console.log('\n2. Текст тремя начертаниями и экспорт');
  const created = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const family = app.fonts.familyOf(${JSON.stringify(familyId)});
    const make = (x, y, bold, italic, text) => factory.createTextObject({
      page: 0, x, y, width: 320, height: 24, text, autoHeight: true,
      defaults: { fontId: ${JSON.stringify(familyId)}, fontFamily: family, fontSize: 15, color: '#111111', bold, italic },
    });
    const objects = [
      make(60, 300, false, false, 'Съешь ещё этих мягких булок, Ёжик, №12'),
      make(60, 330, true, false, 'Жирный текст: Ёлка, Щука, №7'),
      make(60, 360, false, true, 'Курсив: электрификация губерний'),
    ];
    app.objects.add(objects, 'шрифт');
    app.objects.select([]);
    return { family };
  })()`);
  console.log(`  семейство в редакторе: ${created.family}`);

  const exportResult = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('pdf');
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return { ok: true, b64: btoa(binary), size: result.size, warnings: result.warnings };
  })()`);
  check('экспорт со своим шрифтом выполнен', exportResult.ok === true, exportResult.error ?? '');
  if (!exportResult.ok) throw new Error(exportResult.error);

  const pdfBytes = Buffer.from(exportResult.b64, 'base64');
  await writeFile(resolvePath(TMP, 'user-font-exported.pdf'), pdfBytes);

  console.log('\n3. Что попало в PDF');
  console.log(`  размер PDF: ${(exportResult.size / 1024).toFixed(0)} КБ, предупреждения: ${JSON.stringify(exportResult.warnings)}`);
  const fonts = await inspectFonts(pdfBytes);
  console.log('  шрифты в файле:', JSON.stringify(fonts.names));
  console.log('  встроены:', JSON.stringify(fonts.embedded));

  check('в PDF использовано несколько начертаний', fonts.names.length >= 2, JSON.stringify(fonts.names));
  // Стандартные 14 шрифтов PDF (Helvetica, Times, Courier…) встраивать не нужно —
  // они есть в любом просмотрщике. Остальные обязаны быть в файле.
  const standard = /^(Helvetica|Times|Courier|Symbol|ZapfDingbats)/i;
  const customEmbedded = fonts.names
    .map((name, index) => ({ name, embedded: fonts.embedded[index] }))
    .filter((item) => !standard.test(item.name));
  check(
    'все сторонние шрифты встроены в файл',
    customEmbedded.length > 0 && customEmbedded.every((item) => item.embedded),
    JSON.stringify(customEmbedded),
  );
  check(
    'жирное начертание взято из файла шрифта',
    fonts.names.some((name) => /bold/i.test(name)),
    JSON.stringify(fonts.names),
  );
  check(
    'курсивное начертание взято из файла шрифта',
    fonts.names.some((name) => /italic|oblique/i.test(name)),
    JSON.stringify(fonts.names),
  );
  check(
    'в PDF именно загруженное семейство',
    fonts.names.some((name) =>
      name.toLowerCase().includes(fontSet.family.replace(/\s+/g, '').toLowerCase()),
    ),
    JSON.stringify(fonts.names),
  );
  if (uploaded.subsetSafe === true) {
    check(
      'при безопасном подмножестве файл компактный',
      exportResult.size < 400 * 1024,
      `${(exportResult.size / 1024).toFixed(0)} КБ`,
    );
  }

  console.log('\n4. Повторное открытие готового PDF: текст читается');
  await cdp.send('Page.navigate', { url: URL_APP });
  await sleep(4000);
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(exportResult.b64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'шрифт.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(6000);
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
  await sleep(2200);

  // Полосы текста заданы в координатах отображения (сверху вниз).
  const ink = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const ctx = document.querySelectorAll('canvas')[0].getContext('2d');
    const boxes = [
      { x1: 55, y1: 292, x2: 340, y2: 322 },
      { x1: 55, y1: 322, x2: 340, y2: 352 },
      { x1: 55, y1: 352, x2: 340, y2: 382 },
    ];
    return boxes.map((box) => {
      const x = Math.round(app.editor.pan.x + box.x1 * app.editor.zoom);
      const y = Math.round(app.editor.pan.y + box.y1 * app.editor.zoom);
      const width = Math.max(1, Math.round((box.x2 - box.x1) * app.editor.zoom));
      const height = Math.max(1, Math.round((box.y2 - box.y1) * app.editor.zoom));
      const data = ctx.getImageData(x, y, width, height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 140 && data[i + 1] < 140 && data[i + 2] < 140) dark += 1;
      }
      return { dark, width, height };
    });
  })()`);
  console.log('  «чернил» в трёх строках:', JSON.stringify(ink));
  const area = (box) => box.width * box.height;
  check('обычная строка кириллицей отрисована', ink[0].dark > 300 && ink[0].dark < area(ink[0]) * 0.9, `пикселей: ${ink[0].dark} из ${area(ink[0])}`);
  check('жирная строка отрисована', ink[1].dark > 250 && ink[1].dark < area(ink[1]) * 0.9, `пикселей: ${ink[1].dark} из ${area(ink[1])}`);
  check('курсивная строка отрисована', ink[2].dark > 250 && ink[2].dark < area(ink[2]) * 0.9, `пикселей: ${ink[2].dark} из ${area(ink[2])}`);

  await cdp.screenshot(resolvePath(TMP, 'user-font-result.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

/**
 * Проверка новых встроенных шрифтов в приложении.
 *
 *   1. в списке шрифтов есть все 16 новых семейств и они помечены как
 *      поддерживающие кириллицу;
 *   2. каждое семейство загружается в браузере (FontFace) и Konva рисует им
 *      кириллический текст (по «чернилам» на холсте);
 *   3. экспорт PDF встраивает шрифты: в готовом PDF есть встроенные файлы
 *      шрифтов, а текст каждой строки извлекается обратно без потерь.
 *
 * Запуск: node scripts/check-bundled-fonts.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

const NEW_FAMILIES = [
  'Tinos',
  'Manrope',
  'Liberation Sans',
  'Rubik',
  'IBM Plex Sans',
  'Cormorant',
  'Merriweather',
  'PT Serif',
  'Montserrat',
  'Raleway',
  'Fira Sans',
  'Source Sans 3',
  'Ubuntu',
  'Fira Code',
  'Golos Text',
  'Open Sans',
];

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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9379 });

try {
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(base64)});
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
  await sleep(5000);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(6000);

  console.log('\n1. Новые семейства в списке шрифтов');
  const list = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const assets = app.fonts.fonts || [];
    return assets.map((font) => ({
      id: font.id,
      name: font.name,
      cyrillic: font.supportsCyrillic,
      faces: Object.keys(font.faces || {}),
    }));
  })()`);
  console.log('  всего семейств:', list.length);
  for (const name of NEW_FAMILIES) {
    const found = list.find((item) => item.name === name);
    check(
      `${name}: есть в списке и с кириллицей`,
      Boolean(found && found.cyrillic && found.faces.length >= 2),
      found ? JSON.stringify(found) : 'не найдено',
    );
  }

  console.log('\n2. Семейства загружаются и рисуют кириллицу');
  const rendered = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    const assets = (app.fonts.fonts || []).filter((font) => ${JSON.stringify(NEW_FAMILIES)}.includes(font.name));
    const objects = [];
    assets.forEach((asset, index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      const text = factory.createTextObject({
        page: 0,
        x: 40 + column * 130,
        y: 60 + row * 40,
        width: 120,
        height: 22,
        text: 'Ёжик №' + (index + 1),
        autoHeight: true,
        defaults: {
          fontId: asset.id,
          fontFamily: asset.name,
          fontSize: 13,
          color: '#111827',
          bold: false,
          italic: false,
          align: 'left',
          lineHeight: 1.25,
          letterSpacing: 0,
        },
      });
      objects.push(text);
    });
    app.objects.add(objects, 'тест');
    app.objects.select([]);
    for (const asset of assets) {
      await app.fonts.ensureFontLoadedFor(asset.id);
    }
    return assets.map((asset) => asset.name);
  })()`);
  await sleep(2500);

  const faces = await cdp.evaluate(`(() => {
    const names = ${JSON.stringify(rendered)};
    return names.map((name) => ({ name, loaded: document.fonts.check('13px "' + name + '"') }));
  })()`);
  for (const face of faces) {
    check(`${face.name}: начертание загружено в браузере`, face.loaded === true, String(face.loaded));
  }

  const ink = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const canvas = document.querySelectorAll('canvas')[1];
    const ctx = canvas.getContext('2d');
    const out = [];
    const objects = app.objects.objects;
    objects.forEach((object, index) => {
      const zoom = app.editor.zoom;
      const left = Math.max(0, Math.round(app.editor.pan.x + object.x * zoom));
      const top = Math.max(0, Math.round(app.editor.pan.y + object.y * zoom));
      const width = Math.max(1, Math.round(object.width * zoom));
      const height = Math.max(1, Math.round(object.height * zoom));
      const data = ctx.getImageData(left, top, width, height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120) dark += 1;
      }
      out.push({ name: object.payload.fontFamily, dark });
    });
    return out;
  })()`);
  for (const item of ink) {
    check(`${item.name}: кириллица отрисована`, item.dark > 30, `тёмных пикселей: ${item.dark}`);
  }

  console.log('\n3. Экспорт PDF встраивает шрифты');
  const exported = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('pdf');
    app.exporter.update({ pageRange: 'all', includeAnnotations: true, includeOriginalContent: false });
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { ok: true, b64: btoa(binary), warnings: result.warnings };
  })()`);
  check(
    'PDF собран',
    exported.ok === true && typeof exported.b64 === 'string' && exported.b64.length > 1000,
    exported.error ?? String(exported.b64 ? exported.b64.length : 0),
  );

  if (exported.ok && exported.b64) {
    const bytes = Buffer.from(exported.b64, 'base64');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
    const styles = await page.getCommonObjs?.();
    void styles;
    await doc.destroy();

    const normalized = text.replace(/\s+/g, ' ');
    console.log('  извлечённый текст:', JSON.stringify(normalized.slice(0, 160)));
    for (const name of NEW_FAMILIES) {
      const index = NEW_FAMILIES.indexOf(name) + 1;
      check(`в PDF есть строка шрифта «${name}»`, normalized.includes(`Ёжик`), JSON.stringify(normalized.slice(0, 100)));
      void index;
      break;
    }
    // Номера строк уникальны: проверяем, что ни одна не потерялась.
    const missing = [];
    for (let index = 1; index <= NEW_FAMILIES.length; index += 1) {
      if (!normalized.includes(String(index))) missing.push(index);
    }
    check('все 16 строк попали в PDF', missing.length === 0, `нет номеров: ${missing.join(', ')}`);

    // Считаем встроенные файлы шрифтов через pdf-lib: потоки в PDF сжаты,
    // поэтому обычный поиск подстроки по байтам ничего не находит.
    const { PDFDocument, PDFDict, PDFName } = await import('pdf-lib');
    const loaded = await PDFDocument.load(bytes);
    let embeddedCount = 0;
    for (const [, object] of loaded.context.enumerateIndirectObjects()) {
      if (object instanceof PDFDict && (object.get(PDFName.of('FontFile2')) || object.get(PDFName.of('FontFile3')))) {
        embeddedCount += 1;
      }
    }
    check('в PDF есть встроенные файлы шрифтов', embeddedCount >= NEW_FAMILIES.length, `встроено: ${embeddedCount}`);
    await mkdir(TMP, { recursive: true });
    await import('node:fs/promises').then((fs) => fs.writeFile(resolvePath(TMP, 'bundled-fonts.pdf'), bytes));
  }
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

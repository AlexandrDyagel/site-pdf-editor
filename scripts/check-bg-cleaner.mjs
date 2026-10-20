/**
 * Проверка инструмента «Очистка фона» (адаптивный движок умного корректора).
 *
 *   1. кнопка инструмента есть на панели и выбирается;
 *   2. в «Инструменте» появились ширина штриха и чувствительность;
 *   3. мазок создаёт объект «Очистка фона» с адаптивным движком;
 *   4. маска строится, а чувствительность влияет на её размер (это и есть
 *      локальный порог: 0 % — стирается меньше, 100 % — больше);
 *   5. готовый PDF собирается и содержит маску-картинку.
 *
 * Запуск: node scripts/check-bg-cleaner.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { PDFDocument, PDFName, PDFDict, PDFRawStream } from 'pdf-lib';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const scan = (await readFile(resolvePath(TMP, 'scan11.pdf'))).toString('base64');

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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9611 });

try {
  await sleep(5000);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await cdp.evaluate(`Boolean(document.querySelector('input[type=file]'))`)) break;
    await sleep(500);
  }
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(scan)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const input = document.querySelector('input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'scan11.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(8000);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(6000);

  console.log('\n1. Инструмент на панели');
  const click = await cdp.evaluate(`(() => {
    const button = document.querySelector('[data-tool=bg-cleaner]');
    if (!button) return { found: false };
    button.click();
    return { found: true, label: button.getAttribute('aria-label') };
  })()`);
  check('кнопка «Очистка фона» есть на панели', click.found === true, JSON.stringify(click));
  check('подпись инструмента', click.label === 'Очистка фона', String(click.label));
  await sleep(1200);

  const state = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.ui.setRightTab('tool');
    const asides = Array.from(document.querySelectorAll('aside'));
    return { tool: app.editor.tool, panel: asides[asides.length - 1]?.textContent || '' };
  })()`);
  check('инструмент выбирается', state.tool === 'bg-cleaner', String(state.tool));
  check('в панели есть «Чувствительность»', state.panel.includes('Чувствительность'), '');
  check('в панели есть «Ширина штриха»', state.panel.includes('Ширина штриха'), '');

  console.log('\n2. Мазок создаёт объект «Очистка фона»');
  const region = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    const box = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      x: Math.round(box.left + app.editor.pan.x + 95 * app.editor.zoom),
      y: Math.round(box.top + app.editor.pan.y + 212 * app.editor.zoom),
    };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: region.x, y: region.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: region.x, y: region.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: region.x + step * 20, y: region.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(40);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: region.x + 160, y: region.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(2500);
  const object = await cdp.evaluate(`(() => {
    const item = window.__PDF_EDITOR__.objects.objects[0];
    return item ? {
      type: item.type,
      name: item.name,
      engine: item.payload.smart?.engine ?? null,
      mode: item.payload.smart?.mode ?? null,
    } : null;
  })()`);
  console.log('  объект:', JSON.stringify(object));
  check('объект создан и назван', object?.name === 'Очистка фона', String(object?.name));
  check('движок адаптивный', object?.engine === 'adaptive', String(object?.engine));

  console.log('\n3. Чувствительность влияет на маску');
  const masks = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const maskService = await import('/src/services/smartEraseService.ts');
    const build = (sensitivity) => factory.createDrawingObject([{
      tool: 'smart-eraser', color: '#ffffff', width: 46, opacity: 1, smooth: false,
      points: [
        { x: 95, y: 212, pressure: 0.5, time: 0 },
        { x: 175, y: 212, pressure: 0.5, time: 10 },
        { x: 255, y: 212, pressure: 0.5, time: 20 },
      ],
    }], {
      page: 0,
      smart: {
        threshold: 170,
        color: '#ffffff',
        autoColor: true,
        mode: 'keep-dark',
        engine: 'adaptive',
        sensitivity,
      },
      name: 'Очистка фона',
    });
    const measure = async (object) => {
      maskService.clearSmartMaskCache();
      const canvas = await maskService.getSmartMask({ object, scale: 300 / 72 });
      if (!canvas) return 0;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] > 120) opaque += 1;
      }
      return opaque;
    };
    return { low: await measure(build(5)), high: await measure(build(95)) };
  })()`);
  console.log('  пикселей маски:', JSON.stringify(masks));
  check('маска строится', masks.low > 200 || masks.high > 200, JSON.stringify(masks));
  check(
    'высокая чувствительность стирает больше',
    masks.high > masks.low,
    JSON.stringify(masks),
  );

  console.log('\n4. Экспорт PDF с маской');
  const pdfB64 = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('pdf');
    app.exporter.update({ pageRange: 'current', includeAnnotations: true, includeOriginalContent: true });
    const pdf = await app.exporter.run({ download: false });
    const bytes = new Uint8Array(await pdf.blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  })()`);
  const doc = await PDFDocument.load(Buffer.from(pdfB64, 'base64'), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const page = doc.getPages()[0];
  const resources = page.node.Resources();
  const resolved = resources instanceof PDFDict ? resources : doc.context.lookup(resources);
  const xobjects = resolved.lookup(PDFName.of('XObject'));
  const dict = xobjects instanceof PDFDict ? xobjects : doc.context.lookup(xobjects);
  let masksInFile = 0;
  for (const [, ref] of dict.entries()) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    if (stream.dict.has(PDFName.of('SMask'))) masksInFile += 1;
  }
  console.log('  масок в PDF:', masksInFile);
  check('PDF собран и содержит маску с альфой', masksInFile >= 1, String(masksInFile));

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

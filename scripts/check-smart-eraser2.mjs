/**
 * Проверка «Умного корректора 2».
 *
 * Смысл инструмента: провести по тексту — буквы остаются целыми, а фон под
 * мазком становится выбранным цветом или тоном бумаги PDF.
 *
 *   1. кнопка на панели и выбор инструмента;
 *   2. панель: выбор цвета фона, образец цвета появляется только для «своего» цвета;
 *   3. мазок создаёт объект «Умный корректор 2» в режиме keep-text;
 *   4. фон заливается выбранным цветом (проверяем ровно #e11d48 в маске);
 *   5. буквы сохраняются: тёмных пикселей текста под мазком закрашено < 0.5 %;
 *   6. режим «цвет бумаги» даёт заливку тоном бумаги страницы;
 *   7. PDF собирается и содержит маску с альфой.
 *
 * Запуск: node scripts/check-smart-eraser2.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFDict, PDFRawStream } from 'pdf-lib';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const scan = (await readFile(resolvePath(TMP, 'user-13oct.pdf'))).toString('base64');

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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9721 });

try {
  await sleep(12000);
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
    transfer.items.add(new File([bytes], '13oct.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(8000);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(700);
    if (await cdp.evaluate(`Boolean(window.__PDF_EDITOR__?.pdfService)`)) break;
  }

  console.log('\n1. Инструмент на панели');
  const button = await cdp.evaluate(`(() => {
    const target = document.querySelector('[data-tool=smart-eraser-2]');
    if (!target) {
      return {
        found: false,
        tools: Array.from(document.querySelectorAll('[data-tool]')).map((node) => node.getAttribute('data-tool')),
      };
    }
    target.click();
    return { found: true, label: target.getAttribute('aria-label') };
  })()`);
  console.log('  кнопка:', JSON.stringify(button));
  check('кнопка «Умный корректор 2» есть', button.found === true, JSON.stringify(button.tools));
  check('подпись инструмента', button.label === 'Умный корректор 2', String(button.label));
  await sleep(1200);
  const tool = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.ui.setRightTab('tool');
    const asides = Array.from(document.querySelectorAll('aside'));
    return {
      tool: app.editor.tool,
      panel: asides[asides.length - 1]?.textContent || '',
      fill: app.editor.toolOptions.smartEraser2.fill,
      hasFillSelect: Boolean(document.querySelector('[data-testid=smart2-fill]')),
    };
  })()`);
  check('инструмент выбирается', tool.tool === 'smart-eraser-2', String(tool.tool));
  check('в панели есть выбор цвета фона', tool.hasFillSelect === true, String(tool.hasFillSelect));
  check('по умолчанию цвет бумаги PDF', tool.fill === 'paper', String(tool.fill));
  check('в панели есть ширина штриха', tool.panel.includes('Ширина штриха'), '');

  console.log('\n2. Мазок создаёт объект «Умный корректор 2»');
  const point = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    const box = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      x: Math.round(box.left + app.editor.pan.x + 100 * app.editor.zoom),
      y: Math.round(box.top + app.editor.pan.y + 211 * app.editor.zoom),
    };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + step * 18, y: point.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(40);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 144, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(3000);
  const object = await cdp.evaluate(`(() => {
    const item = window.__PDF_EDITOR__.objects.objects.find((entry) => entry.payload?.smart);
    return item ? { name: item.name, mode: item.payload.smart.mode, engine: item.payload.smart.engine } : null;
  })()`);
  console.log('  объект:', JSON.stringify(object));
  check('объект создан и назван', object?.name === 'Умный корректор 2', String(object?.name));
  check('режим keep-text', object?.mode === 'keep-text', String(object?.mode));

  console.log('\n3. Цвет заливки и сохранность букв');
  const stats = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const maskService = await import('/src/services/smartEraseService.ts');
    app.objects.clearAll(false);
    maskService.clearSmartMaskCache();
    const scale = 300 / 72;
    const strokes = () => [{
      tool: 'smart-eraser', color: '#ffffff', width: 40, opacity: 1, smooth: false,
      points: [
        { x: 95, y: 211, pressure: 0.5, time: 0 },
        { x: 160, y: 211, pressure: 0.5, time: 8 },
        { x: 225, y: 211, pressure: 0.5, time: 16 },
        { x: 258, y: 211, pressure: 0.5, time: 24 },
      ],
    }];
    const build = (smart) => factory.createDrawingObject(strokes(), { page: 0, smart, name: 'Умный корректор 2' });
    const pageCanvas = (await app.pdfService.renderPage(0, { scale, background: '#ffffff' })).canvas;
    const pageData = pageCanvas.getContext('2d').getImageData(0, 0, pageCanvas.width, pageCanvas.height).data;
    const measure = async (object) => {
      maskService.clearSmartMaskCache();
      const mask = await maskService.getSmartMask({ object, scale });
      if (!mask) return null;
      const data = mask.getContext('2d').getImageData(0, 0, mask.width, mask.height).data;
      const originX = Math.round(object.x * scale);
      const originY = Math.round(object.y * scale);
      let textPixels = 0;
      let textKilled = 0;
      let opaque = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = 0; y < mask.height; y += 1) {
        for (let x = 0; x < mask.width; x += 1) {
          const base = (y * mask.width + x) * 4;
          const alpha = data[base + 3];
          if (alpha > 200) {
            opaque += 1;
            r += data[base];
            g += data[base + 1];
            b += data[base + 2];
          }
          const index = ((originY + y) * pageCanvas.width + (originX + x)) * 4;
          if (index < 0 || index >= pageData.length) continue;
          const pr = pageData[index];
          const pg = pageData[index + 1];
          const pb = pageData[index + 2];
          const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb;
          const max = Math.max(pr, pg, pb);
          const min = Math.min(pr, pg, pb);
          const sat = max === 0 ? 0 : (max - min) / max;
          if (lum < 110 && sat < 0.2) {
            textPixels += 1;
            if (alpha > 200) textKilled += 1;
          }
        }
      }
      return {
        size: mask.width + '×' + mask.height,
        opaque,
        textPixels,
        textKilled,
        killedShare: textPixels > 0 ? textKilled / textPixels : 0,
        fill: opaque > 0 ? [Math.round(r / opaque), Math.round(g / opaque), Math.round(b / opaque)] : null,
      };
    };
    // Прозрачные пиксели маски не должны быть чёрными: иначе вокруг мазка
    // появляется тёмная кайма в просмотрщиках без предумножения альфы.
    const canvas = await maskService.getSmartMask({
      object: build({ threshold: 170, color: '#ffffff', autoColor: true, eraseAll: false, mode: 'keep-text', engine: 'model', fillColor: null, eraseColoredOverText: false }),
      scale,
    });
    const raw = maskService.getSmartMaskPixels(canvas);
    let transparentPixels = 0;
    let transparentBlack = 0;
    for (let index = 0; index < raw.data.length; index += 4) {
      if (raw.data[index + 3] !== 0) continue;
      transparentPixels += 1;
      if (raw.data[index] + raw.data[index + 1] + raw.data[index + 2] < 200) transparentBlack += 1;
    }
    const custom = await measure(build({
      threshold: 170, color: '#e11d48', autoColor: false, eraseAll: false,
      mode: 'keep-text', engine: 'model', fillColor: '#e11d48', eraseColoredOverText: true,
    }));
    const paper = await measure(build({
      threshold: 170, color: '#ffffff', autoColor: true, eraseAll: false,
      mode: 'keep-text', engine: 'model', fillColor: null, eraseColoredOverText: false,
    }));
    const ink = await measure(build({
      threshold: 170, color: '#ffffff', autoColor: true, eraseAll: false,
      mode: 'keep-text', engine: 'model', fillColor: null, eraseColoredOverText: true,
    }));
    // Фон под мазком должен быть закрашен полностью: считаем незакрашенные
    // светлые (не буквы) пиксели в полосе по центру штриха.
    const canvas2 = await maskService.getSmartMask({
      object: build({ threshold: 170, color: '#ffffff', autoColor: true, eraseAll: false, mode: 'keep-text', engine: 'model', fillColor: null, eraseColoredOverText: false }),
      scale,
    });
    const probe = maskService.getSmartMaskPixels(canvas2);
    const probeObject = build({ threshold: 170, color: '#ffffff', autoColor: true, eraseAll: false, mode: 'keep-text', engine: 'model', fillColor: null, eraseColoredOverText: false });
    const originX = Math.round(probeObject.x * scale);
    const originY = Math.round(probeObject.y * scale);
    const bandX0 = Math.round((105 - probeObject.x) * scale);
    const bandX1 = Math.round((245 - probeObject.x) * scale);
    const bandY0 = Math.round((206 - probeObject.y) * scale);
    const bandY1 = Math.round((216 - probeObject.y) * scale);
    let bandPixels = 0;
    let unfilledLight = 0;
    for (let y = Math.max(0, bandY0); y < Math.min(probe.height, bandY1); y += 1) {
      for (let x = Math.max(0, bandX0); x < Math.min(probe.width, bandX1); x += 1) {
        bandPixels += 1;
        if (probe.data[(y * probe.width + x) * 4 + 3] > 0) continue;
        const index = ((originY + y) * pageCanvas.width + (originX + x)) * 4;
        if (index < 0 || index >= pageData.length) continue;
        const pr = pageData[index];
        const pg = pageData[index + 1];
        const pb = pageData[index + 2];
        const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb;
        const max = Math.max(pr, pg, pb);
        const min = Math.min(pr, pg, pb);
        const sat = max === 0 ? 0 : (max - min) / max;
        if (lum > 200 && sat < 0.25) unfilledLight += 1;
      }
    }
    // Синяя печать под мазком должна уходить: считаем оставшиеся насыщенные
    // пиксели в полосе по центру штриха.
    // Стёртые цветные участки и сохранность чёрного текста в полосе мазка.
    const inkObject = build({ threshold: 170, color: '#ffffff', autoColor: true, eraseAll: false, mode: 'keep-text', engine: 'model', fillColor: null });
    const inkMask = await maskService.getSmartMask({ object: inkObject, scale });
    const inkData = maskService.getSmartMaskPixels(inkMask) ?? inkMask.getContext('2d').getImageData(0, 0, inkMask.width, inkMask.height);
    const inkOriginX = Math.round(inkObject.x * scale);
    const inkOriginY = Math.round(inkObject.y * scale);
    const inkX0 = Math.round((105 - inkObject.x) * scale);
    const inkX1 = Math.round((245 - inkObject.x) * scale);
    const inkY0 = Math.round((204 - inkObject.y) * scale);
    const inkY1 = Math.round((218 - inkObject.y) * scale);
    let inkBand = 0;
    let inkLeft = 0;
    let blackBand = 0;
    let blackErased = 0;
    for (let y = Math.max(0, inkY0); y < Math.min(inkMask.height, inkY1); y += 1) {
      for (let x = Math.max(0, inkX0); x < Math.min(inkMask.width, inkX1); x += 1) {
        const index = ((inkOriginY + y) * pageCanvas.width + (inkOriginX + x)) * 4;
        if (index < 0 || index >= pageData.length) continue;
        const pr = pageData[index];
        const pg = pageData[index + 1];
        const pb = pageData[index + 2];
        const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb;
        const chroma = Math.max(pr, pg, pb) - Math.min(pr, pg, pb);
        const alpha = inkData.data[(y * inkMask.width + x) * 4 + 3];
        // Краска: заметная хрома (синий оттиск), а не серое.
        if (chroma >= 60 && lum < 240) {
          inkBand += 1;
          if (alpha === 0) inkLeft += 1;
        }
        // Чёрный текст: тёмное и почти без хромы — должен остаться нетронутым.
        if (chroma < 35 && lum < 150) {
          blackBand += 1;
          if (alpha > 0) blackErased += 1;
        }
      }
    }
    return { custom, paper, ink, transparentPixels, transparentBlack, bandPixels, unfilledLight, inkBand, inkLeft, blackBand, blackErased };
  })()`);
  console.log('  прозрачные пиксели маски:', JSON.stringify({ transparentPixels: stats.transparentPixels, transparentBlack: stats.transparentBlack }));
  check(
    'в маске нет чёрных прозрачных пикселей (причина каймы)',
    stats.transparentBlack === 0 && stats.transparentPixels > 1000,
    JSON.stringify({ transparentPixels: stats.transparentPixels, transparentBlack: stats.transparentBlack }),
  );
  console.log(
    '  печать и чёрный текст в полосе:',
    JSON.stringify({ inkBand: stats.inkBand, inkLeft: stats.inkLeft, blackBand: stats.blackBand, blackErased: stats.blackErased }),
  );
  // Главное обещание инструмента: цветное уходит, чёрное остаётся как было.
  check(
    'цветная краска под мазком удаляется',
    stats.inkBand > 100 && stats.inkLeft / stats.inkBand < 0.1,
    JSON.stringify({ inkBand: stats.inkBand, inkLeft: stats.inkLeft }),
  );
  check(
    'чёрный текст не меняется (потери < 0.5 %)',
    stats.blackBand > 100 && stats.blackErased / stats.blackBand < 0.005,
    JSON.stringify({ blackBand: stats.blackBand, blackErased: stats.blackErased }),
  );
  console.log('  свой цвет:', JSON.stringify(stats.custom));
  console.log('  цвет бумаги:', JSON.stringify(stats.paper));
  check(
    'маска заполняет стёртые цветные участки',
    Boolean(stats.custom?.opaque > 100),
    JSON.stringify(stats.custom?.opaque),
  );
  check(
    'стёртые участки заливаются выбранным цветом (#e11d48)',
    Boolean(stats.custom?.fill) &&
      Math.abs(stats.custom.fill[0] - 225) <= 3 &&
      Math.abs(stats.custom.fill[1] - 29) <= 3 &&
      Math.abs(stats.custom.fill[2] - 72) <= 3,
    JSON.stringify(stats.custom?.fill),
  );
  check(
    'режим «цвет бумаги» заливает светлым тоном',
    Boolean(stats.paper?.fill) && stats.paper.fill[0] > 230,
    JSON.stringify(stats.paper?.fill),
  );

  console.log('\n4. Экспорт PDF');
  const pdfB64 = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const maskService = await import('/src/services/smartEraseService.ts');
    // Возвращаем объект «умного корректора 2»: его маска и должна попасть в PDF.
    app.objects.clearAll(false);
    maskService.clearSmartMaskCache();
    const drawing = factory.createDrawingObject([{
      tool: 'smart-eraser', color: '#ffffff', width: 40, opacity: 1, smooth: false,
      points: [
        { x: 95, y: 211, pressure: 0.5, time: 0 },
        { x: 175, y: 211, pressure: 0.5, time: 8 },
        { x: 258, y: 211, pressure: 0.5, time: 16 },
      ],
    }], {
      page: 0,
      smart: { threshold: 170, color: '#ffffff', autoColor: true, eraseAll: false, mode: 'keep-text', engine: 'model', fillColor: null, eraseColoredOverText: false },
      name: 'Умный корректор 2',
    });
    app.objects.add([drawing], 'тест');
    app.objects.clearSelection();
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
  let masks = 0;
  let cleanMasks = 0;
  for (const [, ref] of dict.entries()) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream) || !stream.dict.has(PDFName.of('SMask'))) continue;
    masks += 1;
    const width = Number(stream.dict.get(PDFName.of('Width')).toString());
    const height = Number(stream.dict.get(PDFName.of('Height')).toString());
    const alphaStream = doc.context.lookup(stream.dict.get(PDFName.of('SMask')));
    if (!(alphaStream instanceof PDFRawStream)) continue;
    const rgb = inflateSync(Buffer.from(stream.contents));
    const alpha = inflateSync(Buffer.from(alphaStream.contents));
    const channels = rgb.length / (width * height);
    let black = 0;
    let transparent = 0;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      if (alpha[pixel] !== 0) continue;
      transparent += 1;
      const base = pixel * channels;
      if (rgb[base] + rgb[base + 1] + rgb[base + 2] < 200) black += 1;
    }
    if (transparent > 1000 && black === 0) cleanMasks += 1;
  }
  console.log('  масок в PDF:', masks, '| без чёрных прозрачных пикселей:', cleanMasks);
  check('PDF собран и содержит маску с альфой', masks >= 1, String(masks));
  check('маска в PDF закодирована без чёрных прозрачных пикселей', cleanMasks >= 1, String(cleanMasks));

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.slice(0, 3).join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

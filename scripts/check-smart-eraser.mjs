/**
 * Проверка «умного корректора»: штрих закрашивает светлый фон, но не трогает
 * тёмный текст.
 *
 *   1. Инструмент есть в списке и включается;
 *   2. Штрих создаёт объект с режимом smart;
 *   3. На холсте появляется маска: светлые пиксели стали цветом заливки,
 *      тёмные (буквы) остались тёмными;
 *   4. В экспортированном PDF маска тоже есть (картинка) и текст цел.
 *
 * Запуск: node scripts/check-smart-eraser.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

const FILL = '#e11d48'; // насыщенный красный — легко отличить от текста и фона
const ROW = { from: 120, to: 430, y: 150 }; // строка «Съешь ещё этих мягких…»

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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9387 });

async function screenPoint(x, y) {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return {
      x: Math.round(rect.left + app.editor.pan.x + ${x} * app.editor.zoom),
      y: Math.round(rect.top + app.editor.pan.y + ${y} * app.editor.zoom),
    };
  })()`);
}

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

  console.log('\n1. Инструмент «Умный корректор»');
  const toolState = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    app.editor.setTool('smart-eraser');
    app.editor.toolOptions.smartEraser.color = ${JSON.stringify(FILL)};
    app.editor.toolOptions.smartEraser.threshold = 200;
    app.editor.toolOptions.smartEraser.width = 26;
    app.editor.toolOptions.smartEraser.autoColor = false;
    // Проверяем режим «сохранить тёмное» — он теперь не по умолчанию.
    app.editor.toolOptions.smartEraser.eraseAll = false;
    app.editor.toolOptions.smartEraser.mode = 'keep-dark';
    app.ui.setRightTab('tool');
    document.activeElement?.blur?.();
    return {
      tool: app.editor.tool,
      fill: app.editor.toolOptions.smartEraser.color,
      threshold: app.editor.toolOptions.smartEraser.threshold,
    };
  })()`);
  console.log('  состояние:', JSON.stringify(toolState));
  check('инструмент включён', toolState.tool === 'smart-eraser', toolState.tool);
  check('цвет заливки из палитры применяется', toolState.fill === FILL, toolState.fill);

  console.log('\n1б. Панель «Инструменты» и курсор');
  // Наводим указатель на холст, чтобы появился кружок-курсор.
  const hover = await screenPoint(200, 150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hover.x, y: hover.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(500);
  const panel = await cdp.evaluate(`(() => {
    const text = (document.body.innerText || '').toLowerCase();
    const cursor = document.querySelector('[data-testid=brush-cursor]');
    const style = cursor ? getComputedStyle(cursor) : null;
    return {
      hasWidthOption: text.includes('ширина штриха'),
      hasColorOption: text.includes('цвет заливки'),
      hasThreshold: text.includes('порог светлого'),
      cursorVisible: Boolean(cursor),
      cursorSize: style ? Number.parseFloat(style.width) : 0,
      zoom: window.__PDF_EDITOR__.editor.zoom,
      width: window.__PDF_EDITOR__.editor.toolOptions.smartEraser.width,
    };
  })()`);
  console.log('  панель и курсор:', JSON.stringify(panel));
  check('в «Инструментах» есть ширина штриха', panel.hasWidthOption === true);
  check('в «Инструментах» есть цвет заливки', panel.hasColorOption === true);
  check('в «Инструментах» есть порог светлого', panel.hasThreshold === true);
  check('курсор-кружок как у корректора', panel.cursorVisible === true);
  check(
    'диаметр курсора равен ширине штриха',
    Math.abs(panel.cursorSize - Math.max(4, panel.width * panel.zoom)) < 1.5,
    `курсор ${panel.cursorSize} px, ожидалось ${(panel.width * panel.zoom).toFixed(1)}`,
  );

  console.log('\n2. Штрих через строку текста');
  const start = await screenPoint(ROW.from, ROW.y);
  const end = await screenPoint(ROW.to, ROW.y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= 10; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(start.x + ((end.x - start.x) * step) / 10),
      y: Math.round(start.y + ((end.y - start.y) * step) / 10),
      button: 'left',
      buttons: 1,
      pointerType: 'mouse',
    });
    await sleep(40);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(2500);

  const objectState = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    if (!object) return null;
    const smart = object.payload.smart;
    return {
      type: object.type,
      smart: Boolean(smart),
      smartColor: smart ? String(smart.color) : null,
      smartThreshold: smart ? Number(smart.threshold) : null,
      strokes: object.payload.strokes.length,
      x: Number(object.x.toFixed(1)),
      y: Number(object.y.toFixed(1)),
      width: Number(object.width.toFixed(1)),
      height: Number(object.height.toFixed(1)),
      name: object.name ?? null,
    };
  })()`);
  console.log('  объект:', JSON.stringify(objectState));
  check('создан объект-рисунок', objectState?.type === 'drawing', String(objectState?.type));
  check('включён режим smart', Boolean(objectState?.smart), JSON.stringify(objectState?.smart));
  check('цвет заливки сохранён в объекте', objectState?.smartColor === FILL, String(objectState?.smartColor));
  check('порог сохранён в объекте', objectState?.smartThreshold === 200, String(objectState?.smartThreshold));

  console.log('\n3. Маска: светлое закрашено, тёмное цело');
  const pixels = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    // Дожидаемся, пока маска построится и попадёт в узел.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const node = window.__PDF_EDITOR_STAGE__.findOne((item) => item.getAttr && item.getAttr('objectId') === object.id);
      const image = node ? node.findOne('Image') : null;
      if (image && image.image()) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const stage = window.__PDF_EDITOR_STAGE__;
    const node = stage.findOne((item) => item.getAttr && item.getAttr('objectId') === object.id);
    const image = node ? node.findOne('Image') : null;
    const maskCanvas = image && image.image() ? image.image() : null;
    let maskRed = 0;
    let maskTransparent = 0;
    let maskPartial = 0;
    if (maskCanvas && maskCanvas.width) {
      const ctx = maskCanvas.getContext('2d');
      const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
      for (let index = 0; index < data.length; index += 4) {
        const alpha = data[index + 3];
        if (alpha < 20) maskTransparent += 1;
        else if (alpha < 250) maskPartial += 1;
        else if (data[index] > 150 && data[index + 1] < 110) maskRed += 1;
      }
    }
    return {
      hasMask: Boolean(maskCanvas),
      maskRed,
      maskTransparent,
      maskPartial,
      maskWidth: maskCanvas ? maskCanvas.width : 0,
    };
  })()`);
  console.log('  маска:', JSON.stringify(pixels));
  check('маска построена', pixels.hasMask === true);
  check('в маске есть закрашенные участки', pixels.maskRed > 500, String(pixels.maskRed));
  check('часть пикселей прозрачна (тёмный текст)', pixels.maskTransparent > 500, String(pixels.maskTransparent));
  check(
    'у маски жёсткая кромка: полупрозрачных пикселей нет (иначе тёмная кайма в PDF)',
    pixels.maskPartial === 0,
    String(pixels.maskPartial),
  );

  const ink = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    // Видимый результат — сумма слоёв: страница PDF + объекты поверх неё.
    const backgroundCanvas = document.querySelectorAll('canvas')[0];
    const objectCanvas = document.querySelectorAll('canvas')[1];
    const canvas = document.createElement('canvas');
    canvas.width = backgroundCanvas.width;
    canvas.height = backgroundCanvas.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(backgroundCanvas, 0, 0);
    ctx.drawImage(objectCanvas, 0, 0);
    const zoom = app.editor.zoom;
    const left = Math.max(0, Math.round(app.editor.pan.x + object.x * zoom));
    const top = Math.max(0, Math.round(app.editor.pan.y + object.y * zoom));
    const width = Math.max(1, Math.round(object.width * zoom));
    const height = Math.max(1, Math.round(object.height * zoom));
    const data = ctx.getImageData(left, top, width, height).data;
    let red = 0;
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const a = data[index + 3];
      if (a < 20) continue;
      if (r > 150 && g < 110 && b > 40 && b < 130) red += 1;
      else if (r < 100 && g < 100 && b < 100) dark += 1;
    }
    return { red, dark };
  })()`);
  console.log('  холст в полосе штриха:', JSON.stringify(ink));
  check('светлый фон закрашен цветом заливки', ink.red > 300, String(ink.red));
  check('тёмный текст остался', ink.dark > 100, String(ink.dark));

  console.log('\n4. Экспорт PDF');
  const exported = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('pdf');
    app.exporter.update({ pageRange: 'current', includeAnnotations: true, includeOriginalContent: true });
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { ok: true, b64: btoa(binary), size: bytes.length };
  })()`);
  check('PDF собран', exported.ok === true, exported.error ?? '');
  if (exported.ok) {
    console.log('  размер PDF:', exported.size, 'байт');

    // Открываем готовый PDF обратно: маска должна быть в файле, текст — цел.
    await cdp.evaluate(`location.hash = '#/'; 'ok'`);
    await sleep(2000);
    await cdp.evaluate(`(async () => {
      const response = await fetch('data:application/pdf;base64,' + ${JSON.stringify(exported.b64)});
      const file = new File([await response.blob()], 'готовый.pdf', { type: 'application/pdf' });
      window.__PDF_EDITOR__.objects.clearAll(false);
      const input = document.querySelector('input[type=file]');
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(5500);
    await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
    await sleep(3000);
    await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
    await sleep(2500);

    const exportedInk = await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const backgroundCanvas = document.querySelectorAll('canvas')[0];
      const objectCanvas = document.querySelectorAll('canvas')[1];
      const canvas = document.createElement('canvas');
      canvas.width = backgroundCanvas.width;
      canvas.height = backgroundCanvas.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(backgroundCanvas, 0, 0);
      if (objectCanvas) ctx.drawImage(objectCanvas, 0, 0);
      const zoom = app.editor.zoom;
      const left = Math.max(0, Math.round(app.editor.pan.x + ${ROW.from - 10} * zoom));
      const top = Math.max(0, Math.round(app.editor.pan.y + ${ROW.y - 20} * zoom));
      const width = Math.max(1, Math.round(${ROW.to - ROW.from + 20} * zoom));
      const height = Math.max(1, Math.round(40 * zoom));
      const data = ctx.getImageData(left, top, width, height).data;
      let red = 0;
      let dark = 0;
      for (let index = 0; index < data.length; index += 4) {
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        if (r > 150 && g < 110 && b > 40 && b < 130) red += 1;
        else if (r < 100 && g < 100 && b < 100) dark += 1;
      }
      return { red, dark };
    })()`);
    console.log('  в готовом PDF:', JSON.stringify(exportedInk));
    check('маска попала в экспортированный PDF', exportedInk.red > 300, String(exportedInk.red));
    check('тёмный текст в PDF не закрашен', exportedInk.dark > 100, String(exportedInk.dark));

    console.log('\n5. Растровый экспорт (JPEG) тоже содержит маску');
    const raster = await cdp.evaluate(`(async () => {
      // Возвращаемся в редактор с нашим документом и экспортируем JPEG.
      const app = window.__PDF_EDITOR__;
      const factory = await import('/src/services/objectFactory.ts');
      app.objects.clearAll(false);
      app.editor.setTool('smart-eraser');
      app.editor.toolOptions.smartEraser.color = '${FILL}';
      app.editor.toolOptions.smartEraser.threshold = 200;
      app.editor.toolOptions.smartEraser.width = 26;
      // Штрих строим напрямую фабрикой: та же геометрия, что даёт мышь.
      const stroke = {
        tool: 'smart-eraser', color: '${FILL}', width: 26, opacity: 1, smooth: false,
        points: [
          { x: 150, y: 150, pressure: 0.5, time: 0 },
          { x: 250, y: 150, pressure: 0.5, time: 10 },
          { x: 350, y: 150, pressure: 0.5, time: 20 },
        ],
      };
      const drawing = factory.createDrawingObject([stroke], {
        page: 0,
        smart: { threshold: 200, color: '${FILL}', autoColor: false, eraseAll: false, mode: 'keep-dark' },
        name: 'Умный корректор',
      });
      if (!drawing) return { ok: false, error: 'не создан объект' };
      app.objects.add([drawing], 'тест');
      app.objects.clearSelection();
      app.exporter.setFormat('jpeg');
      app.exporter.update({ pageRange: 'current', dpi: 96, scale: 1, quality: 0.95, zip: false, singleImage: true });
      const result = await app.exporter.run({ download: false });
      if (!result.ok) return { ok: false, error: result.error };
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return { ok: true, b64: btoa(binary) };
    })()`);
    check('JPEG собран', raster.ok === true, raster.error ?? '');
    if (raster.ok) {
      const jpegInk = await cdp.evaluate(`(async () => {
        const image = new Image();
        image.src = 'data:image/jpeg;base64,' + ${JSON.stringify(raster.b64)};
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let red = 0;
        let dark = 0;
        for (let index = 0; index < data.length; index += 4) {
          const r = data[index];
          const g = data[index + 1];
          const b = data[index + 2];
          if (r > 150 && g < 120 && b > 40 && b < 140) red += 1;
          else if (r < 100 && g < 100 && b < 100) dark += 1;
        }
        return { width: canvas.width, height: canvas.height, red, dark };
      })()`);
      console.log('  JPEG:', JSON.stringify(jpegInk));
      check('в JPEG есть закрашенная область', jpegInk.red > 300, String(jpegInk.red));
      check('в JPEG текст под штрихом цел', jpegInk.dark > 100, String(jpegInk.dark));
    }

    console.log('\n6. Края маски без чёрной каймы');
    const edges = await cdp.evaluate(`(async () => {
      const app = window.__PDF_EDITOR__;
      const object = app.objects.objects.find((item) => item.type === 'drawing');
      if (!object) return null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const node = window.__PDF_EDITOR_STAGE__.findOne((item) => item.getAttr && item.getAttr('objectId') === object.id);
        const image = node ? node.findOne('Image') : null;
        if (image && image.image()) {
          const canvas = image.image();
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let partial = 0;
          let darkRgb = 0;
          for (let index = 0; index < data.length; index += 4) {
            const alpha = data[index + 3];
            if (alpha === 0 || alpha === 255) continue;
            partial += 1;
            if (data[index] < 40 && data[index + 1] < 40 && data[index + 2] < 40) darkRgb += 1;
          }
          return { partial, darkRgb };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return null;
    })()`);
    console.log('  края маски:', JSON.stringify(edges));
    check(
      'на краях маски нет чёрного цвета (кайма в PDF)',
      edges !== null && edges.darkRgb === 0,
      JSON.stringify(edges),
    );

    console.log('\n6б. Режим «Стирать всё под мазком»');
    const eraseAllStats = await cdp.evaluate(`(async () => {
      const app = window.__PDF_EDITOR__;
      const factory = await import('/src/services/objectFactory.ts');
      app.objects.clearAll(false);
      const build = (eraseAll) => factory.createDrawingObject([{
        tool: 'smart-eraser', color: '#ffffff', width: 26, opacity: 1, smooth: false,
        points: [
          { x: 120, y: 150, pressure: 0.5, time: 0 },
          { x: 260, y: 150, pressure: 0.5, time: 10 },
          { x: 420, y: 150, pressure: 0.5, time: 20 },
        ],
      }], { page: 0, smart: { threshold: 200, color: '#ffffff', autoColor: false, mode: eraseAll ? 'erase-all' : 'keep-dark' }, name: 'Умный корректор' });
      const read = async (object) => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const node = window.__PDF_EDITOR_STAGE__.findOne((item) => item.getAttr && item.getAttr('objectId') === object.id);
          const image = node ? node.findOne('Image') : null;
          if (image && image.image()) {
            const data = image.image().getContext('2d').getImageData(0, 0, image.image().width, image.image().height).data;
            let opaque = 0;
            for (let index = 0; index < data.length; index += 4) if (data[index + 3] > 200) opaque += 1;
            return opaque;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return 0;
      };
      const keep = build(false);
      app.objects.add([keep], 'тест');
      app.objects.clearSelection();
      const kept = await read(keep);
      app.objects.clearAll(false);
      const all = build(true);
      app.objects.add([all], 'тест');
      app.objects.clearSelection();
      const erased = await read(all);
      return { kept, erased };
    })()`);
    console.log('  пикселей заливки: с сохранением текста', eraseAllStats.kept, ', со стиранием всего', eraseAllStats.erased);
    check(
      '«Стирать всё» покрывает больше, чем режим сохранения текста',
      eraseAllStats.erased > eraseAllStats.kept,
      JSON.stringify(eraseAllStats),
    );

    console.log('\n7. Авто-цвет: заливка под тон бумаги');
    const auto = await cdp.evaluate(`(async () => {
      const app = window.__PDF_EDITOR__;
      const factory = await import('/src/services/objectFactory.ts');
      app.objects.clearAll(false);
      // Серая «бумага» под штрихом: авто-режим должен взять её тон, а не белый.
      const drawing = factory.createDrawingObject([{
        tool: 'smart-eraser', color: '#ffffff', width: 24, opacity: 1, smooth: false,
        points: [
          { x: 130, y: 160, pressure: 0.5, time: 0 },
          { x: 200, y: 160, pressure: 0.5, time: 10 },
          { x: 270, y: 160, pressure: 0.5, time: 20 },
        ],
      }], {
        page: 0,
        // Палитра — красная, но при авто-режиме заливка должна взять тон бумаги
        // страницы (в тестовом PDF бумага белая).
        smart: { threshold: 200, color: '#e11d48', autoColor: true, eraseAll: false, mode: 'keep-dark' },
        name: 'Умный корректор',
      });
      app.objects.add([drawing], 'тест');
      app.objects.clearSelection();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const node = window.__PDF_EDITOR_STAGE__.findOne((item) => item.getAttr && item.getAttr('objectId') === drawing.id);
        const image = node ? node.findOne('Image') : null;
        if (image && image.image()) {
          const canvas = image.image();
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let opaque = 0;
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          for (let index = 0; index < data.length; index += 4) {
            if (data[index + 3] < 200) continue;
            opaque += 1;
            sumR += data[index];
            sumG += data[index + 1];
            sumB += data[index + 2];
          }
          return opaque > 0
            ? { opaque, r: Math.round(sumR / opaque), g: Math.round(sumG / opaque), b: Math.round(sumB / opaque) }
            : { opaque: 0 };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return { opaque: 0 };
    })()`);
    console.log('  авто-заливка:', JSON.stringify(auto));
    check(
      'на чистой бумаге мазок почти ничего не закрашивает (нет пятна)',
      (auto.opaque ?? 0) < 1500,
      JSON.stringify(auto),
    );
    check(
      'заливка всё равно идёт тоном бумаги',
      (auto.opaque ?? 0) === 0 || (auto.r > 240 && auto.g > 240 && auto.b > 240),
      JSON.stringify(auto),
    );

    await cdp.screenshot(resolvePath(TMP, 'smart-eraser.png'));
  }
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

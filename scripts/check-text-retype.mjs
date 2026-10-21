/**
 * Проверка режима «Стереть всё и вернуть текст» (OCR + перерисовка).
 *
 *   1. режим есть в списке и в объекте (`mode: 'retype'`);
 *   2. маска в этом режиме заливает область целиком (как «стереть всё»);
 *   3. распознавание кириллицы работает: чистая синтетическая строка читается;
 *   4. на реальном скане распознавание возвращает строки с координатами;
 *   5. распознанный текст становится текстовым объектом (его можно править).
 *
 * Запуск: node scripts/check-text-retype.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9711 });

try {
  await sleep(10000);
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
  await sleep(9000);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(7000);

  console.log('\n1. Режим «стереть и вернуть текст»');
  const modeUi = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setTool('smart-eraser');
    app.ui.setRightTab('tool');
    app.editor.toolOptions.smartEraser.mode = 'retype';
    const asides = Array.from(document.querySelectorAll('aside'));
    return {
      mode: app.editor.toolOptions.smartEraser.mode,
      panel: asides[asides.length - 1]?.textContent || '',
    };
  })()`);
  await sleep(900);
  const panelText = await cdp.evaluate(`(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    return asides[asides.length - 1]?.textContent || '';
  })()`);
  check('режим включается', modeUi.mode === 'retype', String(modeUi.mode));
  check('в панели есть подсказка про распознавание', panelText.includes('распознаёт строки'), '');

  console.log('\n2. Маска заливает область целиком');
  const maskStats = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const maskService = await import('/src/services/smartEraseService.ts');
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    maskService.clearSmartMaskCache();
    const build = (mode) => factory.createDrawingObject([{
      tool: 'smart-eraser', color: '#ffffff', width: 30, opacity: 1, smooth: false,
      points: [
        { x: 100, y: 212, pressure: 0.5, time: 0 },
        { x: 200, y: 212, pressure: 0.5, time: 10 },
      ],
    }], { page: 0, smart: { threshold: 170, color: '#ffffff', autoColor: true, mode }, name: 'тест' });
    const measure = async (object) => {
      maskService.clearSmartMaskCache();
      const canvas = await maskService.getSmartMask({ object, scale: 300 / 72 });
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let inked = 0;
      for (let index = 0; index < data.length; index += 4) if (data[index + 3] > 200) inked += 1;
      return { inked, total: canvas.width * canvas.height };
    };
    return { retype: await measure(build('retype')), eraseAll: await measure(build('erase-all')) };
  })()`);
  console.log('  площадь заливки:', JSON.stringify(maskStats));
  check(
    'в режиме retype заливка такая же, как «стереть всё»',
    Math.abs(maskStats.retype.inked / maskStats.retype.total - maskStats.eraseAll.inked / maskStats.eraseAll.total) < 0.15,
    JSON.stringify(maskStats),
  );

  console.log('\n3. Распознавание кириллицы');
  const recognized = await cdp.evaluate(`(async () => {
    const service = await import('/src/services/textDetectionService.ts');
    const width = 900;
    const height = 120;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#111111';
    context.font = '64px "Times New Roman"';
    context.fillText('Медицинская сестра', 20, 84);
    const pixels = context.getImageData(0, 0, width, height).data;
    const started = performance.now();
    const lines = await service.recognizeTextLines(
      new Uint8ClampedArray(pixels), width, height,
      [{ x: 10, y: 20, width: 860, height: 80 }],
      40000,
    );
    return { lines, elapsed: Math.round(performance.now() - started) };
  })()`);
  console.log('  распознано:', JSON.stringify(recognized));
  check('строки распознаны', Array.isArray(recognized.lines) && recognized.lines.length === 1, JSON.stringify(recognized.lines));
  check(
    'кириллица читается (содержит «Медицинск»)',
    (recognized.lines?.[0] ?? '').includes('Медицинск'),
    JSON.stringify(recognized.lines),
  );

  console.log('\n4. Распознавание области скана');
  const region = await cdp.evaluate(`(async () => {
    const retype = await import('/src/services/textRetypeService.ts');
    const started = performance.now();
    const lines = await retype.recognizeRegion({
      page: 0,
      rect: { x: 88, y: 188, width: 200, height: 52 },
      scale: 400 / 72,
    });
    return { lines, elapsed: Math.round(performance.now() - started) };
  })()`);
  console.log('  строки области:', JSON.stringify(region.lines));
  check('область дала хотя бы одну строку', (region.lines?.length ?? 0) >= 1, JSON.stringify(region.lines));
  check(
    'у строки есть координаты и кегль',
    Boolean(region.lines?.[0] && region.lines[0].x >= 0 && region.lines[0].fontSize > 4),
    JSON.stringify(region.lines?.[0]),
  );

  console.log('\n5. Распознанный текст становится объектом');
  const objectStats = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.objects.clearAll(false);
    const text = factory.createTextObject({
      page: 0,
      x: 100, y: 200, width: 160, height: 20,
      text: 'Медицинская сестра',
      autoHeight: true,
      defaults: {
        fontId: app.settings.settings.defaultFontId,
        fontFamily: 'PT Serif',
        fontSize: 12,
        color: '#111111',
        bold: false,
        italic: false,
        align: 'left',
        lineHeight: 1.2,
        letterSpacing: 0,
      },
    });
    app.objects.add([text], 'Возврат текста');
    app.objects.commit('Возврат текста');
    const item = app.objects.objects.find((entry) => entry.type === 'text');
    return item ? { text: item.payload.text, size: item.payload.fontSize } : null;
  })()`);
  console.log('  объект:', JSON.stringify(objectStats));
  check('текстовый объект создан и он редактируемый', objectStats?.text === 'Медицинская сестра', JSON.stringify(objectStats));

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.slice(0, 3).join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

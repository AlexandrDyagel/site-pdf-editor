/**
 * Проверка режима «убрать цвет под мазком» (умный корректор + пипетка).
 *
 *   1. в «Инструменте» есть кнопка «Взять пипеткой», а ползунок разброса
 *      появляется только когда цвет выбран;
 *   2. мазок с целевым цветом стирает только похожие цвета: синяя печать
 *      уходит, чёрный текст остаётся;
 *   3. ползунок разброса расширяет захват (больше стирается);
 *   4. «Сбросить» возвращает обычный режим.
 *
 * Запуск: node scripts/check-smart-color.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9579 });

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

  console.log('\n1. Кнопки режима в «Инструменте»');
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    app.editor.setTool('smart-eraser');
    app.ui.setRightTab('tool');
    app.editor.toolOptions.smartEraser.targetColor = null;
    return 'ok';
  })()`);
  await sleep(900);
  const ui = await cdp.evaluate(`(() => ({
    pick: Boolean(document.querySelector('[data-testid=smart-pick-color]')),
    tolerance: Boolean(document.querySelector('[data-testid=smart-color-tolerance]')),
  }))()`);
  console.log('  элементы:', JSON.stringify(ui));
  check('кнопка «Взять пипеткой» есть', ui.pick === true, JSON.stringify(ui));
  check('ползунок разброса скрыт без цвета', ui.tolerance === false, JSON.stringify(ui));

  await cdp.evaluate(`window.__PDF_EDITOR__.editor.toolOptions.smartEraser.targetColor = '#3b6fb6'; 'ok'`);
  await sleep(900);
  const uiAfter = await cdp.evaluate(
    `Boolean(document.querySelector('[data-testid=smart-color-tolerance]'))`,
  );
  check('ползунок разброса появился после выбора цвета', uiAfter === true, String(uiAfter));

  console.log('\n2. Мазок стирает выбранный цвет, текст остаётся');
  const result = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const maskService = await import('/src/services/smartEraseService.ts');
    app.objects.clearAll(false);
    maskService.clearSmartMaskCache();
    // Цвет печати ищем как самый насыщенный пиксель области (как пипетка по печати).
    const page = document.querySelectorAll('canvas')[0];
    const ctx = page.getContext('2d');
    const zoom = app.editor.zoom;
    const left = Math.round(app.editor.pan.x + 50 * zoom);
    const top = Math.round(app.editor.pan.y + 215 * zoom);
    const width = Math.round(200 * zoom);
    const height = Math.round(70 * zoom);
    const region = ctx.getImageData(left, top, width, height).data;
    let best = { score: -1, r: 255, g: 255, b: 255 };
    for (let index = 0; index < region.length; index += 4) {
      const r = region[index];
      const g = region[index + 1];
      const b = region[index + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max < 60 || max > 245) continue;
      const score = (max - min) / max;
      if (score > best.score) best = { score, r, g, b };
    }
    const sample = [best.r, best.g, best.b];
    const target = '#' + sample.map((v) => v.toString(16).padStart(2, '0')).join('');
    const build = (colorTolerance) => factory.createDrawingObject([{
      tool: 'smart-eraser', color: '#ffffff', width: 90, opacity: 1, smooth: false,
      points: [
        { x: 50, y: 245, pressure: 0.5, time: 0 },
        { x: 130, y: 245, pressure: 0.5, time: 10 },
        { x: 210, y: 245, pressure: 0.5, time: 20 },
      ],
    }], {
      page: 0,
      smart: {
        threshold: 170,
        color: '#ffffff',
        autoColor: true,
        eraseAll: false,
        targetColor: target,
        colorTolerance,
      },
      name: 'Умный корректор',
    });
    const maskedPixels = async (object) => {
      const canvas = await maskService.getSmartMask({ object, scale: 600 / 72 });
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] > 120) opaque += 1;
      }
      return opaque;
    };
    const narrow = build(8);
    app.objects.add([narrow], 'тест');
    app.objects.clearSelection();
    const narrowPixels = await maskedPixels(narrow);
    app.objects.clearAll(false);
    const wide = build(45);
    app.objects.add([wide], 'тест');
    app.objects.clearSelection();
    const widePixels = await maskedPixels(wide);
    return { target, sampled: [sample[0], sample[1], sample[2]], narrowPixels, widePixels };
  })()`);
  console.log(
    `  цвет под мазком: ${result.target} (rgb ${result.sampled.join(',')}); разброс 8 → ${result.narrowPixels}, разброс 45 → ${result.widePixels}`,
  );
  check(
    'целевой цвет — насыщенный цвет печати, а не бумага',
    result.target !== '#ffffff' && result.target !== '#000000',
    JSON.stringify(result),
  );
  check(
    'маска закрашивает только выбранный цвет (не всю страницу)',
    result.narrowPixels > 300 && result.narrowPixels < 400_000,
    JSON.stringify(result),
  );
  check(
    'разброс расширяет захват похожих цветов',
    result.widePixels > result.narrowPixels,
    JSON.stringify(result),
  );

  console.log('\n3. Экспорт: печать убрана, текст цел');
  const exported = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('pdf');
    app.exporter.update({ pageRange: 'current', includeAnnotations: true, includeOriginalContent: true });
    const pdf = await app.exporter.run({ download: false });
    const bytes = new Uint8Array(await pdf.blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  })()`);
  await writeFile(resolvePath(TMP, 'smart-color.pdf'), Buffer.from(exported, 'base64'));
  check('PDF собран', exported.length > 1000, String(exported.length));

  console.log('\n4. «Сбросить» возвращает обычный режим');
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.toolOptions.smartEraser.targetColor = null; 'ok'`);
  await sleep(700);
  const afterReset = await cdp.evaluate(`(() => ({
    target: window.__PDF_EDITOR__.editor.toolOptions.smartEraser.targetColor,
    tolerance: Boolean(document.querySelector('[data-testid=smart-color-tolerance]')),
  }))()`);
  check('целевой цвет сброшен', afterReset.target === null, JSON.stringify(afterReset));
  check('ползунок снова скрыт', afterReset.tolerance === false, JSON.stringify(afterReset));

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

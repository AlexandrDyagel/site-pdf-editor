/**
 * Проверка пипетки и максимального зума.
 *
 *   1. Зум доходит до 3000% (раньше упирался в 800%);
 *   2. в палитре цветов есть кнопка пипетки;
 *   3. клик пипеткой по холсту берёт цвет пикселя и подставляет HEX в палитру;
 *   4. после выбора пипетка выключается (следующий клик уже работает как обычно).
 *
 * Запуск: node scripts/check-eyedropper.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

const FILL = '#22cc88';
const TARGET = { x: 300, y: 420 }; // центр закрашенного прямоугольника

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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9407 });

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
  await sleep(3000);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await cdp.evaluate(`Boolean(document.querySelector('input[type=file]'))`)) break;
    await sleep(400);
  }
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
  await sleep(5000);

  console.log('\n1. Максимальный зум 3000%');
  const zoom = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setZoomPercent(3000);
    return { zoom: app.editor.zoom, percent: app.editor.zoomPercent };
  })()`);
  console.log('  зум:', JSON.stringify(zoom));
  check('зум 3000% применяется', Math.abs(zoom.zoom - 30) < 0.001, String(zoom.zoom));
  const exceeding = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setZoomPercent(5000);
    const result = app.editor.zoom;
    app.editor.fitToWidth();
    return result;
  })()`);
  check('выше 3000% не пускает', Math.abs(exceeding - 30) < 0.001, String(exceeding));
  const presets = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setZoomPercent(3000);
    const select = document.querySelector('select');
    const values = select ? Array.from(select.options).map((option) => option.textContent.trim()) : [];
    app.editor.fitToWidth();
    return values;
  })()`);
  check('в списке масштабов есть 3000%', presets.includes('3000%'), JSON.stringify(presets));

  console.log('\n2. Пипетка в палитре цветов');
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    // Закрашенный прямоугольник известного цвета — по нему и «щёлкнем» пипеткой.
    const rect = factory.createShapeObject('rect', {
      page: 0, x: ${TARGET.x - 60}, y: ${TARGET.y - 40}, width: 120, height: 80,
      defaults: { stroke: null, strokeWidth: 0, fill: ${JSON.stringify(FILL)} },
    });
    app.objects.add([rect], 'тест');
    app.objects.select([]);
    app.editor.setTool('marker');
    app.ui.setRightTab('tool');
    app.editor.toolOptions.marker.color = '#000000';
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(1500);

  const trigger = await cdp.evaluate(`(() => {
    const button = document.querySelector('[data-testid=color-trigger]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(600);
  const hasEyedropper = await cdp.evaluate(`(() => {
    const button = document.querySelector('[data-testid=color-eyedropper]');
    return button ? (button.textContent || '').trim() : null;
  })()`);
  console.log('  кнопка пипетки:', JSON.stringify(hasEyedropper));
  check('палитра открылась', trigger === true);
  check('в палитре есть кнопка пипетки', Boolean(hasEyedropper), String(hasEyedropper));

  const started = await cdp.evaluate(`(() => {
    const button = document.querySelector('[data-testid=color-eyedropper]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(700);
  check('пипетка включилась', started === true);

  const hint = await cdp.evaluate(`(() => {
    const element = document.querySelector('[data-testid=eyedropper-hint]');
    return element ? (element.textContent || '').trim().slice(0, 80) : null;
  })()`);
  console.log('  подсказка:', JSON.stringify(hint));
  check('показана подсказка пипетки', Boolean(hint), String(hint));

  const point = await screenPoint(TARGET.x, TARGET.y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(300);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(900);

  const picked = await cdp.evaluate(`(() => ({
    color: window.__PDF_EDITOR__.editor.toolOptions.marker.color,
    objects: window.__PDF_EDITOR__.objects.objects.length,
    hintGone: !document.querySelector('[data-testid=eyedropper-hint]'),
  }))()`);
  console.log('  результат:', JSON.stringify(picked));
  check(
    'цвет взят с холста',
    String(picked.color).toLowerCase() === FILL,
    `${picked.color} вместо ${FILL}`,
  );
  check('после выбора пипетка выключилась', picked.hintGone === true);
  check('клик пипеткой не создал объект', picked.objects === 1, String(picked.objects));

  await cdp.screenshot(resolvePath(TMP, 'eyedropper.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

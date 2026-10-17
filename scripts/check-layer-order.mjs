/**
 * Проверка порядка слоёв: «Поверх» / «Вниз» в свойствах и кнопки в панели «Слои».
 *
 * Главное здесь — не значения z-index в сторе, а ЧТО ВИДНО на холсте:
 * складываем три цветных прямоугольника друг на друга и проверяем цвет
 * пикселя в центре после каждого действия.
 *
 * Запуск: node scripts/check-layer-order.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const URL_APP = 'http://127.0.0.1:5173/';
const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9363 });

/** Цвет пикселя в центре наложения прямоугольников (слой объектов). */
async function topColor() {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const ctx = document.querySelectorAll('canvas')[1].getContext('2d');
    const x = Math.round(app.editor.pan.x + 200 * app.editor.zoom);
    const y = Math.round(app.editor.pan.y + 350 * app.editor.zoom);
    const data = ctx.getImageData(x, y, 1, 1).data;
    const [r, g, b, a] = data;
    if (a < 20) return 'none';
    if (r > 150 && g < 110 && b < 110) return 'red';
    if (g > 120 && r < 120 && b < 120) return 'green';
    if (b > 150 && r < 120 && g < 160) return 'blue';
    return \`rgb(\${r},\${g},\${b})\`;
  })()`);
}

/** Порядок строк в панели слоёв (сверху вниз) и z-index объектов. */
async function layersState() {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const rows = Array.from(document.querySelectorAll('[data-layer-id]')).map((row) => ({
      id: row.getAttribute('data-layer-id'),
      z: app.objects.byId(row.getAttribute('data-layer-id'))?.zIndex ?? null,
    }));
    return {
      rows,
      store: app.objects.forPage(app.editor.currentPage).map((obj) => ({ id: obj.id, name: obj.name, z: obj.zIndex })),
    };
  })()`);
}

/** Клик по кнопке с заданным текстом в любой боковой панели. */
async function clickButton(text) {
  return cdp.evaluate(`(() => {
    const roots = Array.from(document.querySelectorAll('aside'));
    const buttons = roots.flatMap((root) => Array.from(root.querySelectorAll('button')));
    const button = buttons.find((element) => (element.textContent || '').trim() === ${JSON.stringify(text)});
    if (!button) return false;
    button.click();
    return true;
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

  console.log('\n1. Три прямоугольника друг на друге');
  const created = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    const factory = await import('/src/services/objectFactory.ts');
    const make = (fill, name) => factory.createShapeObject('rect', {
      page: 0, x: 120, y: 300, width: 160, height: 100, name,
      defaults: { stroke: fill, strokeWidth: 1, fill },
    });
    const red = make('#dc2626', 'Красный');
    const green = make('#16a34a', 'Зелёный');
    const blue = make('#2563eb', 'Синий');
    app.objects.add([red, green, blue], 'тест');
    app.objects.select([red.id]);
    app.editor.setTool('select');
    app.ui.setRightTab('properties');
    return { red: red.id, green: green.id, blue: blue.id };
  })()`);
  await sleep(1200);
  const initialColor = await topColor();
  console.log('  цвет сверху:', initialColor);
  check('сверху последний добавленный (синий)', initialColor === 'blue', initialColor);

  console.log('\n2. «Поверх» в свойствах объекта');
  const clickedTop = await clickButton('Поверх');
  await sleep(1200);
  const afterTop = await topColor();
  console.log('  цвет сверху:', afterTop);
  check('кнопка «Поверх» найдена в свойствах', clickedTop === true);
  check('объект поднялся поверх всех (виден красный)', afterTop === 'red', afterTop);

  console.log('\n3. «Вниз» в свойствах объекта');
  const clickedBottom = await clickButton('Вниз');
  await sleep(1200);
  const afterBottom = await topColor();
  console.log('  цвет сверху:', afterBottom);
  check('кнопка «Вниз» найдена в свойствах', clickedBottom === true);
  check('объект ушёл под остальные', afterBottom !== 'red', afterBottom);

  console.log('\n4. Кнопки порядка в панели «Слои»');
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.setRightTab('layers'); 'ok'`);
  await sleep(1200);
  const rowsBefore = await layersState();
  console.log('  строки панели:', JSON.stringify(rowsBefore.rows));
  check('в панели три строки', rowsBefore.rows.length === 3, `строк: ${rowsBefore.rows.length}`);
  check(
    'порядок строк соответствует z-index (сверху — верхний слой)',
    rowsBefore.rows.every((row) => row.z !== null) &&
      rowsBefore.rows[0].z >= rowsBefore.rows[1].z &&
      rowsBefore.rows[1].z >= rowsBefore.rows[2].z,
    JSON.stringify(rowsBefore.rows),
  );

  // Поднимаем второй сверху слой кнопкой «Выше» в его строке.
  const target = rowsBefore.rows[1];
  const colorsByName = { 'Красный': 'red', 'Зелёный': 'green', 'Синий': 'blue' };
  const targetColor = colorsByName[rowsBefore.store.find((obj) => obj.id === target.id)?.name ?? ''];
  const clickedUp = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-layer-id=' + ${JSON.stringify(JSON.stringify(target.id))} + ']');
    if (!row) return false;
    const button = Array.from(row.querySelectorAll('button')).find((element) => element.getAttribute('title') === 'Выше');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(1200);
  const rowsAfter = await layersState();
  const colorAfterUp = await topColor();
  console.log('  строки после «Выше»:', JSON.stringify(rowsAfter.rows), 'цвет сверху:', colorAfterUp);
  check('кнопка «Выше» есть в строке слоя', clickedUp === true);
  check(
    'слой поднялся наверх в списке',
    rowsAfter.rows[0].id === target.id,
    JSON.stringify(rowsAfter.rows),
  );
  check(
    'поднятый слой виден сверху на холсте',
    colorAfterUp === targetColor,
    `сверху ${colorAfterUp}, ожидался ${targetColor}`,
  );

  // Опускаем его же кнопкой «Ниже».
  const clickedDown = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-layer-id=' + ${JSON.stringify(JSON.stringify(target.id))} + ']');
    if (!row) return false;
    const button = Array.from(row.querySelectorAll('button')).find((element) => element.getAttribute('title') === 'Ниже');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(1200);
  const rowsAfterDown = await layersState();
  const colorAfterDown = await topColor();
  console.log('  строки после «Ниже»:', JSON.stringify(rowsAfterDown.rows), 'цвет сверху:', colorAfterDown);
  check('кнопка «Ниже» есть в строке слоя', clickedDown === true);
  check(
    'слой опустился обратно',
    rowsAfterDown.rows[1].id === target.id,
    JSON.stringify(rowsAfterDown.rows),
  );
  check(
    'после «Ниже» сверху снова другой слой',
    colorAfterDown !== targetColor,
    `сверху ${colorAfterDown}`,
  );

  console.log('\n5. Подсказки у новых кнопок');
  const tooltipText = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-layer-id=' + ${JSON.stringify(JSON.stringify(target.id))} + ']');
    const button = Array.from(row.querySelectorAll('button')).find((element) => element.getAttribute('title') === 'Выше');
    const rect = button.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tooltipText.x, y: tooltipText.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(600);
  const tooltip = await cdp.evaluate(`(() => {
    const element = document.querySelector('[role=tooltip]');
    return element ? (element.textContent || '').trim() : null;
  })()`);
  console.log('  подсказка:', JSON.stringify(tooltip));
  check('у кнопки «Выше» появляется подсказка', Boolean(tooltip && /Выше/.test(tooltip)), String(tooltip));

  console.log('\n6. Кнопки порядка внизу панели слоёв');
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.objects.select([${JSON.stringify(created.red)}]);
    return 'ok';
  })()`);
  await sleep(700);
  const clickByTitle = async (title) => cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('aside button')).find((element) => element.getAttribute('title') === ${JSON.stringify(title)});
    if (!button) return false;
    button.click();
    return true;
  })()`);

  const frontClicked = await clickByTitle('Поверх всех');
  await sleep(1000);
  const afterFront = await topColor();
  check('кнопка «Поверх всех» работает', frontClicked === true && afterFront === 'red', afterFront);

  const backClicked = await clickByTitle('Позади всех');
  await sleep(1000);
  const afterBack = await topColor();
  check('кнопка «Позади всех» работает', backClicked === true && afterBack !== 'red', afterBack);

  const upClicked = await clickByTitle('Поднять');
  await sleep(1000);
  const afterUp = await topColor();
  check('кнопка «Поднять» работает', upClicked === true && afterUp !== 'none', afterUp);

  await cdp.screenshot(resolvePath(TMP, 'layers-order.png'));

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

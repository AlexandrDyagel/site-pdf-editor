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
  // Ждём, пока приложение отрисует область загрузки: сразу после навигации
  // поле файла может быть ещё не в DOM (а при HMR — пересоздаваться).
  let inputReady = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    inputReady = await cdp.evaluate(`Boolean(document.querySelector('input[type=file]'))`);
    if (inputReady) break;
    await sleep(400);
  }
  if (!inputReady) throw new Error('Поле выбора файла не появилось');

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

  console.log('\n6. Без выделения: кнопки в строках работают и понятно отвечают');
  await cdp.evaluate(`window.__PDF_EDITOR__.objects.select([]); 'ok'`);
  await sleep(900);
  const noSelection = await layersState();
  const selectedCount = await cdp.evaluate(`window.__PDF_EDITOR__.objects.selectedIds.length`);
  console.log('  строки без выделения:', JSON.stringify(noSelection.rows), 'выделено:', selectedCount);
  check('выделения нет', selectedCount === 0);

  const readToasts = () =>
    cdp.evaluate(`(() => (window.__PDF_EDITOR__.ui.toasts ?? []).map((item) => item.title ?? item.text ?? '').join(' | '))()`);

  // Средняя строка: «Выше» работает без выделения объекта.
  const middleId = noSelection.rows[1].id;
  const middleZ = noSelection.rows[1].z;
  const middleUp = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-layer-id=' + ${JSON.stringify(JSON.stringify(noSelection.rows[1].id))} + ']');
    const button = Array.from(row.querySelectorAll('button')).find((element) => element.getAttribute('title') === 'Выше');
    if (!button) return { found: false };
    button.click();
    return { found: true, disabled: button.disabled };
  })()`);
  await sleep(1000);
  const movedWithoutSelection = await cdp.evaluate(`window.__PDF_EDITOR__.objects.byId(${JSON.stringify(middleId)}).zIndex`);
  console.log(`  z-index без выделения: ${middleZ} → ${movedWithoutSelection}`);
  check('кнопка «Выше» не отключена без выделения', middleUp.found === true && middleUp.disabled === false, JSON.stringify(middleUp));
  check('«Выше» работает без выделения объекта', movedWithoutSelection > middleZ, `${middleZ} → ${movedWithoutSelection}`);

  // Верхняя строка: кнопка нажимается и объясняет, что слой уже наверху.
  const topRowId = (await layersState()).rows[0].id;
  const topUp = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-layer-id=' + ${JSON.stringify(JSON.stringify(topRowId))} + ']');
    const button = Array.from(row.querySelectorAll('button')).find((element) => element.getAttribute('title') === 'Выше');
    if (!button) return { found: false };
    button.click();
    return { found: true, disabled: button.disabled };
  })()`);
  await sleep(900);
  const topToast = await readToasts();
  console.log('  уведомление:', JSON.stringify(topToast));
  check('кнопка на верхнем слое не отключена', topUp.found === true && topUp.disabled === false, JSON.stringify(topUp));
  check('на верхнем слое показывается пояснение', /наверху/i.test(topToast), topToast);

  console.log('\n7. Кнопки порядка внизу панели слоёв');
  const clickByTitle = async (title) => cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('aside button')).find((element) => element.getAttribute('title') === ${JSON.stringify(title)});
    if (!button) return { found: false };
    button.click();
    return { found: true, disabled: button.disabled };
  })()`);

  // Без выделения кнопка не «мертва»: подсказывает, что нужно выделить слой.
  const emptyFront = await clickByTitle('Поверх всех');
  await sleep(700);
  const hintToast = await readToasts();
  console.log('  подсказка без выделения:', JSON.stringify(hintToast));
  check('нижняя кнопка не отключена без выделения', emptyFront.found === true && emptyFront.disabled === false, JSON.stringify(emptyFront));
  check('нижняя кнопка просит выделить слой', /не выбран/i.test(hintToast), hintToast);

  // С выделением — работает.
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.objects.select([${JSON.stringify(created.red)}]);
    return 'ok';
  })()`);
  await sleep(800);
  const frontClicked = await clickByTitle('Поверх всех');
  await sleep(1000);
  const afterFront = await topColor();
  check('кнопка «Поверх всех» работает', frontClicked.found === true && afterFront === 'red', afterFront);

  const backClicked = await clickByTitle('Позади всех');
  await sleep(1000);
  const afterBack = await topColor();
  check('кнопка «Позади всех» работает', backClicked.found === true && afterBack !== 'red', afterBack);

  const upClicked = await clickByTitle('Поднять');
  await sleep(1000);
  const afterUp = await topColor();
  check('кнопка «Поднять» работает', upClicked.found === true && afterUp !== 'none', afterUp);

  console.log('\n8. Одинаковые z-index (как в старом проекте)');
  const equalized = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    // Имитируем проект, сохранённый старой версией: у всех объектов z=1.
    for (const object of app.objects.objects) app.objects.patchSilent(object.id, { zIndex: 1 });
    app.objects.select([]);
    return app.objects.forPage(app.editor.currentPage).map((object) => ({ name: object.name, z: object.zIndex }));
  })()`);
  await sleep(1000);
  console.log('  z-index у всех:', JSON.stringify(equalized));
  check('у всех объектов одинаковый z-index', equalized.every((item) => item.z === 1), JSON.stringify(equalized));

  const flatRows = await layersState();
  const flatTarget = flatRows.rows[1];
  const flatColorMap = { 'Красный': 'red', 'Зелёный': 'green', 'Синий': 'blue' };
  const flatTargetColor = flatColorMap[flatRows.store.find((obj) => obj.id === flatTarget.id)?.name ?? ''];
  const flatUp = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-layer-id=' + ${JSON.stringify(JSON.stringify(flatTarget.id))} + ']');
    const button = Array.from(row.querySelectorAll('button')).find((element) => element.getAttribute('title') === 'Выше');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(1200);
  const flatAfter = await layersState();
  const flatColor = await topColor();
  console.log('  после «Выше»:', JSON.stringify(flatAfter.rows), 'цвет сверху:', flatColor);
  check('«Выше» работает при одинаковых z-index', flatUp === true);
  check(
    'слой поднялся наверх и виден на холсте',
    flatAfter.rows[0].id === flatTarget.id && flatColor === flatTargetColor,
    `строки ${JSON.stringify(flatAfter.rows)}, цвет ${flatColor} (ожидался ${flatTargetColor})`,
  );
  check(
    'после сдвига z-index стали уникальными',
    new Set(flatAfter.rows.map((row) => row.z)).size === flatAfter.rows.length,
    JSON.stringify(flatAfter.rows.map((row) => row.z)),
  );

  console.log('\n9. Названия слоёв по инструменту, нумерация и индикатор цвета');
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const make = (kind, fill) => factory.createShapeObject(kind, {
      page: 0, x: 120, y: 300, width: 160, height: 100, name: 'Фигура',
      defaults: { stroke: fill, strokeWidth: 1, fill },
    });
    app.objects.clearAll(false);
    app.objects.add([
      make('rect', '#dc2626'),
      make('rect', '#16a34a'),
      make('ellipse', '#2563eb'),
    ], 'тест');
    app.objects.select([]);
    app.ui.setRightTab('layers');
    return 'ok';
  })()`);
  await sleep(1400);

  const rowsInfo = await cdp.evaluate(`(() => ({
    rows: Array.from(document.querySelectorAll('[data-layer-id]')).map((row) => {
      const labelElement = row.querySelector('[data-layer-label]');
      const colorElement = row.querySelector('[data-layer-color]');
      return {
        label: labelElement ? labelElement.textContent.trim() : '',
        color: colorElement ? getComputedStyle(colorElement).backgroundColor : null,
        hint: row.querySelector('button[title]')?.getAttribute('title') ?? '',
      };
    }),
  }))()`);
  console.log('  строки панели:', JSON.stringify(rowsInfo.rows));
  const panelLabels = rowsInfo.rows.map((row) => row.label);
  check('сверху эллипс', panelLabels[0] === 'Эллипс', JSON.stringify(panelLabels));
  check(
    'одинаковые прямоугольники пронумерованы',
    panelLabels[1] === 'Прямоугольник 2' && panelLabels[2] === 'Прямоугольник 1',
    JSON.stringify(panelLabels),
  );  check(
    'индикаторы цвета соответствуют заливке',
    rowsInfo.rows[0].color === 'rgb(37, 99, 235)' &&
      rowsInfo.rows[1].color === 'rgb(22, 163, 74)' &&
      rowsInfo.rows[2].color === 'rgb(220, 38, 38)',
    JSON.stringify(rowsInfo.rows.map((row) => row.color)),
  );

  // Скриншот панели с названиями и индикаторами.
  await cdp.screenshot(resolvePath(TMP, 'layers-labels.png'));

  // Одиночная фигура остаётся без номера.
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.objects.remove(app.objects.objects.slice(1).map((object) => object.id));
    return 'ok';
  })()`);
  await sleep(1200);
  const singleLabel = await cdp.evaluate(`(() => {
    const element = document.querySelector('[data-layer-label]');
    return element ? element.textContent.trim() : '';
  })()`);
  check('единственная фигура без номера', singleLabel === 'Прямоугольник', singleLabel);

  console.log('\n10. Клик и двойной клик по строке слоя при активном инструменте');
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const make = (kind, fill) => factory.createShapeObject(kind, {
      page: 0, x: 120, y: 300, width: 160, height: 100, name: 'Фигура',
      defaults: { stroke: fill, strokeWidth: 1, fill },
    });
    app.objects.clearAll(false);
    app.objects.add([make('rect', '#dc2626'), make('rect', '#16a34a'), make('ellipse', '#2563eb')], 'тест');
    app.objects.select([]);
    // Активен инструмент «Прямоугольник» (панель при этом уходит на «Инструмент»).
    app.editor.setTool('rect');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(900);
  // Теперь явно открываем вкладку «Слои» и проверяем поведение кликов.
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.setRightTab('layers'); 'ok'`);
  await sleep(900);

  const rowInfo = await cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-layer-id]'));
    const row = rows[1];
    if (!row) return null;
    const label = row.querySelector('[data-layer-label]');
    const box = label.getBoundingClientRect();
    return {
      id: row.getAttribute('data-layer-id'),
      label: label.textContent.trim(),
      x: Math.round(box.left + 30),
      y: Math.round(box.top + box.height / 2),
    };
  })()`);
  console.log('  целевая строка:', JSON.stringify(rowInfo));
  check('строка для проверки найдена', Boolean(rowInfo));

  // Одиночный клик при активном инструменте — остаёмся в «Слоях».
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowInfo.x, y: rowInfo.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rowInfo.x, y: rowInfo.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rowInfo.x, y: rowInfo.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(900);
  const afterSingle = await cdp.evaluate(`(() => ({
    tab: window.__PDF_EDITOR__.ui.rightTab,
    selected: window.__PDF_EDITOR__.objects.selectedIds.length,
    tool: window.__PDF_EDITOR__.editor.tool,
  }))()`);
  console.log('  после одиночного клика:', JSON.stringify(afterSingle));
  check('одиночный клик выделил слой', afterSingle.selected === 1, JSON.stringify(afterSingle));
  check(
    'одиночный клик не переключает вкладку при активном инструменте',
    afterSingle.tab === 'layers',
    JSON.stringify(afterSingle),
  );

  // Двойной клик — открываем «Свойства» с названием слоя.
  for (const clickCount of [1, 2]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rowInfo.x, y: rowInfo.y, button: 'left', buttons: 1, clickCount, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rowInfo.x, y: rowInfo.y, button: 'left', buttons: 0, clickCount, pointerType: 'mouse' });
    await sleep(90);
  }
  await sleep(1000);
  const afterDouble = await cdp.evaluate(`(() => {
    const title = document.querySelector('[data-object-title]');
    return {
      tab: window.__PDF_EDITOR__.ui.rightTab,
      title: title ? title.textContent.trim() : null,
    };
  })()`);
  console.log('  после двойного клика:', JSON.stringify(afterDouble), 'название слоя:', rowInfo.label);
  check('двойной клик открывает «Свойства»', afterDouble.tab === 'properties', JSON.stringify(afterDouble));
  check(
    'заголовок в «Свойствах» совпадает с названием слоя',
    afterDouble.title === rowInfo.label,
    `«${afterDouble.title}» вместо «${rowInfo.label}»`,
  );

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

/**
 * Проверка группировки объектов.
 *
 *   1. Правая кнопка мыши по выделенным объектам на холсте открывает меню
 *      («Сгруппировать», «Удалить»);
 *   2. После «Сгруппировать» объекты получают общий groupId;
 *   3. В «Слоях» появляется строка группы с иконкой папки и вложенными строками;
 *   4. Клик по группе выделяет все её объекты;
 *   5. Группа сворачивается и разворачивается;
 *   6. Правая кнопка мыши по строке в «Слоях» тоже открывает меню, «Удалить»
 *      удаляет всю группу;
 *   7. Клик по одному объекту группы выделяет всю группу.
 *
 * Запуск: node scripts/check-groups.mjs
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9376 });

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

/** Клик правой кнопкой мыши по точке холста (с настоящим событием contextmenu). */
async function rightClick(point) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(600);
}

async function menuState() {
  return cdp.evaluate(`(() => {
    const menu = document.querySelector('[data-testid=object-context-menu]');
    if (!menu) return null;
    return {
      title: (menu.textContent || '').trim().split('\\n')[0],
      actions: Array.from(menu.querySelectorAll('[data-context-action]')).map((button) => ({
        action: button.getAttribute('data-context-action'),
        disabled: Boolean(button.disabled),
      })),
    };
  })()`);
}

async function clickMenuAction(action) {
  return cdp.evaluate(`(() => {
    const button = document.querySelector('[data-testid=object-context-menu] [data-context-action=' + ${JSON.stringify(JSON.stringify(action))} + ']');
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function state() {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return {
      groups: app.objects.objects.map((object) => object.groupId ?? null),
      selected: [...app.objects.selectedIds],
      count: app.objects.objects.length,
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

  const created = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    const make = (kind, x, y) => factory.createShapeObject(kind, {
      page: 0, x, y, width: 120, height: 80,
      defaults: { stroke: '#1d4ed8', strokeWidth: 2, fill: '#dbeafe' },
    });
    const first = make('rect', 140, 120);
    const second = make('ellipse', 300, 140);
    const third = make('rect', 460, 170);
    app.objects.add([first, second, third], 'тест');
    app.objects.select([first.id, second.id]);
    app.editor.setTool('select');
    app.ui.setRightTab('layers');
    document.activeElement?.blur?.();
    return { first: first.id, second: second.id, third: third.id };
  })()`);
  await sleep(1200);

  console.log('\n1. Контекстное меню на холсте');
  // Правая кнопка по первому (выделенному) объекту.
  await rightClick(await screenPoint(200, 160));
  const canvasMenu = await menuState();
  console.log('  меню:', JSON.stringify(canvasMenu));
  check('меню открылось по правой кнопке на холсте', canvasMenu !== null, 'меню не появилось');
  check(
    'в меню есть «Сгруппировать» и «Удалить»',
    Boolean(
      canvasMenu?.actions.some((item) => item.action === 'group') &&
        canvasMenu?.actions.some((item) => item.action === 'remove'),
    ),
    JSON.stringify(canvasMenu?.actions),
  );

  const grouped = await clickMenuAction('group');
  await sleep(900);
  const afterGroup = await state();
  console.log('  после «Сгруппировать»:', JSON.stringify(afterGroup));
  check('пункт «Сгруппировать» сработал', grouped === true);
  check(
    'два объекта получили общий groupId',
    Boolean(afterGroup.groups[0]) && afterGroup.groups[0] === afterGroup.groups[1],
    JSON.stringify(afterGroup.groups),
  );
  check('третий объект остался без группы', afterGroup.groups[2] === null, JSON.stringify(afterGroup.groups));
  check('меню закрылось после действия', (await menuState()) === null);

  console.log('\n2. Группа в «Слоях»');
  const layersView = await cdp.evaluate(`(() => {
    const right = Array.from(document.querySelectorAll('aside')).pop();
    const groupRow = right.querySelector('[data-group-id]');
    const objectRows = Array.from(right.querySelectorAll('[data-layer-id]'));
    return {
      hasGroupRow: Boolean(groupRow),
      groupLabel: groupRow ? (groupRow.querySelector('[data-layer-label]') || {}).textContent : null,
      hasFolderIcon: groupRow ? Boolean(groupRow.querySelector('svg')) : false,
      hasToggle: groupRow ? Boolean(groupRow.querySelector('[data-group-toggle]')) : false,
      objectRows: objectRows.map((row) => ({
        id: row.getAttribute('data-layer-id'),
        padding: getComputedStyle(row).paddingLeft,
      })),
    };
  })()`);
  console.log('  панель:', JSON.stringify(layersView));
  check('появилась строка группы', layersView.hasGroupRow === true);
  check(
    'название группы — «Группа 1»',
    String(layersView.groupLabel || '').trim() === 'Группа 1',
    String(layersView.groupLabel),
  );
  check('у группы есть кнопка сворачивания', layersView.hasToggle === true);
  check(
    'объекты группы вложены (отступ больше)',
    layersView.objectRows.filter((row) => Number.parseFloat(row.padding) >= 18).length >= 2,
    JSON.stringify(layersView.objectRows),
  );

  console.log('\n3. Клик по группе выделяет все объекты');
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.clearSelection();
    return 'ok';
  })()`);
  await sleep(400);
  // Клик по подписи группы в панели (кнопка внутри строки группы).
  const groupClicked = await cdp.evaluate(`(() => {
    const right = Array.from(document.querySelectorAll('aside')).pop();
    const row = right.querySelector('[data-group-id]');
    if (!row) return { ok: false, reason: 'нет строки группы' };
    const label = row.querySelector('[data-layer-label]');
    const button = label ? label.closest('button') : null;
    if (!button) return { ok: false, reason: 'нет кнопки в строке' };
    const rect = row.getBoundingClientRect();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 30, clientY: rect.top + 10 }));
    return { ok: true };
  })()`);
  await sleep(700);
  check('строка группы доступна для клика', groupClicked.ok === true, JSON.stringify(groupClicked));
  const afterGroupClick = await state();
  console.log('  выделено после клика по группе:', JSON.stringify(afterGroupClick.selected));
  check(
    'клик по группе выделил оба объекта',
    afterGroupClick.selected.length === 2 &&
      afterGroupClick.selected.includes(created.first) &&
      afterGroupClick.selected.includes(created.second),
    JSON.stringify(afterGroupClick.selected),
  );

  console.log('\n4. Сворачивание и разворачивание');
  const toggled = await cdp.evaluate(`(() => {
    const right = Array.from(document.querySelectorAll('aside')).pop();
    const toggle = right.querySelector('[data-group-toggle]');
    if (!toggle) return null;
    toggle.click();
    return true;
  })()`);
  await sleep(700);
  const collapsed = await cdp.evaluate(`(() => {
    const right = Array.from(document.querySelectorAll('aside')).pop();
    return {
      groups: right.querySelectorAll('[data-group-id]').length,
      objects: right.querySelectorAll('[data-layer-id]').length,
    };
  })()`);
  console.log('  после сворачивания:', JSON.stringify(collapsed));
  check('кнопка сворачивания сработала', toggled === true);
  check('объекты группы скрыты из списка', collapsed.objects === 1, JSON.stringify(collapsed));
  check('строка группы осталась', collapsed.groups === 1);

  await cdp.evaluate(`(() => {
    const right = Array.from(document.querySelectorAll('aside')).pop();
    right.querySelector('[data-group-toggle]').click();
    return 'ok';
  })()`);
  await sleep(700);
  const expanded = await cdp.evaluate(`(() => {
    const right = Array.from(document.querySelectorAll('aside')).pop();
    return right.querySelectorAll('[data-layer-id]').length;
  })()`);
  check('после разворачивания видны все объекты', expanded === 3, String(expanded));

  console.log('\n5. Контекстное меню в «Слоях» и «Разгруппировать»');
  const rowMenuOpened = await cdp.evaluate(`(() => {
    const right = Array.from(document.querySelectorAll('aside')).pop();
    const row = right.querySelector('[data-group-id]');
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(rect.left + 40),
      clientY: Math.round(rect.top + 10),
    }));
    return true;
  })()`);
  await sleep(600);
  const layerMenu = await menuState();
  console.log('  меню из «Слоёв»:', JSON.stringify(layerMenu));
  check('меню открылось по правой кнопке в «Слоях»', layerMenu !== null);
  check(
    'в меню группы есть «Разгруппировать»',
    Boolean(layerMenu?.actions.some((item) => item.action === 'ungroup')),
    JSON.stringify(layerMenu?.actions),
  );

  const ungrouped = await clickMenuAction('ungroup');
  await sleep(800);
  const afterUngroup = await state();
  console.log('  после «Разгруппировать»:', JSON.stringify(afterUngroup.groups));
  check('пункт «Разгруппировать» сработал', ungrouped === true);
  check(
    'все объекты вне групп',
    afterUngroup.groups.every((groupId) => groupId === null),
    JSON.stringify(afterUngroup.groups),
  );

  console.log('\n6. Клик по одному объекту группы выделяет всю группу');
  const regrouped = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.select([${JSON.stringify(created.first)}, ${JSON.stringify(created.second)}]);
    app.objects.group();
    app.objects.clearSelection();
    app.objects.selectOne(${JSON.stringify(created.second)});
    return { selected: [...app.objects.selectedIds], count: app.objects.objects.length };
  })()`);
  console.log('  выделение после клика по объекту группы:', JSON.stringify(regrouped.selected));
  check(
    'выделены оба объекта группы',
    regrouped.selected.length === 2 &&
      regrouped.selected.includes(created.first) &&
      regrouped.selected.includes(created.second),
    JSON.stringify(regrouped.selected),
  );

  console.log('\n7. «Удалить» из контекстного меню удаляет группу');
  await cdp.evaluate(`(() => {
    const right = Array.from(document.querySelectorAll('aside')).pop();
    const row = right.querySelector('[data-group-id]');
    if (!row) return 'нет строки';
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(rect.left + 40), clientY: Math.round(rect.top + 10) }));
    return 'ok';
  })()`);
  await sleep(600);
  const removed = await clickMenuAction('remove');
  await sleep(900);
  const afterRemove = await state();
  console.log('  после удаления:', JSON.stringify(afterRemove));
  check('пункт «Удалить» сработал', removed === true);
  check(
    'оба объекта группы удалены, третий остался',
    afterRemove.count === 1 && afterRemove.groups.every((groupId) => groupId === null),
    JSON.stringify(afterRemove),
  );

  await cdp.screenshot(resolvePath(TMP, 'groups.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

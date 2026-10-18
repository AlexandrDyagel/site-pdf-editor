/**
 * Проверка панели «История».
 *
 *   1. Вкладка «История» есть в правой панели сразу после «Слоёв»;
 *   2. лента показывает выполненные действия и текущее состояние;
 *   3. клик по строке возвращает документ в это состояние (и вперёд — тоже);
 *   4. кнопки «Отменить» / «Повторить» работают и блокируются, когда нечего делать;
 *   5. пустая история показывает заглушку.
 *
 * Запуск: node scripts/check-history.mjs
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9365 });

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
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
  await sleep(1500);

  console.log('\n1. Вкладка «История» в правой панели');
  const tabs = await cdp.evaluate(`(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const right = asides[asides.length - 1];
    const buttons = Array.from(right.querySelectorAll('button')).map((button) => (button.textContent || '').trim());
    return buttons.filter((text) => text.length > 0 && text.length < 20);
  })()`);
  console.log('  вкладки:', JSON.stringify(tabs.slice(0, 8)));
  const historyIndex = tabs.indexOf('История');
  const layersIndex = tabs.indexOf('Слои');
  const pageIndex = tabs.indexOf('Страница');
  check('вкладка «История» есть', historyIndex >= 0, JSON.stringify(tabs.slice(0, 8)));
  check(
    '«История» идёт после «Слоёв»',
    historyIndex > layersIndex && (pageIndex < 0 || historyIndex < pageIndex),
    `Слои: ${layersIndex}, История: ${historyIndex}, Страница: ${pageIndex}`,
  );

  console.log('\n2. Пустая история');
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.objects.clearAll(false);
    app.history.clear();
    app.ui.setRightTab('history');
    return 'ok';
  })()`);
  await sleep(1000);
  const emptyState = await cdp.evaluate(`(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const right = asides[asides.length - 1];
    return {
      rows: right.querySelectorAll('[data-history-row]').length,
      text: (right.textContent || '').includes('История пуста'),
      undoDisabled: Boolean(right.querySelector('[data-history-undo]')?.disabled),
      redoDisabled: Boolean(right.querySelector('[data-history-redo]')?.disabled),
    };
  })()`);
  console.log('  пустая история:', JSON.stringify(emptyState));
  check('показана заглушка «История пуста»', emptyState.text === true);
  check('кнопки отмены и повтора заблокированы', emptyState.undoDisabled && emptyState.redoDisabled);

  console.log('\n3. Лента действий');
  const actions = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const make = (fill) => factory.createShapeObject('rect', {
      page: 0, x: 300, y: 90, width: 160, height: 80,
      defaults: { stroke: fill, strokeWidth: 2, fill },
    });
    const rect = make('#dc2626');
    app.objects.add([rect], 'Добавление фигуры');
    app.objects.rename(rect.id, 'План зала');
    app.objects.update(rect.id, { payload: { fill: '#16a34a' } }, 'Заливка');
    return {
      depth: app.history.past.length,
      labels: app.history.past.map((entry) => entry.label),
    };
  })()`);
  await sleep(1200);
  console.log('  действия:', JSON.stringify(actions));
  check('история записала три действия', actions.depth === 3, String(actions.depth));

  const panel = await cdp.evaluate(`(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const right = asides[asides.length - 1];
    return {
      rows: Array.from(right.querySelectorAll('[data-history-row]')).map((row) => ({
        kind: row.getAttribute('data-history-row'),
        label: row.getAttribute('data-history-label'),
      })),
      undoDisabled: Boolean(right.querySelector('[data-history-undo]')?.disabled),
      redoDisabled: Boolean(right.querySelector('[data-history-redo]')?.disabled),
      counter: (right.textContent || '').includes('Шагов: 3'),
    };
  })()`);
  console.log('  строки панели:', JSON.stringify(panel.rows));
  check('в ленте три действия и текущее состояние', panel.rows.length === 4, String(panel.rows.length));
  check('текущее состояние отмечено', panel.rows.some((row) => row.kind === 'current'));
  check(
    'подписи совпадают с действиями',
    panel.rows.filter((row) => row.kind === 'past').map((row) => row.label).join('|') ===
      'Добавление фигуры|Переименование|Заливка',
    JSON.stringify(panel.rows),
  );
  check('«Отменить» доступна, «Повторить» — нет', panel.undoDisabled === false && panel.redoDisabled === true);
  check('счётчик шагов показывает 3', panel.counter === true);

  console.log('\n4. Переход по клику');
  // Клик по первой строке (самое старое действие) — отменяем всё.
  await cdp.evaluate(`(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const right = asides[asides.length - 1];
    const rows = right.querySelectorAll('[data-history-row="past"]');
    rows[0].click();
    return 'ok';
  })()`);
  await sleep(1200);
  const afterFirst = await cdp.evaluate(`(() => ({
    objects: window.__PDF_EDITOR__.objects.objects.length,
    depth: window.__PDF_EDITOR__.history.past.length,
    future: window.__PDF_EDITOR__.history.future.length,
  }))()`);
  console.log('  после клика по первому действию:', JSON.stringify(afterFirst));
  check('клик по самому старому действию отменяет всё', afterFirst.objects === 0 && afterFirst.depth === 0, JSON.stringify(afterFirst));
  check('отменённые шаги ушли в «будущее»', afterFirst.future === 3, String(afterFirst.future));

  // Клик по последней строке «будущего» — возвращаем всё обратно.
  await cdp.evaluate(`(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const right = asides[asides.length - 1];
    const rows = right.querySelectorAll('[data-history-row="future"]');
    rows[rows.length - 1].click();
    return 'ok';
  })()`);
  await sleep(1400);
  const afterFuture = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const shape = app.objects.objects.find((object) => object.type === 'shape');
    return {
      objects: app.objects.objects.length,
      depth: app.history.past.length,
      name: shape ? shape.name : null,
      fill: shape ? shape.payload.fill : null,
    };
  })()`);
  console.log('  после клика по последнему отменённому:', JSON.stringify(afterFuture));
  check('повтор возвращает объект', afterFuture.objects === 1 && afterFuture.depth === 3, JSON.stringify(afterFuture));
  check(
    'состояние соответствует последнему действию',
    afterFuture.name === 'План зала' && afterFuture.fill === '#16a34a',
    JSON.stringify(afterFuture),
  );

  console.log('\n5. Кнопки «Отменить» и «Повторить»');
  await cdp.evaluate(`(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const right = asides[asides.length - 1];
    right.querySelector('[data-history-undo]').click();
    return 'ok';
  })()`);
  await sleep(1000);
  const afterUndoButton = await cdp.evaluate(`(() => ({
    depth: window.__PDF_EDITOR__.history.past.length,
    fill: window.__PDF_EDITOR__.objects.objects[0]?.payload.fill ?? null,
  }))()`);
  console.log('  после кнопки «Отменить»:', JSON.stringify(afterUndoButton));
  check(
    'кнопка «Отменить» делает шаг назад',
    afterUndoButton.depth === 2 && afterUndoButton.fill === '#dc2626',
    JSON.stringify(afterUndoButton),
  );

  await cdp.evaluate(`(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const right = asides[asides.length - 1];
    right.querySelector('[data-history-redo]').click();
    return 'ok';
  })()`);
  await sleep(1000);
  const afterRedoButton = await cdp.evaluate(`(() => ({
    depth: window.__PDF_EDITOR__.history.past.length,
    fill: window.__PDF_EDITOR__.objects.objects[0]?.payload.fill ?? null,
  }))()`);
  console.log('  после кнопки «Повторить»:', JSON.stringify(afterRedoButton));
  check('кнопка «Повторить» возвращает шаг', afterRedoButton.depth === 3 && afterRedoButton.fill === '#16a34a', JSON.stringify(afterRedoButton));

  await cdp.screenshot(resolvePath(TMP, 'history-panel.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

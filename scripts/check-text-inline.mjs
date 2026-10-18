/**
 * Проверка редактирования текста прямо на холсте.
 *
 *   1. Инструмент «Текст» + клик по холсту → появляется поле с кареткой
 *      (мигающая каретка — это нативный textarea), можно сразу печатать;
 *   2. текст набирается, рамка объекта расширяется по содержимому;
 *   3. Esc завершает ввод, текст остаётся на холсте;
 *   4. клик инструментом «Текст» по готовому тексту открывает его на правку
 *      с кареткой в месте клика.
 *
 * Запуск: node scripts/check-text-inline.mjs
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9371 });

/** Экранные координаты точки страницы. */
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

async function clickAt(point) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(700);
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
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    app.editor.setTool('text');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(800);

  console.log('\n1. Клик инструментом «Текст»');
  await clickAt(await screenPoint(300, 120));
  const afterClick = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const field = document.querySelector('[data-testid=text-inline-editor]');
    const object = app.objects.objects[0];
    return {
      hasField: Boolean(field),
      focused: Boolean(field) && document.activeElement === field,
      selection: field ? { start: field.selectionStart, end: field.selectionEnd } : null,
      text: object ? object.payload.text : null,
      width: object ? Number(object.width.toFixed(1)) : null,
      height: object ? Number(object.height.toFixed(1)) : null,
      caret: app.editor.editingTextId === (object ? object.id : null),
    };
  })()`);
  console.log('  после клика:', JSON.stringify(afterClick));
  check('текстовый объект создан', afterClick.text === '', String(afterClick.text));
  check('появилось поле с кареткой', afterClick.hasField === true && afterClick.focused === true);
  check('каретка в начале текста', afterClick.selection?.start === 0, JSON.stringify(afterClick.selection));
  check('область под текст небольшая', afterClick.width !== null && afterClick.width < 30, String(afterClick.width));

  console.log('\n2. Набор текста');
  const initialWidth = afterClick.width;
  await cdp.send('Input.insertText', { text: 'Привет, мир!' });
  await sleep(900);
  const afterTyping = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    const field = document.querySelector('[data-testid=text-inline-editor]');
    return {
      text: object ? object.payload.text : null,
      width: object ? Number(object.width.toFixed(1)) : null,
      height: object ? Number(object.height.toFixed(1)) : null,
      fieldValue: field ? field.value : null,
      selection: field ? field.selectionStart : null,
    };
  })()`);
  console.log('  после набора:', JSON.stringify(afterTyping));
  check('текст набран', afterTyping.text === 'Привет, мир!', String(afterTyping.text));
  check('поле показывает тот же текст', afterTyping.fieldValue === 'Привет, мир!');
  check('каретка в конце набранного', afterTyping.selection === 12, String(afterTyping.selection));
  check(
    'рамка расширилась по тексту',
    afterTyping.width !== null && initialWidth !== null && afterTyping.width > initialWidth + 40,
    `${initialWidth} → ${afterTyping.width}`,
  );

  console.log('\n3. Завершение ввода');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(800);
  const afterEscape = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    return {
      editing: app.editor.editingTextId,
      hasField: Boolean(document.querySelector('[data-testid=text-inline-editor]')),
      text: object ? object.payload.text : null,
      opacity: (() => {
        const stage = window.__PDF_EDITOR_STAGE__;
        const node = stage.findOne((item) => item.getAttr && item.getAttr('objectId') === (object ? object.id : ''));
        return node ? node.opacity() : null;
      })(),
    };
  })()`);
  console.log('  после Esc:', JSON.stringify(afterEscape));
  check('режим редактирования завершён', afterEscape.editing === null && afterEscape.hasField === false);
  check('текст остался на холсте', afterEscape.text === 'Привет, мир!');
  check('объект снова видим', afterEscape.opacity === 1, String(afterEscape.opacity));

  console.log('\n4. Клик по готовому тексту — каретка в месте клика');
  const target = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    const layout = await import('/src/utils/textLayout.ts');
    const payload = object.payload;
    // Ширина префикса «Привет, » — туда и кликаем.
    const prefix = 'Привет, ';
    const width = layout.measureTextWidth(prefix, {
      fontFamily: payload.fontFamily,
      fontId: payload.fontId,
      fontSize: payload.fontSize,
      bold: payload.bold,
      italic: payload.italic,
      letterSpacing: payload.letterSpacing,
      lineHeight: payload.lineHeight,
      underline: payload.underline,
    });
    app.editor.setTool('text');
    return {
      id: object.id,
      x: object.x + (payload.padding ?? 0) + width,
      y: object.y + 6,
      expectedCaret: prefix.length,
    };
  })()`);
  await clickAt(await screenPoint(target.x, target.y));
  const afterSecondClick = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const field = document.querySelector('[data-testid=text-inline-editor]');
    return {
      editingId: app.editor.editingTextId,
      hasField: Boolean(field),
      focused: Boolean(field) && document.activeElement === field,
      selection: field ? field.selectionStart : null,
      value: field ? field.value : null,
    };
  })()`);
  console.log('  после клика по тексту:', JSON.stringify(afterSecondClick), 'ожидаемая каретка:', target.expectedCaret);
  check('открылся тот же текстовый объект', afterSecondClick.editingId === target.id);
  check('каретка стоит в месте клика', Math.abs((afterSecondClick.selection ?? -99) - target.expectedCaret) <= 1, String(afterSecondClick.selection));

  // Ввод в середину текста.
  await cdp.send('Input.insertText', { text: 'дорогой ' });
  await sleep(800);
  const afterInsert = await cdp.evaluate(`(() => window.__PDF_EDITOR__.objects.objects[0].payload.text)()`);
  console.log('  текст после вставки:', JSON.stringify(afterInsert));
  check('текст вставился в место каретки', afterInsert === 'Привет, дорогой мир!', String(afterInsert));

  console.log('\n5. Выделение рамкой и объект скрыт во время ввода');
  const duringEdit = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    const stage = window.__PDF_EDITOR_STAGE__;
    const node = stage.findOne((item) => item.getAttr && item.getAttr('objectId') === object.id);
    return { editing: app.editor.editingTextId, opacity: node ? node.opacity() : null };
  })()`);
  console.log('  во время ввода:', JSON.stringify(duringEdit));
  check('Konva-текст скрыт, пока идёт ввод', duringEdit.opacity === 0, String(duringEdit.opacity));

  await cdp.screenshot(resolvePath(TMP, 'text-inline.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

/**
 * Горячие клавиши при РУССКОЙ раскладке клавиатуры.
 *
 * Пользователь сообщил: Ctrl+Z не работает, пока не переключишься на английскую
 * раскладку. Причина — `event.key` при русской раскладке для физической Z
 * возвращает «я». Тест эмулирует русскую раскладку (Cyrillic `key` + латинский
 * `code`) и проверяет все основные сочетания.
 *
 * Запуск: node scripts/check-hotkeys.mjs
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9359 });

/** Нажатие клавиши: key — то, что «видит» раскладка, code — физическая клавиша. */
async function press({ key, code, vk, ctrl = false, shift = false, alt = false }) {
  const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
  await sleep(260);
}

/** Русская раскладка: русская буква, которая стоит на этой физической клавише. */
const RU = {
  keyZ: { key: 'я', code: 'KeyZ', vk: 90 },
  keyY: { key: 'н', code: 'KeyY', vk: 89 },
  keyC: { key: 'с', code: 'KeyC', vk: 67 },
  keyV: { key: 'м', code: 'KeyV', vk: 86 },
  keyA: { key: 'ф', code: 'KeyA', vk: 65 },
  keyE: { key: 'у', code: 'KeyE', vk: 69 },
  keyB: { key: 'и', code: 'KeyB', vk: 66 },
  keyM: { key: 'ь', code: 'KeyM', vk: 77 },
  keyO: { key: 'щ', code: 'KeyO', vk: 79 },
  keyX: { key: 'ч', code: 'KeyX', vk: 88 },
  bracketRight: { key: 'ъ', code: 'BracketRight', vk: 221 },
  bracketLeft: { key: 'х', code: 'BracketLeft', vk: 219 },
  digit0: { key: '0', code: 'Digit0', vk: 48 },
  digit1: { key: '1', code: 'Digit1', vk: 49 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
};

/** Состояние редактора, нужное для проверок. */
async function state() {
  return cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return {
      tool: app.editor.tool,
      objects: app.objects.objects.length,
      selected: app.objects.selectedIds.length,
      clipboard: app.objects.clipboard.length,
      zoom: app.editor.zoomPercent,
      exporter: Boolean(app.ui.modals.export),
      zIndexes: app.objects.objects.map((o) => o.zIndex),
    };
  })()`);
}

/** Пересоздание двух объектов на странице и выделение первого. */
async function seedObjects() {
  return cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.objects.clearAll(false);
    const factory = await import('/src/services/objectFactory.ts');
    const make = (x, y, text) => factory.createTextObject({
      page: 0, x, y, width: 220, height: 24, autoHeight: true, text,
      defaults: { fontId: 'pt-sans', fontFamily: 'PT Sans', fontSize: 14, color: '#111111' },
    });
    const first = make(120, 300, 'Первый объект');
    const second = make(140, 340, 'Второй объект');
    app.objects.add([first, second], 'тест');
    app.objects.select([first.id]);
    app.editor.setTool('select');
    return { firstId: first.id, secondId: second.id, count: app.objects.objects.length };
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
  await cdp.evaluate(`document.activeElement?.blur?.(); window.__PDF_EDITOR__.editor.setTool('select'); 'ok'`);
  await sleep(600);

  console.log('\n1. Функция определяет клавишу независимо от раскладки');
  const logical = await cdp.evaluate(`(async () => {
    const { logicalKey } = await import('/src/composables/useHotkeys.ts');
    const make = (key, code) => new KeyboardEvent('keydown', { key, code });
    return {
      ruZ: logicalKey(make('я', 'KeyZ')),
      enZ: logicalKey(make('z', 'KeyZ')),
      ruBracket: logicalKey(make('ъ', 'BracketRight')),
      ruBracketLeft: logicalKey(make('х', 'BracketLeft')),
      digit: logicalKey(make('0', 'Digit0')),
      escape: logicalKey(make('Escape', 'Escape')),
      del: logicalKey(make('Delete', 'Delete')),
      cyrillicO: logicalKey(make('о', 'KeyO')),
    };
  })()`);
  console.log('  результаты:', JSON.stringify(logical));
  check('русская «я» на клавише Z → z', logical.ruZ === 'z', logical.ruZ);
  check('английская z → z', logical.enZ === 'z', logical.enZ);
  check('русская «ъ» на клавише ] → ]', logical.ruBracket === ']', logical.ruBracket);
  check('русская «х» на клавише [ → [', logical.ruBracketLeft === '[', logical.ruBracketLeft);
  check('цифра 0 → 0', logical.digit === '0', logical.digit);
  check('Escape не ломается', logical.escape === 'escape', logical.escape);
  check('Delete не ломается', logical.del === 'delete', logical.del);
  check('кириллическая «о» на клавише O → o', logical.cyrillicO === 'o', logical.cyrillicO);

  console.log('\n2. Отмена и повтор (Ctrl+Z / Ctrl+Y) в русской раскладке');
  const seeded = await seedObjects();
  await sleep(500);
  const focused = await cdp.evaluate(`(() => {
    const active = document.activeElement;
    return { tag: active ? active.tagName : 'none', editingTextId: window.__PDF_EDITOR__.editor.editingTextId };
  })()`);
  check(
    'после выделения объекта фокус не в поле ввода',
    focused.tag !== 'TEXTAREA' && focused.tag !== 'INPUT',
    JSON.stringify(focused),
  );

  // Копируем и вставляем, чтобы появилось что отменять.
  await press({ ...RU.keyA, ctrl: true });
  await press({ ...RU.keyC, ctrl: true });
  const copied = await state();
  check(
    'Ctrl+A и Ctrl+C работают в русской раскладке',
    copied.selected === seeded.count && copied.clipboard === seeded.count,
    JSON.stringify(copied),
  );
  await press({ ...RU.keyV, ctrl: true });
  const pasted = await state();
  check('Ctrl+V вставляет объекты', pasted.objects === seeded.count * 2, `объектов: ${pasted.objects}`);

  await press({ ...RU.keyZ, ctrl: true });
  const undone = await state();
  check(
    'Ctrl+Z отменяет вставку',
    undone.objects === seeded.count,
    `объектов: ${undone.objects} (ожидалось ${seeded.count})`,
  );

  await press({ ...RU.keyY, ctrl: true });
  const redone = await state();
  check('Ctrl+Y повторяет вставку', redone.objects === seeded.count * 2, `объектов: ${redone.objects}`);

  console.log('\n3. Буквенные сокращения инструментов в русской раскладке');
  const toolCases = [
    { ...RU.keyB, expected: 'brush', label: 'B (Кисть)' },
    { ...RU.keyE, expected: 'eraser', label: 'E (Корректор)' },
    { ...RU.keyM, expected: 'marker', label: 'M (Маркер)' },
    { ...RU.keyO, expected: 'ellipse', label: 'O (Эллипс)' },
    { ...RU.keyX, expected: null, label: 'X без Ctrl (нет такого инструмента)' },
    { ...RU.keyV, expected: 'select', label: 'V (Выбор)' },
  ];
  for (const item of toolCases) {
    const before = (await state()).tool;
    await press({ key: item.key, code: item.code, vk: item.vk });
    const current = (await state()).tool;
    if (item.expected) {
      check(`инструмент ${item.label}`, current === item.expected, `инструмент: ${current}`);
    } else {
      check(`клавиша X без Ctrl не меняет инструмент`, current === before, `было ${before}, стало ${current}`);
    }
  }

  console.log('\n4. Порядок слоёв клавишами [ и ]');
  const layerSeed = await seedObjects();
  await sleep(400);
  const beforeLayers = await state();
  const beforeFirstZ = await cdp.evaluate(`window.__PDF_EDITOR__.objects.byId(${JSON.stringify(layerSeed.firstId)}).zIndex`);
  await press({ key: RU.bracketRight.key, code: RU.bracketRight.code, vk: RU.bracketRight.vk });
  const afterFirstZ = await cdp.evaluate(`window.__PDF_EDITOR__.objects.byId(${JSON.stringify(layerSeed.firstId)}).zIndex`);
  console.log(`  z-index первого объекта: ${beforeFirstZ} → ${afterFirstZ} (все: ${JSON.stringify((await state()).zIndexes)})`);
  check('клавиша «]» поднимает объект в русской раскладке', afterFirstZ > beforeFirstZ, `${beforeFirstZ} → ${afterFirstZ}`);
  check('в панели слоёв стало два объекта', beforeLayers.objects === 2, `объектов: ${beforeLayers.objects}`);

  console.log('\n5. Удаление, экспорт и масштаб в русской раскладке');
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.objects.select(app.objects.objects.map((o) => o.id));
    return 'ok';
  })()`);
  await press({ key: RU.delete.key, code: RU.delete.code, vk: RU.delete.vk });
  const afterDelete = await state();
  check('Delete удаляет выделенные объекты', afterDelete.objects === 0, `объектов: ${afterDelete.objects}`);

  await press({ ...RU.keyE, ctrl: true });
  const afterExport = await state();
  check('Ctrl+E открывает окно экспорта', afterExport.exporter === true, JSON.stringify(afterExport));
  await press({ key: RU.escape.key, code: RU.escape.code, vk: RU.escape.vk });
  await sleep(300);

  await press({ ...RU.digit1, ctrl: true });
  const afterZoom = await state();
  check('Ctrl+1 ставит масштаб 100%', afterZoom.zoom === 100, `масштаб: ${afterZoom.zoom}%`);

  console.log('\n6. Английская раскладка не сломалась');
  await seedObjects();
  await sleep(300);
  await press({ key: 'a', code: 'KeyA', vk: 65, ctrl: true });
  await press({ key: 'c', code: 'KeyC', vk: 67, ctrl: true });
  await press({ key: 'v', code: 'KeyV', vk: 86, ctrl: true });
  const enPaste = await state();
  check('Ctrl+V в английской раскладке работает', enPaste.objects === 4, `объектов: ${enPaste.objects}`);
  await press({ key: 'z', code: 'KeyZ', vk: 90, ctrl: true });
  const enUndo = await state();
  check('Ctrl+Z в английской раскладке работает', enUndo.objects === 2, `объектов: ${enUndo.objects}`);

  console.log('\n7. Двойной клик по тексту и возврат к горячим клавишам');
  const editing = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    const x = Math.round(rect.left + app.editor.pan.x + (object.x + 40) * app.editor.zoom);
    const y = Math.round(rect.top + app.editor.pan.y + (object.y + 12) * app.editor.zoom);
    return { x, y, id: object.id };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: editing.x, y: editing.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  for (const clickCount of [1, 2]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editing.x, y: editing.y, button: 'left', buttons: 1, clickCount, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editing.x, y: editing.y, button: 'left', buttons: 0, clickCount, pointerType: 'mouse' });
    await sleep(90);
  }
  await sleep(700);
  const afterDoubleClick = await cdp.evaluate(`(() => ({
    editingTextId: window.__PDF_EDITOR__.editor.editingTextId,
    tag: document.activeElement ? document.activeElement.tagName : 'none',
  }))()`);
  console.log('  после двойного клика:', JSON.stringify(afterDoubleClick));
  check('двойной клик включает редактирование текста', afterDoubleClick.editingTextId === editing.id, JSON.stringify(afterDoubleClick));
  check('поле текста получает фокус при редактировании', afterDoubleClick.tag === 'TEXTAREA', afterDoubleClick.tag);

  // Escape возвращает управление горячим клавишам.
  await press({ key: 'Escape', code: 'Escape', vk: 27 });
  await sleep(300);
  await press({ ...RU.keyZ, ctrl: true });
  const afterEscape = await cdp.evaluate(`(() => ({
    editingTextId: window.__PDF_EDITOR__.editor.editingTextId,
    tag: document.activeElement ? document.activeElement.tagName : 'none',
    objects: window.__PDF_EDITOR__.objects.objects.length,
  }))()`);
  console.log('  после Escape и Ctrl+Z:', JSON.stringify(afterEscape));
  check('Escape прекращает редактирование', afterEscape.editingTextId === null, JSON.stringify(afterEscape));

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

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

  console.log('\n5. Текст виден во время ввода (его рисует Konva)');
  const duringEdit = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    const stage = window.__PDF_EDITOR_STAGE__;
    const node = stage.findOne((item) => item.getAttr && item.getAttr('objectId') === object.id);
    return { editing: app.editor.editingTextId, opacity: node ? node.opacity() : null };
  })()`);
  console.log('  во время ввода:', JSON.stringify(duringEdit));
  check('Konva-текст виден и во время ввода', duringEdit.opacity === 1, String(duringEdit.opacity));

  console.log('\n5б. Текст не съезжает после потери фокуса');
  /** Рамка «чернил» текста на слое объектов (в пикселях экрана). */
  async function textInkBox() {
    return cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const object = app.objects.objects[0];
      const canvas = document.querySelectorAll('canvas')[1];
      const ctx = canvas.getContext('2d');
      const zoom = app.editor.zoom;
      const left = Math.max(0, Math.round(app.editor.pan.x + object.x * zoom) - 40);
      const top = Math.max(0, Math.round(app.editor.pan.y + object.y * zoom) - 40);
      const width = Math.round((object.width + 80) * zoom);
      const height = Math.round((object.height + 80) * zoom);
      const data = ctx.getImageData(left, top, Math.max(1, width), Math.max(1, height)).data;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 4;
          if (data[index + 3] > 20) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    })()`);
  }

  const boxWhileEditing = await textInkBox();
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(900);
  const boxAfterBlur = await textInkBox();
  console.log('  чернила при вводе:', JSON.stringify(boxWhileEditing), '→ после потери фокуса:', JSON.stringify(boxAfterBlur));
  check(
    'текст остаётся на том же месте после потери фокуса',
    Math.abs(boxWhileEditing.x - boxAfterBlur.x) <= 1 && Math.abs(boxWhileEditing.y - boxAfterBlur.y) <= 1,
    `сдвиг: x ${boxAfterBlur.x - boxWhileEditing.x}, y ${boxAfterBlur.y - boxWhileEditing.y}`,
  );

  // Возвращаемся в правку для следующих проверок.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    app.objects.select([object.id]);
    app.editor.startTextEditing(object.id);
    return 'ok';
  })()`);
  await sleep(800);

  console.log('\n6. Пробел в конце слова не раздувает поле');
  const beforeSpace = await cdp.evaluate(`(() => {
    const object = window.__PDF_EDITOR__.objects.objects[0];
    return { text: object.payload.text, height: Number(object.height.toFixed(1)) };
  })()`);
  await cdp.send('Input.insertText', { text: ' ' });
  await sleep(700);
  const afterSpace = await cdp.evaluate(`(() => {
    const object = window.__PDF_EDITOR__.objects.objects[0];
    const field = document.querySelector('[data-testid=text-inline-editor]');
    return {
      text: object.payload.text,
      height: Number(object.height.toFixed(1)),
      scrollHeight: field ? field.scrollHeight : null,
      clientHeight: field ? field.clientHeight : null,
    };
  })()`);
  console.log('  до пробела:', JSON.stringify(beforeSpace), '→ после:', JSON.stringify(afterSpace));
  check(
    'пробел добавлен в текст',
    String(afterSpace.text).length === String(beforeSpace.text).length + 1,
    JSON.stringify(afterSpace.text),
  );
  check(
    'высота поля не изменилась от пробела',
    afterSpace.height === beforeSpace.height,
    `${beforeSpace.height} → ${afterSpace.height}`,
  );

  console.log('\n7. Пустой текст не остаётся на холсте');
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const field = document.querySelector('[data-testid=text-inline-editor]');
    if (field) {
      field.focus();
      field.setSelectionRange(0, field.value.length);
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return 'ok';
  })()`);
  await sleep(500);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(900);
  const afterEmpty = await cdp.evaluate(`(() => ({
    objects: window.__PDF_EDITOR__.objects.objects.length,
    editing: window.__PDF_EDITOR__.editor.editingTextId,
    hasField: Boolean(document.querySelector('[data-testid=text-inline-editor]')),
  }))()`);
  console.log('  после стирания текста:', JSON.stringify(afterEmpty));
  check('пустой текстовый объект удалён', afterEmpty.objects === 0, JSON.stringify(afterEmpty));

  console.log('\n8. Растягивание текста за сторону — без «резины»');
  const created = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.objects.clearAll(false);
    const text = factory.createTextObject({
      page: 0, x: 120, y: 120, width: 60, height: 22, text: 'Однострочный текст', autoHeight: true,
      defaults: {
        fontId: 'pt-sans', fontFamily: 'PT Sans', fontSize: 14, color: '#111827',
        bold: false, italic: false, align: 'left', lineHeight: 1.25, letterSpacing: 0,
      },
    });
    app.objects.add([text], 'тест');
    app.objects.select([text.id]);
    app.editor.setTool('select');
    document.activeElement?.blur?.();
    return { id: text.id, width: Number(text.width.toFixed(1)), height: Number(text.height.toFixed(1)) };
  })()`);
  await sleep(1200);
  const handle = await cdp.evaluate(`(() => {
    const stage = window.__PDF_EDITOR_STAGE__;
    const transformer = stage.findOne((node) => node.name && node.name() === 'transformer');
    const anchor = transformer ? transformer.findOne('.middle-right') : null;
    if (!anchor) return null;
    const rect = stage.container().getBoundingClientRect();
    const absolute = anchor.getAbsolutePosition();
    return { x: Math.round(rect.left + absolute.x), y: Math.round(rect.top + absolute.y) };
  })()`);
  check('найдена ручка растягивания справа', handle !== null);

  if (handle) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: handle.x + step * 26,
        y: handle.y,
        button: 'left',
        buttons: 1,
        pointerType: 'mouse',
      });
      await sleep(30);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 208, y: handle.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await sleep(900);
    const afterResize = await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const object = app.objects.byId(${JSON.stringify(created.id)});
      const stage = window.__PDF_EDITOR_STAGE__;
      const node = stage.findOne((item) => item.getAttr && item.getAttr('objectId') === ${JSON.stringify(created.id)});
      return {
        width: object ? Number(object.width.toFixed(1)) : null,
        height: object ? Number(object.height.toFixed(1)) : null,
        scaleX: node ? Number(node.scaleX().toFixed(3)) : null,
        scaleY: node ? Number(node.scaleY().toFixed(3)) : null,
      };
    })()`);
    console.log('  до:', JSON.stringify(created), '→ после растягивания:', JSON.stringify(afterResize));
    check(
      'ширина текста увеличилась',
      afterResize.width !== null && afterResize.width > created.width + 40,
      `${created.width} → ${afterResize.width}`,
    );
    check(
      'масштаб узла сброшен (текст не растянут)',
      afterResize.scaleX === 1 && afterResize.scaleY === 1,
      JSON.stringify(afterResize),
    );
    check(
      'текст остался в одну строку',
      Math.abs(afterResize.height - created.height) < 2,
      `${created.height} → ${afterResize.height}`,
    );
  }

  console.log('\n9. Пустой текст не попадает в «Слои»');
  /** Клик инструментом «Текст», ввод `value`, затем уход на холст. */
  async function createTextAndLeave(value, point) {
    await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      app.objects.clearAll(false);
      app.editor.setTool('text');
      app.ui.setRightTab('layers');
      document.activeElement?.blur?.();
      return 'ok';
    })()`);
    await sleep(600);
    await clickAt(await screenPoint(point.x, point.y));
    if (value) {
      await cdp.send('Input.insertText', { text: value });
      await sleep(500);
    }
    // Уходим на холст инструментом «Выбор» — это и есть «клик мимо».
    await cdp.evaluate(`window.__PDF_EDITOR__.editor.setTool('select'); 'ok'`);
    await sleep(500);
    await clickAt(await screenPoint(point.x + 220, point.y + 160));
    await sleep(600);
    // Открываем «Слои», чтобы проверить, что список совпадает с объектами.
    await cdp.evaluate(`window.__PDF_EDITOR__.ui.setRightTab('layers'); 'ok'`);
    await sleep(700);
    return cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      return {
        objects: app.objects.objects.map((object) => ({
          type: object.type,
          text: object.payload && 'text' in object.payload ? object.payload.text : null,
        })),
        layers: Array.from(document.querySelectorAll('[data-layer-label]')).map((el) => el.textContent.trim()),
        editing: app.editor.editingTextId,
      };
    })()`);
  }

  const blankCreated = await createTextAndLeave('', { x: 300, y: 120 });
  console.log('  пустой текст:', JSON.stringify(blankCreated));
  check('пустой текст не остался на холсте', blankCreated.objects.length === 0, JSON.stringify(blankCreated.objects));
  check('пустой текст не попал в «Слои»', blankCreated.layers.length === 0, JSON.stringify(blankCreated.layers));

  const spacesOnly = await createTextAndLeave('   ', { x: 300, y: 120 });
  console.log('  только пробелы:', JSON.stringify(spacesOnly));
  check(
    'текст из одних пробелов считается пустым',
    spacesOnly.objects.length === 0 && spacesOnly.layers.length === 0,
    JSON.stringify(spacesOnly),
  );

  const realText = await createTextAndLeave('Нормальный текст', { x: 300, y: 120 });
  console.log('  настоящий текст:', JSON.stringify(realText));
  check(
    'текст с содержимым остаётся',
    realText.objects.length === 1 && realText.layers.length === 1,
    JSON.stringify(realText),
  );

  console.log('\n10. Текст начинается ровно в точке клика');
  const clickPoint = { x: 300, y: 200 };
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.clearAll(false);
    app.editor.setTool('text');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(600);
  await clickAt(await screenPoint(clickPoint.x, clickPoint.y));
  await cdp.send('Input.insertText', { text: 'Привет' });
  await sleep(800);
  // Снимаем выделение: рамка трансформера рисуется на том же слое и попала бы
  // в замер «чернил».
  await cdp.evaluate(`(() => {
    window.__PDF_EDITOR__.objects.clearSelection();
    return 'ok';
  })()`);
  await sleep(700);
  const placement = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    const canvas = document.querySelectorAll('canvas')[1];
    const ctx = canvas.getContext('2d');
    const zoom = app.editor.zoom;
    const left = Math.max(0, Math.round(app.editor.pan.x + (${clickPoint.x} - 40) * zoom));
    const top = Math.max(0, Math.round(app.editor.pan.y + (${clickPoint.y} - 40) * zoom));
    const width = Math.round(120 * zoom);
    const height = Math.round(80 * zoom);
    const data = ctx.getImageData(left, top, width, height).data;
    let minX = Infinity;
    let minY = Infinity;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        if (data[index + 3] > 20) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
        }
      }
    }
    return {
      inkPageX: Number(((left + minX - app.editor.pan.x) / zoom).toFixed(2)),
      inkPageY: Number(((top + minY - app.editor.pan.y) / zoom).toFixed(2)),
      objectX: Number(object.x.toFixed(2)),
      objectY: Number(object.y.toFixed(2)),
      text: object.payload.text,
    };
  })()`);
  console.log('  клик:', JSON.stringify(clickPoint), '→', JSON.stringify(placement));
  check('текст набран', placement.text === 'Привет', String(placement.text));
  check(
    'верх букв совпадает с точкой клика по Y',
    Math.abs(placement.inkPageY - clickPoint.y) <= 2.5,
    `y чернил ${placement.inkPageY} против ${clickPoint.y}`,
  );
  check(
    'начало текста совпадает с точкой клика по X',
    Math.abs(placement.inkPageX - clickPoint.x) <= 2.5,
    `x чернил ${placement.inkPageX} против ${clickPoint.x}`,
  );

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

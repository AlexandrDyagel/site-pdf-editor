/**
 * Проверка раскладки боковых панелей редактора:
 *   1. все кнопки разделов видны и не обрезаются;
 *   2. если места не хватает — кнопки переносятся на следующую строку;
 *   3. границы панелей можно тянуть мышью, ширина сохраняется;
 *   4. когда места достаточно, кнопки снова выстраиваются в один ряд;
 *   5. двойной клик возвращает исходную ширину, стрелки меняют её с клавиатуры.
 *
 * Запуск: node scripts/check-layout.mjs
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9356 });

/** Состояние обоих рядов вкладок. */
async function tabsState() {
  return cdp.evaluate(`(() => {
    const asides = Array.from(document.querySelectorAll('aside'));
    const findAside = (side) => asides.find((aside) =>
      aside.querySelector('[aria-label="Изменить ширину ' + (side === 'left' ? 'левой' : 'правой') + ' панели"]'),
    ) ?? null;

    const read = (side) => {
      const aside = findAside(side);
      if (!aside) return null;
      const panel = aside.getBoundingClientRect();
      const tablist = aside.querySelector('[role=tablist]');
      if (!tablist) return null;
      const listRect = tablist.getBoundingClientRect();
      const buttons = Array.from(tablist.querySelectorAll('[role=tab]'));
      const rows = new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
      return {
        width: Math.round(panel.width),
        listOverflow: Math.round(tablist.scrollWidth - tablist.clientWidth),
        rows: rows.size,
        buttons: buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            label: (button.textContent || '').trim(),
            visible: rect.width > 10 && rect.height > 10,
            inside:
              rect.left >= panel.left - 1 &&
              rect.right <= panel.right + 1 &&
              rect.top >= listRect.top - 1 &&
              rect.bottom <= listRect.bottom + 1,
            truncated: button.scrollWidth > button.clientWidth + 1,
          };
        }),
      };
    };
    return { left: read('left'), right: read('right') };
  })()`);
}

/** Тянем границу панели на deltaX пикселей. */
async function dragHandle(handleLabel, deltaX) {
  const rect = await cdp.evaluate(`(() => {
    const handle = document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(handleLabel))} + ']');
    if (!handle) return null;
    const box = handle.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
  if (!rect) return false;
  const steps = 12;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.x + (deltaX * i) / steps,
      y: rect.y,
      button: 'left',
      buttons: 1,
      pointerType: 'mouse',
    });
    await sleep(16);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + deltaX, y: rect.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(600);
  return true;
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
  // Начинаем с исходной раскладки.
  await cdp.evaluate(`localStorage.removeItem('pdf-editor:panel-widths'); 'ok'`);
  await cdp.send('Page.reload', {});
  await sleep(6000);
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
  await sleep(1500);

  console.log('\n1. Исходная раскладка: все разделы видны');
  const initial = await tabsState();
  console.log('  левая панель:', JSON.stringify(initial.left));
  console.log('  правая панель:', JSON.stringify(initial.right));

  check('панели найдены', Boolean(initial.left && initial.right));
  const allVisible = (state) =>
    Boolean(state) && state.buttons.every((button) => button.visible && button.inside && !button.truncated);
  check('все разделы левой панели видны и не обрезаны', allVisible(initial.left), JSON.stringify(initial.left?.buttons));
  check('все разделы правой панели видны и не обрезаны', allVisible(initial.right), JSON.stringify(initial.right?.buttons));
  check('нет горизонтального переполнения вкладок', initial.left?.listOverflow <= 1 && initial.right?.listOverflow <= 1, `${initial.left?.listOverflow} / ${initial.right?.listOverflow}`);
  check(
    'не поместившиеся разделы перенесены на новую строку',
    initial.right.rows >= 2,
    `строк в правой панели: ${initial.right.rows}`,
  );

  console.log('\n2. Растягиваем правую панель влево — разделы возвращаются в один ряд');
  const beforeRight = initial.right.width;
  const draggedRight = await dragHandle('Изменить ширину правой панели', -180);
  const widened = await tabsState();
  console.log('  правая панель:', JSON.stringify(widened.right));
  check('границу правой панели можно тянуть', draggedRight === true);
  check(
    'ширина правой панели увеличилась',
    widened.right.width > beforeRight + 100,
    `${beforeRight} → ${widened.right.width} px`,
  );
  check(
    'после расширения все разделы в одном ряду',
    widened.right.rows === 1,
    `строк: ${widened.right.rows}`,
  );
  check(
    'после расширения разделы не обрезаны',
    widened.right.buttons.every((button) => button.visible && button.inside && !button.truncated),
    JSON.stringify(widened.right.buttons),
  );

  console.log('\n3. Растягиваем левую панель вправо');
  const beforeLeft = widened.left.width;
  await dragHandle('Изменить ширину левой панели', 200);
  const leftWidened = await tabsState();
  console.log('  левая панель:', JSON.stringify(leftWidened.left));
  check(
    'ширина левой панели увеличилась',
    leftWidened.left.width > beforeLeft + 100,
    `${beforeLeft} → ${leftWidened.left.width} px`,
  );
  check(
    'разделы левой панели в одном ряду',
    leftWidened.left.rows === 1,
    `строк: ${leftWidened.left.rows}`,
  );

  console.log('\n4. Ширина сохраняется');
  const stored = await cdp.evaluate(`localStorage.getItem('pdf-editor:panel-widths')`);
  console.log('  сохранено:', stored);
  let parsed = null;
  try {
    parsed = JSON.parse(stored ?? 'null');
  } catch {
    parsed = null;
  }
  check('ширина записана в localStorage', Boolean(parsed && parsed.left > 300 && parsed.right > 400), String(stored));

  await cdp.send('Page.reload', {});
  await sleep(6000);
  const afterReload = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const asides = Array.from(document.querySelectorAll('aside'));
    const findAside = (side) => asides.find((aside) =>
      aside.querySelector('[aria-label="Изменить ширину ' + (side === 'left' ? 'левой' : 'правой') + ' панели"]'),
    ) ?? null;
    return {
      left: Math.round((findAside('left')?.getBoundingClientRect().width ?? 0)),
      right: Math.round((findAside('right')?.getBoundingClientRect().width ?? 0)),
      pages: app?.pdf.pageCount ?? 0,
    };
  })()`);
  console.log('  после перезагрузки:', JSON.stringify(afterReload));
  check(
    'после перезагрузки ширина сохранилась',
    Math.abs(afterReload.left - (parsed?.left ?? 0)) <= 4 && Math.abs(afterReload.right - (parsed?.right ?? 0)) <= 4,
    JSON.stringify(afterReload),
  );

  console.log('\n5. Двойной клик и клавиатура');
  const handleRect = await cdp.evaluate(`(() => {
    const handle = document.querySelector('[aria-label="Изменить ширину правой панели"]');
    const box = handle.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + 100) };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handleRect.x, y: handleRect.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  for (const clickCount of [1, 2]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handleRect.x, y: handleRect.y, button: 'left', buttons: 1, clickCount, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handleRect.x, y: handleRect.y, button: 'left', buttons: 0, clickCount, pointerType: 'mouse' });
    await sleep(80);
  }
  await sleep(700);
  const afterReset = await tabsState();
  check(
    'двойной клик возвращает исходную ширину',
    afterReset.right.width === 320,
    `ширина: ${afterReset.right.width} px`,
  );

  // Клавиатура: фокус на границе и стрелка.
  await cdp.evaluate(`document.querySelector('[aria-label="Изменить ширину правой панели"]').focus(); 'ok'`);
  const beforeKey = afterReset.right.width;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
  await sleep(500);
  const afterKey = await tabsState();
  check(
    'стрелки меняют ширину с клавиатуры',
    afterKey.right.width === beforeKey + 16,
    `${beforeKey} → ${afterKey.right.width} px`,
  );

  console.log('\n6. Выбор инструмента сразу открывает его настройки');
  /** Состояние правой панели. */
  const rightPanel = () =>
    cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const aside = Array.from(document.querySelectorAll('aside')).find((element) =>
        element.querySelector('[aria-label="Изменить ширину правой панели"]'),
      );
      return {
        tab: app.ui.rightTab,
        open: Boolean(app.ui.rightPanelOpen),
        visible: Boolean(aside) && aside.getBoundingClientRect().width > 10,
        tool: app.editor.tool,
      };
    })()`);

  /** Нажатие клавиши (латинская раскладка). */
  const pressKey = async (key, code, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(450);
  };

  // Панель открыта на «Свойствах» — как у пользователя, который работает с объектом.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.ui.setRightTab('properties');
    app.editor.setTool('select');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(600);
  const beforeTools = await rightPanel();
  console.log('  до выбора инструмента:', JSON.stringify(beforeTools));
  check('исходно открыта вкладка «Свойства»', beforeTools.tab === 'properties', beforeTools.tab);

  const tools = [
    { key: 't', code: 'KeyT', vk: 84, tool: 'text', label: 'Текст' },
    { key: 'e', code: 'KeyE', vk: 69, tool: 'eraser', label: 'Корректор' },
    { key: 'p', code: 'KeyP', vk: 80, tool: 'stamp', label: 'Штамп' },
    { key: 'r', code: 'KeyR', vk: 82, tool: 'rect', label: 'Прямоугольник' },
  ];
  for (const item of tools) {
    await pressKey(item.key, item.code, item.vk);
    const state = await rightPanel();
    check(
      `инструмент «${item.label}» открывает свои настройки`,
      state.tool === item.tool && state.tab === 'tool' && state.visible,
      JSON.stringify(state),
    );
  }

  // Закрытая панель должна открыться при выборе инструмента.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.ui.setRightTab('properties');
    app.ui.rightPanelOpen = false;
    app.editor.setTool('select');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(700);
  const closedState = await rightPanel();
  check('панель закрыта перед проверкой', closedState.open === false && closedState.visible === false, JSON.stringify(closedState));
  await pressKey('b', 'KeyB', 66);
  const openedState = await rightPanel();
  console.log('  после выбора «Кисти» при закрытой панели:', JSON.stringify(openedState));
  check(
    'выбор инструмента открывает закрытую панель',
    openedState.open === true && openedState.visible === true && openedState.tab === 'tool',
    JSON.stringify(openedState),
  );

  // «Выбор» — единственный инструмент без автопереключения: свойства важнее.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.ui.setRightTab('properties');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(500);
  await pressKey('v', 'KeyV', 86);
  const selectState = await rightPanel();
  check(
    'инструмент «Выбор» не переключает вкладку',
    selectState.tool === 'select' && selectState.tab === 'properties',
    JSON.stringify(selectState),
  );

  console.log('\n7. Нанесение инструмента на холст открывает «Свойства»');
  // После перезагрузки из шага 4 документа нет — загружаем его снова.
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'тест.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type=file]');
    if (!input) return 'нет поля файла';
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(5000);
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(6000);
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); document.activeElement?.blur?.(); 'ok'`);
  await sleep(1200);
  check('документ снова загружен', (await cdp.evaluate(`window.__PDF_EDITOR__.pdf.isLoaded`)) === true);

  // Выбираем «Прямоугольник», панель уходит на «Инструмент», рисуем рамкой —
  // после создания объекта должна открыться вкладка «Свойства».
  await pressKey('r', 'KeyR', 82);
  const toolTab = await rightPanel();
  check('перед рисованием открыта вкладка «Инструмент»', toolTab.tab === 'tool', toolTab.tab);

  const canvasCenter = await cdp.evaluate(`(() => {
    const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width * 0.45), y: Math.round(rect.top + rect.height * 0.45) };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: canvasCenter.x, y: canvasCenter.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: canvasCenter.x, y: canvasCenter.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: canvasCenter.x + step * 12,
      y: canvasCenter.y + step * 8,
      button: 'left',
      buttons: 1,
      pointerType: 'mouse',
    });
    await sleep(20);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: canvasCenter.x + 96, y: canvasCenter.y + 64, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(1200);

  const afterDraw = await rightPanel();
  const drawnObjects = await cdp.evaluate(`window.__PDF_EDITOR__.objects.objects.map((object) => object.type)`);
  console.log('  после рисования:', JSON.stringify(afterDraw), 'объекты:', JSON.stringify(drawnObjects));
  check('объект создан на холсте', drawnObjects.includes('shape'), JSON.stringify(drawnObjects));
  check(
    'после нанесения инструмента открылась вкладка «Свойства»',
    afterDraw.tab === 'properties' && afterDraw.visible,
    JSON.stringify(afterDraw),
  );

  await cdp.screenshot(resolvePath(TMP, 'layout-panels.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

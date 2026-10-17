/**
 * Проверка подсказок у иконок инструментов и кнопок панелей.
 *
 * Пользователь сообщил, что при наведении на иконки инструментов подсказок не
 * видно: пузырёк был `absolute z-50` внутри шапки с `backdrop-blur` (свой
 * контекст наложения) и оказывался под холстом и панелями. Тест проверяет для
 * КАЖДОЙ кнопки с подсказкой:
 *   - подсказка появляется;
 *   - текст подсказки не пустой;
 *   - она целиком в пределах окна;
 *   - она действительно сверху: в центре пузырька `elementFromPoint` возвращает
 *     саму подсказку, а не холст/панель.
 *
 * Запуск: node scripts/check-tooltips.mjs
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9358 });

/**
 * Кнопки, обёрнутые в AppTooltip в указанной области.
 * Обёртка — `<span class="relative inline-flex">`.
 */
async function tooltipButtons(scope, index = 0) {
  return cdp.evaluate(`(() => {
    const root = document.querySelectorAll(${JSON.stringify(scope)})[${index}];
    if (!root) return [];
    return Array.from(root.querySelectorAll('button'))
      .map((button, buttonIndex) => {
        const parent = button.parentElement;
        const wrapped = Boolean(
          parent &&
          parent.tagName === 'SPAN' &&
          parent.classList.contains('relative') &&
          parent.classList.contains('inline-flex'),
        );
        if (!wrapped) return null;
        const rect = button.getBoundingClientRect();
        return {
          index: buttonIndex,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          label: (button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent || '').trim().slice(0, 40),
        };
      })
      .filter(Boolean);
  })()`);
}

/** Наведение на точку и снимок состояния подсказки. */
async function hoverAndInspect(point) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(160);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(420);
  return cdp.evaluate(`(() => {
    const tooltips = Array.from(document.querySelectorAll('[role=tooltip]'));
    if (tooltips.length === 0) return { count: 0 };
    const tooltip = tooltips[tooltips.length - 1];
    const box = tooltip.getBoundingClientRect();
    const style = getComputedStyle(tooltip);
    const cx = Math.round(box.left + box.width / 2);
    const cy = Math.round(box.top + box.height / 2);
    // У подсказки pointer-events: none, поэтому elementFromPoint её не видит —
    // на мгновение включаем события, чтобы проверить, что она действительно сверху.
    const previousEvents = tooltip.style.pointerEvents;
    tooltip.style.pointerEvents = 'auto';
    const top = document.elementFromPoint(cx, cy);
    tooltip.style.pointerEvents = previousEvents;
    return {
      count: tooltips.length,
      text: (tooltip.textContent || '').trim().slice(0, 60),
      insideViewport:
        box.left >= 0 &&
        box.top >= 0 &&
        box.right <= window.innerWidth &&
        box.bottom <= window.innerHeight,
      position: style.position,
      zIndex: Number(style.zIndex) || 0,
      onTop: Boolean(top && (top === tooltip || tooltip.contains(top))),
      box: { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) },
    };
  })()`);
}

/** Скрытие подсказки после ухода курсора. */
async function moveAway() {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(150);
  return cdp.evaluate(`document.querySelectorAll('[role=tooltip]').length`);
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
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); window.__PDF_EDITOR__.editor.setTool('select'); 'ok'`);
  await sleep(1200);

  console.log('\n1. Панель инструментов: подсказка у каждой кнопки');
  const toolbarButtons = await tooltipButtons('header');
  console.log(`  кнопок с подсказкой в шапке: ${toolbarButtons.length}`);
  check('в шапке найдены кнопки с подсказками', toolbarButtons.length >= 15, `найдено: ${toolbarButtons.length}`);

  let visibleCount = 0;
  const problems = [];
  for (const button of toolbarButtons) {
    const state = await hoverAndInspect(button);
    if (state.count === 0) {
      problems.push(`${button.label || 'без подписи'}: подсказка не появилась`);
      continue;
    }
    visibleCount += 1;
    const issues = [];
    if (!state.text) issues.push('пустой текст');
    if (!state.insideViewport) issues.push('выходит за окно');
    if (!state.onTop) issues.push('перекрыта другими элементами');
    if (state.position !== 'fixed') issues.push(`position=${state.position}`);
    if (state.zIndex < 100) issues.push(`z-index=${state.zIndex}`);
    if (issues.length > 0) {
      problems.push(`${button.label || state.text} (${JSON.stringify(state.box)}): ${issues.join(', ')}`);
    } else {
      console.log(`  ✓ подсказка «${state.text.split('\n')[0]}»`);
    }
    await moveAway();
  }
  check(
    'подсказка появляется у всех кнопок шапки',
    problems.length === 0,
    problems.join(' | '),
  );
  check('подсказки видны поверх интерфейса', visibleCount === toolbarButtons.length, `видимых: ${visibleCount} из ${toolbarButtons.length}`);

  console.log('\n2. Иконки инструментов (компактные кнопки)');
  const toolButtons = toolbarButtons.filter((button) => button.width <= 40 && button.height <= 40);
  console.log(`  иконок инструментов: ${toolButtons.length}`);
  check('иконки инструментов найдены', toolButtons.length >= 20, `найдено: ${toolButtons.length}`);

  let tooltipOk = 0;
  const toolProblems = [];
  for (const button of toolButtons) {
    const state = await hoverAndInspect(button);
    const ok =
      state.count > 0 &&
      Boolean(state.text) &&
      state.onTop &&
      state.insideViewport &&
      state.position === 'fixed' &&
      state.zIndex >= 100;
    if (ok) {
      tooltipOk += 1;
      console.log(`  ✓ ${state.text.split('\n')[0]}`);
    } else {
      toolProblems.push(`${JSON.stringify(button)} → ${JSON.stringify(state)}`);
    }
    await moveAway();
  }
  check(
    'у каждой иконки инструмента видимая подсказка',
    tooltipOk === toolButtons.length,
    toolProblems.join(' | '),
  );

  console.log('\n3. Подсказки внутри боковой панели');
  // Создаём объект и выделяем его, чтобы в панели появились кнопки с подсказками.
  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const object = factory.createTextObject({
      page: app.editor.currentPage, x: 120, y: 320, width: 240, height: 26,
      text: 'Подсказка в панели', autoHeight: true,
      defaults: { fontId: 'pt-sans', fontFamily: 'PT Sans', fontSize: 15, color: '#111111' },
    });
    app.objects.add([object], 'тест');
    app.objects.select([object.id]);
    app.editor.setTool('select');
    app.ui.setRightTab('layers');
    return 'ok';
  })()`);
  await sleep(1500);
  const panelButtons = await tooltipButtons('aside', 1);
  console.log(`  кнопок с подсказкой в правой панели: ${panelButtons.length}`);
  check('в панели есть кнопки с подсказками', panelButtons.length > 0, `найдено: ${panelButtons.length}`);
  if (panelButtons.length > 0) {
    let panelOk = 0;
    const panelProblems = [];
    for (const button of panelButtons.slice(0, 4)) {
      const state = await hoverAndInspect(button);
      const ok = state.count > 0 && state.onTop && state.insideViewport;
      if (ok) panelOk += 1;
      else panelProblems.push(`${JSON.stringify(button)} → ${JSON.stringify(state)}`);
      await moveAway();
    }
    check(
      'подсказки в панели видны и не обрезаются',
      panelOk === Math.min(4, panelButtons.length),
      panelProblems.join(' | '),
    );
    await cdp.screenshot(resolvePath(TMP, 'tooltips-panel.png'));
  }

  console.log('\n4. Подсказка скрывается при уходе курсора');
  const firstButton = toolbarButtons[0];
  await hoverAndInspect(firstButton);
  const afterAway = await moveAway();
  check('после ухода курсора подсказка скрывается', afterAway === 0, `осталось: ${afterAway}`);

  await cdp.evaluate(`window.__PDF_EDITOR__.ui.setRightTab('tool'); 'ok'`);
  await sleep(600);
  // Наводим на иконку «Корректор» для наглядного скриншота.
  let shot = null;
  for (const button of toolButtons) {
    const state = await hoverAndInspect(button);
    if (state.count > 0 && /Корректор/.test(state.text || '')) {
      shot = state;
      break;
    }
    await moveAway();
  }
  console.log('  подсказка для скриншота:', JSON.stringify(shot?.text ?? '(Корректор не найден)'));
  await cdp.screenshot(resolvePath(TMP, 'tooltips-toolbar.png'));

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

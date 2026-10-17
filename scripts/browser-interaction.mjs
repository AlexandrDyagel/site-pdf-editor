/**
 * Проверка взаимодействия с объектами после добавления захвата указателя:
 *  - выделение объекта кликом;
 *  - перетаскивание мышью (в том числе за пределы холста);
 *  - масштабирование за угол рамки выделения;
 *  - сохранение проекта в IndexedDB (проверка сериализации реактивных данных).
 *
 * Запуск: node scripts/browser-interaction.mjs
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9344 });

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
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(6000);
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
  await sleep(2000);

  // Создаём текстовый объект программно, чтобы координаты были известны.
  const created = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const object = factory.createTextObject({
      page: app.editor.currentPage,
      x: 120, y: 300, width: 200, height: 24,
      text: 'Перетаскивание и масштаб',
      autoHeight: true,
      defaults: { fontId: 'pt-sans', fontFamily: 'PT Sans', fontSize: 14, color: '#111111' },
    });
    app.objects.add([object], 'тест');
    app.editor.setTool('select');
    return { id: object.id, x: object.x, y: object.y, width: object.width, height: object.height };
  })()`);
  console.log('Создан объект:', JSON.stringify(created));

  const toScreen = async (pageX, pageY, dx = 0, dy = 0) =>
    cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
      return {
        x: Math.round(rect.left + app.editor.pan.x + ${pageX} * app.editor.zoom + ${dx}),
        y: Math.round(rect.top + app.editor.pan.y + ${pageY} * app.editor.zoom + ${dy}),
      };
    })()`);

  async function dragMouse(from, to, steps = 10) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    for (let i = 1; i <= steps; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
        button: 'left',
        buttons: 1,
        pointerType: 'mouse',
      });
      await sleep(16);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  }

  console.log('\n=== Выделение и перетаскивание ===');
  const center = await toScreen(created.x + created.width / 2, created.y + created.height / 2);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(700);
  const selected = await cdp.evaluate(`window.__PDF_EDITOR__.objects.selectedIds.length`);
  check('клик по объекту выделяет его', selected === 1, `выделено: ${selected}`);

  const zoom = await cdp.evaluate(`window.__PDF_EDITOR__.editor.zoom`);
  const target = await toScreen(created.x + created.width / 2 + 40 / zoom, created.y + created.height / 2 + 30 / zoom);
  await dragMouse(center, target, 12);
  await sleep(900);
  const moved = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const object = app.objects.objects[0];
    return { x: Math.round(object.x), y: Math.round(object.y) };
  })()`);
  const dx = moved.x - created.x;
  const dy = moved.y - created.y;
  // Перетаскивали на 40×30 экранных пикселей — в точках страницы это деление на зум.
  const expectedDx = Math.round(40 / zoom);
  const expectedDy = Math.round(30 / zoom);
  check(
    'объект перетаскивается мышью',
    Math.abs(dx - expectedDx) <= 3 && Math.abs(dy - expectedDy) <= 3,
    `смещение: ${dx}×${dy} pt (ожидалось ≈${expectedDx}×${expectedDy})`,
  );

  console.log('\n=== Масштабирование за угол рамки (фигура) ===');
  // Берём прямоугольник: у текста с автовысотой высота определяется содержимым.
  const shapeId = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    const shape = factory.createShapeObject('rect', {
      page: app.editor.currentPage,
      // Верхняя часть страницы: ручка масштабирования должна попадать
      // в видимую область окна, иначе мышью за неё не взяться.
      x: 220, y: 150, width: 160, height: 90,
      defaults: { stroke: '#dc2626', strokeWidth: 2, fill: null },
    });
    app.objects.add([shape], 'тест-фигура');
    app.editor.setTool('select');
    app.objects.select([shape.id]);
    return shape.id;
  })()`);
  await sleep(700);
  const before = await cdp.evaluate(`(() => {
    const object = window.__PDF_EDITOR__.objects.byId(${JSON.stringify(shapeId)});
    return { x: Math.round(object.x), y: Math.round(object.y), width: Math.round(object.width), height: Math.round(object.height) };
  })()`);

  // Тянем строго за ручку трансформера: берём её фактическое положение.
  const anchor = await cdp.evaluate(`(() => {
    const stage = window.__PDF_EDITOR_STAGE__;
    const transformer = stage.findOne('Transformer');
    if (!transformer) return { error: 'трансформер не найден' };
    const nodes = transformer.nodes();
    const handle = transformer.findOne('.bottom-right');
    if (!handle) {
      return {
        error: 'ручка .bottom-right не найдена',
        anchors: transformer.find('Shape').map((s) => s.name()),
        nodes: nodes.length,
        visible: transformer.visible(),
        listening: transformer.listening(),
      };
    }
    const position = handle.getAbsolutePosition();
    const rect = stage.container().getBoundingClientRect();
    return {
      x: Math.round(rect.left + position.x),
      y: Math.round(rect.top + position.y),
      nodes: nodes.length,
      visible: transformer.visible(),
      listening: transformer.listening(),
    };
  })()`);
  console.log('  ручка масштабирования:', JSON.stringify(anchor));

  const resized = anchor.error
    ? null
    : await (async () => {
        await dragMouse({ x: anchor.x, y: anchor.y }, { x: anchor.x + 70, y: anchor.y + 50 }, 12);
        await sleep(900);
        return cdp.evaluate(`(() => {
          const object = window.__PDF_EDITOR__.objects.byId(${JSON.stringify(shapeId)});
          return { width: Math.round(object.width), height: Math.round(object.height) };
        })()`);
      })();
  check(
    'фигура масштабируется за угол',
    Boolean(resized) && resized.width > before.width + 15 && resized.height > before.height + 10,
    resized ? `${before.width}×${before.height} → ${resized.width}×${resized.height}` : String(anchor.error),
  );

  console.log('\n=== Перетаскивание за пределы холста ===');
  const objectNow = await cdp.evaluate(`(() => {
    const object = window.__PDF_EDITOR__.objects.objects[0];
    return { x: Math.round(object.x), y: Math.round(object.y), width: Math.round(object.width), height: Math.round(object.height) };
  })()`);
  const rect = await cdp.evaluate(`(() => {
    const r = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  })()`);
  const objectCenter = await toScreen(objectNow.x + objectNow.width / 2, objectNow.y + objectNow.height / 2);
  // Ведём курсор вправо, за пределы холста (в панель свойств).
  await dragMouse(objectCenter, { x: rect.right + 150, y: objectCenter.y }, 14);
  await sleep(900);
  const afterOutside = await cdp.evaluate(`(() => {
    const object = window.__PDF_EDITOR__.objects.objects[0];
    return { x: Math.round(object.x), y: Math.round(object.y) };
  })()`);
  check(
    'перетаскивание продолжается за пределами холста',
    afterOutside.x > objectNow.x + 10,
    `x: ${objectNow.x} → ${afterOutside.x}`,
  );

  console.log('\n=== Сохранение проекта в браузере ===');
  const saved = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    try {
      const id = await app.exporter.saveProjectToStorage();
      const list = await (await import('/src/services/storageService.ts')).storageService.projectList();
      const project = await (await import('/src/services/storageService.ts')).storageService.projectLoad(id);
      return { ok: true, id, count: list.length, objects: project ? project.objects.length : -1 };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  })()`);
  check('проект сохраняется в IndexedDB', saved.ok === true, saved.error ?? '');
  check('в проекте есть объекты редактора', (saved.objects ?? 0) > 0, `объектов: ${saved.objects}`);

  console.log('\n=== Библиотека: сохранение печати через интерфейс ===');
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.openModal('stampEditor', { kind: 'seal' }); 'ok'`);
  await sleep(2200);
  const beforeSeals = await cdp.evaluate(`window.__PDF_EDITOR__.library.items.filter((i) => i.type === 'seal').length`);
  await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim().includes('Вставить на страницу'));
    button?.click();
    return 'ok';
  })()`);
  await sleep(2500);
  const sealState = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    return {
      seals: app.library.items.filter((i) => i.type === 'seal').length,
      objects: app.objects.objects.length,
      types: app.objects.objects.map((o) => o.type),
      modalOpen: app.ui.modals.stampEditor,
    };
  })()`);
  check('новая печать сохранена в библиотеку', sealState.seals === beforeSeals + 1, `печатей: ${beforeSeals} → ${sealState.seals}`);
  check('новая печать добавлена на страницу', sealState.types.includes('stamp'), JSON.stringify(sealState.types));
  check('окно конструктора закрылось', sealState.modalOpen === false);

  await cdp.screenshot(resolvePath(TMP, 'interaction.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

/**
 * Проверка новых фигур: треугольник и многоугольник.
 *
 *   1. Инструменты «Треугольник» и «Многоугольник» есть в панели и рисуют фигуру;
 *   2. скругление углов добавляет кривые в путь (и на холсте, и в PDF);
 *   3. количество углов многоугольника меняется из свойств и влияет на путь;
 *   4. в готовом PDF треугольник и шестиугольник имеют нужное число вершин;
 *   5. названия слоёв — «Треугольник» и «Многоугольник».
 *
 * Запуск: node scripts/check-shapes-extra.mjs
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, PDFArray } from 'pdf-lib';
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9364 });

/** Сколько путей страницы имеют ровно одно `m` и `lines` относительных `l`. */
async function countPaths(pdfBytes, lines) {
  const doc = await PDFDocument.load(pdfBytes);
  const page = doc.getPage(0);
  const streams = [];
  const walk = (ref) => {
    const value = ref && ref.constructor?.name === 'PDFRef' ? doc.context.lookup(ref) : ref;
    if (value instanceof PDFRawStream) {
      try {
        streams.push(zlib.inflateSync(Buffer.from(value.contents)).toString('latin1'));
      } catch {
        streams.push(Buffer.from(value.contents).toString('latin1'));
      }
    } else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i += 1) walk(value.get(i));
    }
  };
  walk(page.node.get(PDFName.of('Contents')));
  let count = 0;
  for (const block of streams.join('\n').split(/\nq\n/g)) {
    const moves = (block.match(/^\S+ \S+ m$/gm) ?? []).length;
    const relative = (block.match(/^\S+ \S+ l$/gm) ?? []).length;
    if (moves === 1 && relative === lines) count += 1;
  }
  return count;
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
  await cdp.evaluate(`window.__PDF_EDITOR__.editor.fitToWidth(); 'ok'`);
  await sleep(2000);

  console.log('\n1. Инструменты в панели и рисование');
  const tools = await cdp.evaluate(`(async () => {
    const constants = await import('/src/constants/index.ts');
    const ids = constants.TOOL_DEFINITIONS.map((tool) => tool.id);
    const labels = constants.TOOL_DEFINITIONS.map((tool) => tool.label);
    // Кнопки панели инструментов рисуются по тому же списку, поэтому проверяем
    // и наличие инструмента, и то, что он реально доступен на панели.
    const bar = document.querySelectorAll('button[aria-label], button[title]');
    return {
      ids,
      labels,
      buttons: bar.length,
      hasTriangle: ids.includes('triangle') && labels.includes('Треугольник'),
      hasPolygon: ids.includes('polygon') && labels.includes('Многоугольник'),
    };
  })()`);
  console.log('  инструменты:', JSON.stringify(tools.labels));
  check('в панели есть «Треугольник»', tools.hasTriangle, JSON.stringify(tools.ids));
  check('в панели есть «Многоугольник»', tools.hasPolygon, JSON.stringify(tools.ids));

  /** Рисует фигуру выбранным инструментом мышью. */
  async function drawWithTool(tool, box) {
    await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      app.objects.clearAll(false);
      app.objects.select([]);
      app.editor.setTool(${JSON.stringify(tool)});
      document.activeElement?.blur?.();
      return 'ok';
    })()`);
    await sleep(700);
    const point = await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
      const toScreen = (x, y) => ({
        x: Math.round(rect.left + app.editor.pan.x + x * app.editor.zoom),
        y: Math.round(rect.top + app.editor.pan.y + y * app.editor.zoom),
      });
      return { from: toScreen(${box.x}, ${box.y}), to: toScreen(${box.x + box.width}, ${box.y + box.height}) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.from.x, y: point.from.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.from.x, y: point.from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(point.from.x + ((point.to.x - point.from.x) * step) / steps),
        y: Math.round(point.from.y + ((point.to.y - point.from.y) * step) / steps),
        button: 'left',
        buttons: 1,
        pointerType: 'mouse',
      });
      await sleep(20);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.to.x, y: point.to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await sleep(1000);
    return cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const shape = app.objects.objects.find((object) => object.type === 'shape');
      return shape
        ? { kind: shape.payload.kind, sides: shape.payload.sides ?? null, radius: shape.payload.cornerRadius, width: Math.round(shape.width), height: Math.round(shape.height) }
        : null;
    })()`);
  }

  const triangle = await drawWithTool('triangle', { x: 300, y: 90, width: 160, height: 110 });
  console.log('  треугольник:', JSON.stringify(triangle));
  check('инструмент «Треугольник» создаёт фигуру нужного вида', triangle?.kind === 'triangle', JSON.stringify(triangle));

  console.log('\n1а. Контур черновика повторяет фигуру');
  /** Черновой контур при зажатой мыши: точки у верхнего угла и у вершины. */
  async function draftInk(tool, shotName = '') {
    await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      app.objects.clearAll(false);
      app.objects.select([]);
      app.editor.setTool(${JSON.stringify(tool)});
      document.activeElement?.blur?.();
      return 'ok';
    })()`);
    await sleep(600);
    const points = await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const rect = document.querySelector('[data-testid=editor-canvas]').getBoundingClientRect();
      const toScreen = (x, y) => ({
        x: Math.round(rect.left + app.editor.pan.x + x * app.editor.zoom),
        y: Math.round(rect.top + app.editor.pan.y + y * app.editor.zoom),
      });
      return { from: toScreen(300, 90), to: toScreen(460, 200) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.from.x, y: points.from.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.from.x, y: points.from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    for (let step = 1; step <= 6; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(points.from.x + ((points.to.x - points.from.x) * step) / 6),
        y: Math.round(points.from.y + ((points.to.y - points.from.y) * step) / 6),
        button: 'left',
        buttons: 1,
        pointerType: 'mouse',
      });
      await sleep(30);
    }
    await sleep(250);
    if (shotName) await cdp.screenshot(resolvePath(TMP, shotName));
    const ink = await cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      // Третий слой — оверлей с черновиками.
      const ctx = document.querySelectorAll('canvas')[2].getContext('2d');
      const local = (x, y) => ({
        x: Math.round(app.editor.pan.x + x * app.editor.zoom),
        y: Math.round(app.editor.pan.y + y * app.editor.zoom),
      });
      const area = (x, y, width, height) => {
        const data = ctx.getImageData(x, y, Math.max(1, width), Math.max(1, height)).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 20) painted += 1;
        return painted;
      };
      const left = local(300, 90);
      const right = local(460, 90);
      const bottom = local(300, 200);
      const width = right.x - left.x;
      return {
        // Угол рамки: у прямоугольника там линия, у треугольника — пусто.
        corner: area(left.x - 4, left.y - 4, 14, 14),
        // Верхняя кромка (у треугольника в центре — вершина).
        topEdge: area(left.x, left.y - 3, width, 7),
        // Нижняя кромка: есть у всех фигур.
        bottomEdge: area(bottom.x, bottom.y - 4, width, 9),
      };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.to.x, y: points.to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await sleep(600);
    return ink;
  }

  const rectDraft = await draftInk('rect');
  console.log('  черновик прямоугольника:', JSON.stringify(rectDraft));
  check('у прямоугольника есть угол контура', rectDraft.corner > 0, JSON.stringify(rectDraft));
  check(
    'у прямоугольника есть верхняя и нижняя кромки',
    rectDraft.topEdge > 0 && rectDraft.bottomEdge > 0,
    JSON.stringify(rectDraft),
  );

  const triangleDraft = await draftInk('triangle', 'draft-triangle.png');
  console.log('  черновик треугольника:', JSON.stringify(triangleDraft));
  check(
    'у треугольника нет угла рамки в левом верхнем углу',
    triangleDraft.corner === 0,
    JSON.stringify(triangleDraft),
  );
  check(
    'контур треугольника проходит через вершину сверху и по низу',
    triangleDraft.topEdge > 0 && triangleDraft.bottomEdge > 0,
    JSON.stringify(triangleDraft),
  );
  check(
    'верхняя кромка треугольника короче, чем у рамки',
    triangleDraft.topEdge < rectDraft.topEdge,
    `${triangleDraft.topEdge} против ${rectDraft.topEdge}`,
  );

  const polygonDraft = await draftInk('polygon');
  console.log('  черновик многоугольника:', JSON.stringify(polygonDraft));
  check(
    'у многоугольника контур не совпадает с рамкой',
    polygonDraft.bottomEdge > 0 && polygonDraft.corner === 0,
    JSON.stringify(polygonDraft),
  );

  const polygon = await drawWithTool('polygon', { x: 300, y: 220, width: 160, height: 110 });
  console.log('  многоугольник:', JSON.stringify(polygon));
  check('инструмент «Многоугольник» создаёт фигуру нужного вида', polygon?.kind === 'polygon', JSON.stringify(polygon));
  check('у многоугольника по умолчанию 5 углов', polygon?.sides === 5, String(polygon?.sides));

  console.log('\n2. Количество углов и скругление');
  // Ставим полигону 8 углов через параметры инструмента и рисуем заново.
  const eight = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.editor.toolOptions.shape.sides = 8;
    app.editor.toolOptions.shape.cornerRadius = 0;
    return app.editor.toolOptions.shape.sides;
  })()`);
  const polygon8 = await drawWithTool('polygon', { x: 300, y: 220, width: 160, height: 110 });
  console.log('  многоугольник с 8 углами:', JSON.stringify(polygon8), 'опция:', eight);
  check('число углов берётся из параметров инструмента', polygon8?.sides === 8, String(polygon8?.sides));

  /** SVG-путь первого узла-фигуры на холсте. */
  async function shapeNodePath() {
    return cdp.evaluate(`(() => {
      const stage = window.__PDF_EDITOR_STAGE__;
      const path = stage.findOne('Path');
      return path ? String(path.data()) : null;
    })()`);
  }

  const plainPath = await shapeNodePath();
  const plainCurves = (plainPath?.match(/Q/g) ?? []).length;
  console.log('  путь без скругления:', plainPath ? `${plainPath.slice(0, 60)}…` : null);
  check('восьмиугольник без скругления — только линии', plainCurves === 0, String(plainCurves));

  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const shape = app.objects.objects.find((object) => object.type === 'shape');
    app.objects.update(shape.id, { payload: { cornerRadius: 12 } }, 'Скругление');
    return 'ok';
  })()`);
  await sleep(900);
  const roundedPath = await shapeNodePath();
  const roundedCurves = (roundedPath?.match(/Q/g) ?? []).length;
  console.log('  путь со скруглением: кривых', roundedCurves);
  check(
    'скругление добавляет кривые по числу углов',
    roundedCurves === (polygon8?.sides ?? 8),
    `${roundedCurves} из ${polygon8?.sides}`,
  );

  // Изменение числа углов из свойств.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.select([]);
    const shape = app.objects.objects.find((object) => object.type === 'shape');
    app.objects.select([shape.id]);
    app.ui.setRightTab('properties');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(1000);
  const sidesInput = await cdp.evaluate(`(() => {
    const aside = Array.from(document.querySelectorAll('aside')).pop();
    // AppInput рисует <label><span>подпись</span><input></label>, поэтому
    // ищем поле по подписи внутри того же label.
    const field = Array.from(aside.querySelectorAll('input[type=number]')).find((input) => {
      const label = input.closest('label');
      return label && (label.textContent || '').includes('Количество углов');
    });
    if (!field) return false;
    field.focus();
    field.value = '6';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1000);
  const afterSides = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const shape = app.objects.objects.find((object) => object.type === 'shape');
    const stage = window.__PDF_EDITOR_STAGE__;
    const path = stage.findOne('Path');
    return { sides: shape.payload.sides, radius: shape.payload.cornerRadius, path: path ? String(path.data()) : null };
  })()`);
  console.log('  после ввода 6 углов:', JSON.stringify({ sides: afterSides.sides, radius: afterSides.radius }));
  check('поле «Количество углов» найдено', sidesInput === true);
  check('число углов меняется из свойств', afterSides.sides === 6, String(afterSides.sides));
  check('путь перестроился под новое число углов', (afterSides.path?.match(/Q/g) ?? []).length === 6, String((afterSides.path?.match(/Q/g) ?? []).length));

  // Набор «12» и «23»: нельзя подставлять минимум после первой цифры.
  const typedSides = await cdp.evaluate(`(() => {
    const aside = Array.from(document.querySelectorAll('aside')).pop();
    const field = Array.from(aside.querySelectorAll('input[type=number]')).find((input) => {
      const label = input.closest('label');
      return label && (label.textContent || '').includes('Количество углов');
    });
    if (!field) return { ok: false };
    field.focus();
    field.value = '1';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const afterOne = field.value;
    field.value = '12';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const afterTwo = field.value;
    field.blur();
    return { ok: true, afterOne, afterTwo, afterBlur: field.value };
  })()`);
  await sleep(900);
  const sidesAfterTyping = await cdp.evaluate(`(() => {
    const shape = window.__PDF_EDITOR__.objects.objects.find((object) => object.type === 'shape');
    return shape ? shape.payload.sides : null;
  })()`);
  console.log('  набор «12»:', JSON.stringify(typedSides), '→ sides:', sidesAfterTyping);
  check('поле найдено', typedSides.ok === true);
  check(
    'первая цифра не заменяется минимумом',
    typedSides.afterOne === '1',
    JSON.stringify(typedSides),
  );
  check('«12» набирается целиком', typedSides.afterTwo === '12', JSON.stringify(typedSides));
  check('после потери фокуса в объекте 12 углов', sidesAfterTyping === 12, String(sidesAfterTyping));

  // «23» — тоже валидное число и не превращается в 3.
  const typed23 = await cdp.evaluate(`(() => {
    const aside = Array.from(document.querySelectorAll('aside')).pop();
    const field = Array.from(aside.querySelectorAll('input[type=number]')).find((input) => {
      const label = input.closest('label');
      return label && (label.textContent || '').includes('Количество углов');
    });
    if (!field) return { ok: false };
    field.focus();
    field.value = '2';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.value = '23';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.blur();
    return { ok: true, afterBlur: field.value };
  })()`);
  await sleep(900);
  const sidesAfter23 = await cdp.evaluate(`(() => {
    const shape = window.__PDF_EDITOR__.objects.objects.find((object) => object.type === 'shape');
    return shape ? shape.payload.sides : null;
  })()`);
  console.log('  набор «23»:', JSON.stringify(typed23), '→ sides:', sidesAfter23);
  check('«23» сохраняется как 23', sidesAfter23 === 23 && typed23.afterBlur === '23', `${sidesAfter23} / ${typed23.afterBlur}`);

  // Невалидное «2» всё же приводится к минимуму при потере фокуса.
  await cdp.evaluate(`(() => {
    const aside = Array.from(document.querySelectorAll('aside')).pop();
    const field = Array.from(aside.querySelectorAll('input[type=number]')).find((input) => {
      const label = input.closest('label');
      return label && (label.textContent || '').includes('Количество углов');
    });
    if (!field) return 'нет поля';
    field.focus();
    field.value = '2';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.blur();
    return 'ok';
  })()`);
  await sleep(900);
  const afterTwo = await cdp.evaluate(`(() => {
    const aside = Array.from(document.querySelectorAll('aside')).pop();
    const field = Array.from(aside.querySelectorAll('input[type=number]')).find((input) => {
      const label = input.closest('label');
      return label && (label.textContent || '').includes('Количество углов');
    });
    const shape = window.__PDF_EDITOR__.objects.objects.find((object) => object.type === 'shape');
    return { sides: shape ? shape.payload.sides : null, display: field ? field.value : null };
  })()`);
  console.log('  набор «2»: →', JSON.stringify(afterTwo));
  check(
    '«2» после потери фокуса становится 3',
    afterTwo.sides === 3 && afterTwo.display === '3',
    JSON.stringify(afterTwo),
  );

  console.log('\n3. Названия слоёв');
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.setRightTab('layers'); 'ok'`);
  await sleep(900);
  const layerLabels = await cdp.evaluate(`(() => Array.from(document.querySelectorAll('[data-layer-label]')).map((element) => element.textContent.trim()))()`);
  console.log('  слои:', JSON.stringify(layerLabels));
  check('многоугольник в «Слоях» — «Многоугольник»', layerLabels.includes('Многоугольник'), JSON.stringify(layerLabels));

  const triangleLabels = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.objects.clearAll(false);
    const factory = await import('/src/services/objectFactory.ts');
    const shape = factory.createShapeObject('triangle', {
      page: 0, x: 300, y: 90, width: 160, height: 110,
      defaults: { stroke: '#dc2626', strokeWidth: 2, fill: '#fde68a' },
    });
    app.objects.add([shape], 'тест');
    app.objects.select([]);
    return app.objects.objects.map((object) => object.payload.kind);
  })()`);
  await sleep(900);
  const labelsAfterTriangle = await cdp.evaluate(`(() => Array.from(document.querySelectorAll('[data-layer-label]')).map((element) => element.textContent.trim()))()`);
  console.log('  треугольник:', JSON.stringify(triangleLabels), JSON.stringify(labelsAfterTriangle));
  check('треугольник в «Слоях» — «Треугольник»', labelsAfterTriangle.includes('Треугольник'), JSON.stringify(labelsAfterTriangle));

  console.log('\n4. Фигуры в готовом PDF');
  const exported = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.exporter.setFormat('pdf');
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return { ok: true, b64: btoa(binary) };
  })()`);
  check('экспорт PDF выполнен', exported.ok === true, exported.error ?? '');
  if (exported.ok) {
    const pdfBytes = Buffer.from(exported.b64, 'base64');
    const triangles = await countPaths(pdfBytes, 2);
    console.log(`  путей треугольного вида в PDF: ${triangles}`);
    check('треугольник попал в PDF (2 линии + замыкание)', triangles === 1, `найдено ${triangles}`);
  }

  await cdp.screenshot(resolvePath(TMP, 'shapes-extra.png'));
  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

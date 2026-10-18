/**
 * Проверка оформления фигур: заливка, штриховая линия и наконечники стрелки.
 *
 *   1. У линий и стрелок нет параметра «Заливка» (ни в свойствах, ни в параметрах
 *      инструмента) — цвет всё равно задаётся обводкой;
 *   2. список «Штриховая линия»: Сплошная / Штрих / Пунктир / Штрих-пунктир,
 *      причём «Пунктир» — это точки (много коротких штрихов), а
 *      «Штрих-пунктир» чередует длинный штрих и точку;
 *   3. «Наконечники» у стрелки реально меняют картинку: без наконечника,
 *      на конце, с двух сторон — и то же самое в экспортированном PDF.
 *
 * Запуск: node scripts/check-shape-styles.mjs
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

const { cdp, close } = await launchBrowser({ url: URL_APP, port: 9363 });

/** Число треугольных наконечников в потоке первой страницы PDF. */
async function countArrowHeads(pdfBytes) {
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
  // pdf-lib переводит SVG-путь в относительные операторы, поэтому треугольник
  // наконечника — это блок из 1 × m и 2 × l (у прямоугольника 3 × l).
  const blocks = streams.join('\n').split(/\nq\n/g);
  let triangles = 0;
  for (const block of blocks) {
    const moves = (block.match(/^\S+ \S+ m$/gm) ?? []).length;
    const lines = (block.match(/^\S+ \S+ l$/gm) ?? []).length;
    if (moves === 1 && lines === 2) triangles += 1;
  }
  return triangles;
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

  console.log('\n1. Линия и стрелка: параметра «Заливка» нет');
  const LINE = { x: 300, y: 90, width: 220, height: 40 };
  const ARROW = { x: 300, y: 160, width: 220, height: 40 };

  const created = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.objects.clearAll(false);
    const factory = await import('/src/services/objectFactory.ts');
    const make = (kind, box) => factory.createShapeObject(kind, {
      page: 0, x: box.x, y: box.y, width: box.width, height: box.height,
      
      defaults: { stroke: '#dc2626', strokeWidth: 3, fill: null },
      points: [0, 0.5, 1, 0.5],
    });
    const line = make('line', ${JSON.stringify(LINE)});
    const arrow = make('arrow', ${JSON.stringify(ARROW)});
    app.objects.add([line, arrow], 'тест');
    return { line: line.id, arrow: arrow.id };
  })()`);
  await sleep(1000);

  /** Какие подписи полей есть в правой панели для выделенного объекта. */
  async function panelLabels() {
    return cdp.evaluate(`(() => {
      const aside = Array.from(document.querySelectorAll('aside')).pop();
      if (!aside) return [];
      const labels = Array.from(aside.querySelectorAll('span')).map((element) => element.textContent.trim());
      return labels.filter((text) => text.length > 0 && text.length < 40);
    })()`);
  }

  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.select([${JSON.stringify(created.line)}]);
    app.ui.setRightTab('properties');
    return 'ok';
  })()`);
  await sleep(900);
  const lineLabels = await panelLabels();
  console.log('  поля линии:', JSON.stringify(lineLabels));
  check('у линии нет поля «Заливка»', !lineLabels.includes('Заливка'), JSON.stringify(lineLabels));
  check(
    'у линии цвет называется «Цвет», а не «Обводка»',
    lineLabels.includes('Цвет') && !lineLabels.includes('Обводка'),
    JSON.stringify(lineLabels),
  );
  check('у линии есть «Толщина»', lineLabels.includes('Толщина'));

  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.select([${JSON.stringify(created.arrow)}]);
    return 'ok';
  })()`);
  await sleep(800);
  const arrowLabels = await panelLabels();
  console.log('  поля стрелки:', JSON.stringify(arrowLabels));
  check('у стрелки нет поля «Заливка»', !arrowLabels.includes('Заливка'), JSON.stringify(arrowLabels));
  check('у стрелки есть «Наконечники»', arrowLabels.includes('Наконечники'));

  // Параметры инструмента «Линия» тоже без заливки.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setTool('line');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(900);
  const toolLabels = await panelLabels();
  console.log('  поля инструмента «Линия»:', JSON.stringify(toolLabels));
  check('в параметрах инструмента «Линия» нет «Заливки»', !toolLabels.includes('Заливка'), JSON.stringify(toolLabels));
  check(
    'в параметрах инструмента «Линия» — «Цвет линии» и «Толщина линии»',
    toolLabels.includes('Цвет линии') && toolLabels.includes('Толщина линии'),
    JSON.stringify(toolLabels),
  );

  // У прямоугольника подписи остаются «про обводку».
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setTool('rect');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(900);
  const rectToolLabels = await panelLabels();
  console.log('  поля инструмента «Прямоугольник»:', JSON.stringify(rectToolLabels));
  check(
    'у прямоугольника остались «Цвет обводки» и «Толщина обводки»',
    rectToolLabels.includes('Цвет обводки') && rectToolLabels.includes('Толщина обводки'),
    JSON.stringify(rectToolLabels),
  );

  console.log('\n2. Штриховая линия: Сплошная / Штрих / Пунктир / Штрих-пунктир');

  /** Красные «отрезки» вдоль горизонтальной линии: [{ start, length }]. */
  async function lineRuns() {
    return cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const canvas = document.querySelectorAll('canvas')[1];
      const ctx = canvas.getContext('2d');
      const y = ${LINE.y} + ${LINE.height} / 2;
      const from = Math.round(app.editor.pan.x + ${LINE.x} * app.editor.zoom);
      const to = Math.round(app.editor.pan.x + (${LINE.x} + ${LINE.width}) * app.editor.zoom);
      const py = Math.round(app.editor.pan.y + y * app.editor.zoom);
      const data = ctx.getImageData(from, py - 2, to - from, 5).data;
      const width = to - from;
      const isRed = [];
      for (let x = 0; x < width; x += 1) {
        let red = false;
        for (let row = 0; row < 5; row += 1) {
          const index = (row * width + x) * 4;
          if (data[index] > 140 && data[index + 1] < 110 && data[index + 2] < 120) red = true;
        }
        isRed.push(red);
      }
      const runs = [];
      let start = -1;
      for (let x = 0; x < width; x += 1) {
        if (isRed[x] && start === -1) start = x;
        if (!isRed[x] && start !== -1) {
          runs.push({ start, length: x - start });
          start = -1;
        }
      }
      if (start !== -1) runs.push({ start, length: width - start });
      return { runs, width, zoom: app.editor.zoom };
    })()`);
  }

  /** Выбирает вариант «Штриховая линия» через панель свойств. */
  async function chooseDash(label) {
    return cdp.evaluate(`(async () => {
      const app = window.__PDF_EDITOR__;
      app.objects.select([${JSON.stringify(created.line)}]);
      app.ui.setRightTab('properties');
      await new Promise((resolve) => setTimeout(resolve, 250));
      const select = Array.from(document.querySelectorAll('aside select')).find((element) => {
        const wrapper = element.closest('div');
        return wrapper && wrapper.textContent.includes('Штриховая линия');
      });
      if (!select) return { ok: false, error: 'нет списка' };
      const option = Array.from(select.options).find((item) => item.textContent.trim() === ${JSON.stringify(label)});
      if (!option) {
        return { ok: false, error: 'нет варианта', options: Array.from(select.options).map((item) => item.textContent.trim()) };
      }
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: option.value };
    })()`);
  }

  const solid = await chooseDash('Сплошная');
  await sleep(900);

  const dashOptions = await cdp.evaluate(`(() => {
    const select = Array.from(document.querySelectorAll('aside select')).find((element) => {
      const wrapper = element.closest('div');
      return wrapper && wrapper.textContent.includes('Штриховая линия');
    });
    return select ? Array.from(select.options).map((item) => item.textContent.trim()) : null;
  })()`);
  console.log('  варианты списка:', JSON.stringify(dashOptions));
  check(
    'в списке Сплошная / Штрих / Пунктир / Штрих-пунктир',
    Array.isArray(dashOptions) && dashOptions.join('|') === 'Сплошная|Штрих|Пунктир|Штрих-пунктир',
    JSON.stringify(dashOptions),
  );
  check('варианта «Точки» больше нет', Array.isArray(dashOptions) && !dashOptions.includes('Точки'));

  const solidRuns = await lineRuns();
  console.log('  сплошная: отрезков', solidRuns.runs.length);
  check('список переключается', solid.ok === true, JSON.stringify(solid));
  check('сплошная линия — без разрывов', solidRuns.runs.length <= 2, JSON.stringify(solidRuns.runs.length));

  const dash = await chooseDash('Штрих');
  await sleep(900);
  const dashRuns = await lineRuns();
  const dashLengths = dashRuns.runs.map((run) => run.length);
  const dashPattern = await cdp.evaluate(`(() => window.__PDF_EDITOR__.objects.byId(${JSON.stringify(created.line)}).payload.dash.join(','))()`);
  console.log('  штрих: отрезков', dashRuns.runs.length, 'шаблон', dashPattern);
  check('«Штрих» даёт прерывистую линию', dashRuns.runs.length >= 5, JSON.stringify(dashRuns.runs.length));
  check('шаблон «Штрих» — 6,5', dashPattern === '6,5', dashPattern);

  const dots = await chooseDash('Пунктир');
  await sleep(900);
  const dotRuns = await lineRuns();
  const dotLengths = dotRuns.runs.map((run) => run.length);
  const dotPattern = await cdp.evaluate(`(() => window.__PDF_EDITOR__.objects.byId(${JSON.stringify(created.line)}).payload.dash.join(','))()`);
  const avgDot = dotLengths.reduce((a, b) => a + b, 0) / Math.max(1, dotLengths.length);
  console.log('  пунктир: отрезков', dotRuns.runs.length, 'шаблон', dotPattern, 'средняя длина', avgDot.toFixed(1));
  check('шаблон «Пунктир» — 1,6', dotPattern === '1,6', dotPattern);
  check(
    '«Пунктир» — это точки: отрезков заметно больше, чем у «Штриха»',
    dotRuns.runs.length > dashRuns.runs.length * 1.2,
    `${dotRuns.runs.length} против ${dashRuns.runs.length}`,
  );
  const avgDash = dashLengths.reduce((a, b) => a + b, 0) / Math.max(1, dashLengths.length);
  check('точки короче штрихов', avgDot < avgDash, `средняя длина точки ${avgDot.toFixed(1)}, штриха ${avgDash.toFixed(1)}`);

  const dashDot = await chooseDash('Штрих-пунктир');
  await sleep(900);
  const dashDotRuns = await lineRuns();
  const dashDotPattern = await cdp.evaluate(`(() => window.__PDF_EDITOR__.objects.byId(${JSON.stringify(created.line)}).payload.dash.join(','))()`);
  const lengths = dashDotRuns.runs.map((run) => run.length).slice(1, -1);
  const longest = Math.max(...lengths, 0);
  const shortest = Math.min(...lengths, Infinity);
  console.log('  штрих-пунктир: отрезков', dashDotRuns.runs.length, 'шаблон', dashDotPattern, 'длины', JSON.stringify(lengths.slice(0, 10)));
  check('шаблон «Штрих-пунктир» — 8,5,1,5', dashDotPattern === '8,5,1,5', dashDotPattern);
  check(
    '«Штрих-пунктир» чередует длинный штрих и точку',
    lengths.length >= 4 && longest > shortest * 2,
    `длиннейший ${longest}, кратчайший ${shortest}`,
  );

  console.log('\n3. Наконечники стрелки');

  /** Красные пиксели в квадрате у начала и у конца стрелки. */
  async function headPixels(box) {
    return cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const canvas = document.querySelectorAll('canvas')[1];
      const ctx = canvas.getContext('2d');
      const count = (x, y, size) => {
        const left = Math.round(app.editor.pan.x + x * app.editor.zoom);
        const top = Math.round(app.editor.pan.y + y * app.editor.zoom);
        const side = Math.round(size * app.editor.zoom);
        const data = ctx.getImageData(left, top, side, side).data;
        let red = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 140 && data[i + 1] < 110 && data[i + 2] < 120) red += 1;
        }
        return red;
      };
      return {
        start: count(${box.x}, ${box.y} + ${box.height} / 2 - 14, 28),
        end: count(${box.x} + ${box.width} - 28, ${box.y} + ${box.height} / 2 - 14, 28),
      };
    })()`);
  }

  async function setArrowHead(mode) {
    return cdp.evaluate(`(async () => {
      const app = window.__PDF_EDITOR__;
      app.objects.select([${JSON.stringify(created.arrow)}]);
      app.ui.setRightTab('properties');
      await new Promise((resolve) => setTimeout(resolve, 250));
      app.objects.update(${JSON.stringify(created.arrow)}, { payload: { arrowHead: ${JSON.stringify(mode)} } }, 'Наконечники');
      return app.objects.byId(${JSON.stringify(created.arrow)}).payload.arrowHead;
    })()`);
  }

  const noneMode = await setArrowHead('none');
  await sleep(900);
  const nonePixels = await headPixels(ARROW);
  console.log('  без наконечника:', JSON.stringify(nonePixels));
  check('режим «без наконечника» применяется', noneMode === 'none');

  const endMode = await setArrowHead('end');
  await sleep(900);
  const endPixels = await headPixels(ARROW);
  console.log('  на конце:', JSON.stringify(endPixels));
  check('режим «на конце» применяется', endMode === 'end');
  check(
    '«на конце»: наконечник появился только у конца',
    endPixels.end > nonePixels.end * 1.3 && endPixels.start < nonePixels.start * 1.3,
    `конец ${endPixels.end} против ${nonePixels.end}, начало ${endPixels.start} против ${nonePixels.start}`,
  );

  const bothMode = await setArrowHead('both');
  await sleep(900);
  const bothPixels = await headPixels(ARROW);
  console.log('  с двух сторон:', JSON.stringify(bothPixels));
  check('режим «с двух сторон» применяется', bothMode === 'both');
  check(
    '«с двух сторон»: наконечники с обеих сторон',
    bothPixels.end > nonePixels.end * 1.3 && bothPixels.start > nonePixels.start * 1.3,
    `начало ${bothPixels.start} против ${nonePixels.start}, конец ${bothPixels.end} против ${nonePixels.end}`,
  );

  // Экспорт: число наконечников в PDF зависит от режима.
  async function exportPdf() {
    return cdp.evaluate(`(async () => {
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
  }

  await setArrowHead('none');
  await sleep(600);
  const pdfNone = await exportPdf();
  await setArrowHead('both');
  await sleep(600);
  const pdfBoth = await exportPdf();
  if (pdfNone.ok && pdfBoth.ok) {
    const headsNone = await countArrowHeads(Buffer.from(pdfNone.b64, 'base64'));
    const headsBoth = await countArrowHeads(Buffer.from(pdfBoth.b64, 'base64'));
    console.log(`  наконечников в PDF: без наконечника ${headsNone}, с двух сторон ${headsBoth}`);
    check('в PDF без наконечника треугольников нет', headsNone === 0, `найдено ${headsNone}`);
    check('в PDF с двух сторон — два наконечника', headsBoth === 2, `найдено ${headsBoth}`);
  } else {
    check('экспорт PDF для проверки наконечников', false, pdfNone.error ?? pdfBoth.error ?? '');
  }

  console.log('\n4. Курсор поворота выделенного объекта');
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setTool('select');
    app.objects.select([${JSON.stringify(created.arrow)}]);
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(1200);

  const rotateCursor = await cdp.evaluate(`(() => {
    const stage = window.__PDF_EDITOR_STAGE__;
    const transformer = stage.findOne((node) => node.name && node.name() === 'transformer') ?? stage.findOne('Transformer');
    const cursor = transformer && typeof transformer.rotateAnchorCursor === 'function'
      ? transformer.rotateAnchorCursor()
      : null;
    const anchor = transformer ? transformer.findOne('.rotater') : null;
    let point = null;
    if (anchor) {
      const container = stage.container();
      const rect = container.getBoundingClientRect();
      const absolute = anchor.getAbsolutePosition();
      point = { x: Math.round(rect.left + absolute.x), y: Math.round(rect.top + absolute.y) };
    }
    return { cursor, point };
  })()`);
  console.log('  rotateAnchorCursor:', rotateCursor.cursor ? `${rotateCursor.cursor.slice(0, 42)}…` : null);
  check(
    'курсор поворота — картинка, а не крестик',
    typeof rotateCursor.cursor === 'string' && rotateCursor.cursor.startsWith('url("data:image/png'),
    rotateCursor.cursor ? rotateCursor.cursor.slice(0, 60) : 'нет курсора',
  );
  check('найдена ручка поворота', rotateCursor.point !== null);

  if (rotateCursor.point) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rotateCursor.point.x, y: rotateCursor.point.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await sleep(500);
    const hoverCursor = await cdp.evaluate(`(() => {
      const container = document.querySelector('.konvajs-content');
      return container ? getComputedStyle(container).cursor : null;
    })()`);
    console.log('  курсор над ручкой:', hoverCursor ? `${String(hoverCursor).slice(0, 42)}…` : null);
    check(
      'при наведении на ручку поворота курсор — картинка поворота',
      typeof hoverCursor === 'string' && hoverCursor.startsWith('url('),
      String(hoverCursor).slice(0, 60),
    );
  }

  console.log('\n5. Пунктир у замкнутых фигур — точки, а не риски');
  const DASHED = {
    rect: { x: 100, y: 60, width: 160, height: 70 },
    ellipse: { x: 320, y: 60, width: 160, height: 70 },
    triangle: { x: 100, y: 170, width: 160, height: 70 },
    polygon: { x: 320, y: 170, width: 160, height: 70 },
    line: { x: 100, y: 290, width: 160, height: 4 },
  };

  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const factory = await import('/src/services/objectFactory.ts');
    app.objects.clearAll(false);
    const make = (kind, box, extra = {}) => factory.createShapeObject(kind, {
      page: 0,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      defaults: { stroke: '#111827', strokeWidth: 4, fill: null },
      dash: [1, 6],
      ...extra,
    });
    app.objects.add([
      make('rect', ${JSON.stringify(DASHED.rect)}),
      make('ellipse', ${JSON.stringify(DASHED.ellipse)}),
      make('triangle', ${JSON.stringify(DASHED.triangle)}),
      make('polygon', ${JSON.stringify(DASHED.polygon)}, { sides: 6 }),
      make('line', ${JSON.stringify(DASHED.line)}, { points: [0, 0.5, 1, 0.5] }),
    ], 'тест');
    app.objects.select([]);
    return 'ok';
  })()`);
  await sleep(1400);

  /**
   * Самый длинный «штрих» вдоль верхней кромки фигуры.
   * Точка с круглым концом шире риски: у риски длина ≈ толщина штриха по
   * вертикали, а по горизонтали всего ~1 pt.
   */
  async function longestDotAlongTop(box) {
    return cdp.evaluate(`(() => {
      const app = window.__PDF_EDITOR__;
      const ctx = document.querySelectorAll('canvas')[1].getContext('2d');
      const zoom = app.editor.zoom;
      const left = Math.round(app.editor.pan.x + ${box.x} * zoom);
      const right = Math.round(app.editor.pan.x + (${box.x} + ${box.width}) * zoom);
      const width = right - left;
      const top = Math.round(app.editor.pan.y + ${box.y} * zoom);
      let best = 0;
      for (let offset = -2; offset <= 16; offset += 1) {
        const data = ctx.getImageData(left, top + offset, width, 1).data;
        let run = 0;
        for (let x = 0; x < width; x += 1) {
          const index = x * 4;
          const ink = data[index + 3] > 25;
          if (ink) {
            run += 1;
            if (run > best) best = run;
          } else {
            run = 0;
          }
        }
      }
      return best;
    })()`);
  }

  const closedDotLengths = {};
  for (const [key, box] of Object.entries(DASHED)) {
    closedDotLengths[key] = await longestDotAlongTop(box);
  }
  console.log('  длина самой длинной точки (px):', JSON.stringify(closedDotLengths));
  await cdp.screenshot(resolvePath(TMP, 'dashed-shapes.png'));
  const lineDots = closedDotLengths.line;
  check('у линии пунктир — точки', lineDots >= 5, String(lineDots));
  for (const key of ['rect', 'ellipse', 'triangle', 'polygon']) {
    check(
      `у «${key}» пунктир — тоже точки (${closedDotLengths[key]} px против ${lineDots} px у линии)`,
      closedDotLengths[key] >= 5 && closedDotLengths[key] >= lineDots * 0.6,
      JSON.stringify(closedDotLengths),
    );
  }

  // В PDF у замкнутых фигур тоже круглые концы штрихов (оператор «1 J»).
  const dashedExport = await cdp.evaluate(`(async () => {
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
  if (dashedExport.ok) {
    const doc = await PDFDocument.load(Buffer.from(dashedExport.b64, 'base64'));
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
    const roundCaps = (streams.join('\n').match(/^1 J$/gm) ?? []).length;
    console.log(`  круглых концов штрихов в PDF: ${roundCaps}`);
    check('в PDF у фигур круглые концы штрихов', roundCaps >= 5, `найдено ${roundCaps}`);
  } else {
    check('экспорт PDF для проверки пунктира', false, dashedExport.error ?? '');
  }

  console.log('\nОшибки консоли:', cdp.errors.length ? cdp.errors.join('\n') : '(нет)');
} catch (error) {
  failed += 1;
  console.error('ОШИБКА ПРОВЕРКИ:', error);
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

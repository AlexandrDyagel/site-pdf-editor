/**
 * Проверка «Конструктора круглой печати» (строки по кольцам).
 *
 * Покрываем всю цепочку:
 *   1. конструктор открывается из панели, превью нарисовано;
 *   2. диаметр и кольца (30–60 мм, 1–4 кольца, зазоры);
 *   3. строки по кольцам: добавление, зазор, сторона, две строки в зазоре;
 *   4. кегль/трекинг в pt, угол дуги, маркеры растяжения И сужения;
 *   5. перетаскивание строки мышью, контекстное меню, двойной клик;
 *   6. фон превью, цвет, прозрачность, «живая печать» (по умолчанию выкл.);
 *   7. пипетка сворачивает окно;
 *   8. вставка на документ, трансформации, дубли, векторный PDF;
 *   9. черновик при случайном закрытии, удаление через меню и полная очистка.
 *
 * Запуск: pnpm check:seal
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, PDFArray } from 'pdf-lib';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const pdfBase64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

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

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9741 });

try {
  /* ------------------------------------------------ загрузка документа */
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await cdp.evaluate(`Boolean(document.querySelector('input[type=file]'))`)) break;
    await sleep(400);
  }
  await cdp.evaluate(`(() => {
    const binary = atob(${JSON.stringify(pdfBase64)});
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const input = document.querySelector('input[type=file]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'test.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(400);
    if (await cdp.evaluate(`Boolean(window.__PDF_EDITOR__?.pdfService)`)) break;
  }
  await cdp.evaluate(`location.hash = '#/editor'; 'ok'`);
  await sleep(1800);

  console.log('\n1. Конструктор открывается из панели «Печать»');
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setTool('seal');
    app.ui.setRightTab('tool');
    return 'ok';
  })()`);
  await sleep(600);
  const button = await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-testid=open-seal-designer]');
    if (!node) return { found: false };
    node.click();
    return { found: true };
  })()`);
  check('кнопка «Конструктор печати» есть', button.found === true);
  // Дожидаемся содержимого конструктора (Vite может перезагрузить страницу).
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(300);
    if (await cdp.evaluate(`Boolean(document.querySelector('[data-testid=seal-designer]'))`)) break;
  }

  const initial = await cdp.evaluate(`(() => {
    const t = window.__SEAL_DESIGNER__;
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const ctx = canvas?.getContext('2d');
    const data = ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height).data : null;
    let painted = 0;
    if (data) for (let i = 3; i < data.length; i += 4) if (data[i] > 8) painted += 1;
    return {
      open: Boolean(document.querySelector('[data-testid=seal-designer]')),
      painted,
      lines: t?.seal?.lines?.length,
      span: t?.seal?.lines?.[0]?.spanAngle,
      ink: t?.seal?.ink?.enabled,
      mm: t?.seal?.diameterMm,
      width: t?.width,
      clear: Boolean(document.querySelector('[data-testid=seal-clear]')),
      bgButtons: document.querySelectorAll('[data-testid^=seal-bg-]').length,
      note: document.body.innerText.includes('только подложка превью'),
      leftScroll: getComputedStyle(document.querySelector('[data-testid=seal-left-column]')).overflowY,
      rightScroll: getComputedStyle(document.querySelector('[data-testid=seal-right-column]')).overflowY,
      handles: document.querySelectorAll('[data-testid^=seal-handle-]').length,
    };
  })()`);
  check('окно конструктора открылось', initial.open === true);
  check('превью нарисовано', initial.painted > 2000, `пикселей: ${initial.painted}`);
  check('по умолчанию две строки текста', initial.lines === 2, String(initial.lines));
  check('по умолчанию печать 38 мм = 108 px', initial.mm === 38 && Math.abs(initial.width - 107.72) < 0.6);
  check('угол дуги по умолчанию — 1°', initial.span === 1, String(initial.span));
  check('«эффект живой печати» по умолчанию выключен', initial.ink === false);
  check('кнопка полной очистки превью есть', initial.clear === true);
  check('в превью есть выбор фона (5 вариантов)', initial.bgButtons === 5);
  check('подпись «фон — не часть печати»', initial.note === true);
  check('колонки прокручиваются независимо', initial.leftScroll === 'auto' && initial.rightScroll === 'auto');
  check('без выбранной строки маркеров нет', initial.handles === 0, String(initial.handles));

  // Помощники в странице: точка на глифе строки и её геометрия.
  await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    window.__sealGlyph = (index = 0) => {
      const app = window.__PDF_EDITOR__;
      const t = window.__SEAL_DESIGNER__;
      const layout = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
      const line = layout.seal.ringLines[index];
      if (!line) return null;
      const ch = line.chars[Math.floor(line.chars.length / 2)];
      const rad = (ch.angle * Math.PI) / 180;
      const w = ch.fontSize * 0.6;
      const point = window.__SEAL_PREVIEW__.client(
        ch.x + Math.cos(rad) * w / 2 + Math.sin(rad) * ch.fontSize * 0.35,
        ch.y + Math.sin(rad) * w / 2 - Math.cos(rad) * ch.fontSize * 0.35,
      );
      return { ...point, lineId: line.lineId };
    };
    window.__sealLineInfo = (lineId) => {
      const app = window.__PDF_EDITOR__;
      const t = window.__SEAL_DESIGNER__;
      const layout = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
      const line = layout.seal.ringLines.find((item) => item.lineId === lineId);
      if (!line) return null;
      const source = t.seal.lines.find((item) => item.id === lineId);
      return {
        radius: line.radius,
        fontSize: line.fontSize,
        span: Math.abs(line.endAngle - line.startAngle),
        slot: line.slot,
        side: line.side,
        radiusOffset: source?.radiusOffset ?? 0,
        angleOffset: source?.angleOffset ?? 0,
      };
    };
    return 'ok';
  })()`);

  console.log('\n2. Диаметр и кольца');
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid=seal-diameter] input');
    input.value = '60';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(700);
  const afterDiameter = await cdp.evaluate(`(() => {
    const t = window.__SEAL_DESIGNER__;
    return { mm: t.seal.diameterMm, width: t.width, height: t.height };
  })()`);
  check('60 мм = 170 px', afterDiameter.mm === 60 && Math.abs(afterDiameter.width - 170.08) < 0.6,
    JSON.stringify(afterDiameter));

  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid=seal-add-ring]').click();
    return 'ok';
  })()`);
  await sleep(600);
  const ringState = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const t = window.__SEAL_DESIGNER__;
    const layout = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
    return {
      rings: t.seal.rings.length,
      radii: layout.seal.ink.rings.map((r) => Math.round(r.radius * 10) / 10),
      slots: layout.seal.slots.length,
    };
  })()`);
  check('третье кольцо добавлено', ringState.rings === 3, String(ringState.rings));
  check('кольца идут от края внутрь', ringState.radii[0] > ringState.radii[1] && ringState.radii[1] > ringState.radii[2],
    JSON.stringify(ringState.radii));
  check('зазоров на один меньше числа колец', ringState.slots === 3, String(ringState.slots));

  console.log('\n2б. Кольцо добавляется кнопкой — под текст');
  const beforeRingAdd = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const t = window.__SEAL_DESIGNER__;
    const layout = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
    return {
      rings: t.seal.rings.length,
      topLineRadius: layout.seal.ringLines.find((line) => line.side === 'top' && line.slot === 0)?.radius ?? 0,
      innermost: layout.seal.ink.rings[layout.seal.ink.rings.length - 1].radius,
    };
  })()`);
  await cdp.evaluate(`document.querySelector('[data-testid=seal-add-ring]').click(); 'ok'`);
  await sleep(600);
  const afterRingAdd = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const t = window.__SEAL_DESIGNER__;
    const layout = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
    const rings = layout.seal.ink.rings;
    return {
      rings: t.seal.rings.length,
      innermost: rings[rings.length - 1].radius,
      topLineRadius: layout.seal.ringLines.find((line) => line.side === 'top' && line.slot === 0)?.radius ?? 0,
    };
  })()`);
  check('кольцо добавляется кнопкой', afterRingAdd.rings === beforeRingAdd.rings + 1, JSON.stringify(afterRingAdd));
  check(
    'новое кольцо встаёт внутрь — под уже нарисованным текстом',
    afterRingAdd.innermost < beforeRingAdd.innermost && afterRingAdd.innermost < afterRingAdd.topLineRadius,
    JSON.stringify({ before: beforeRingAdd, after: afterRingAdd }),
  );
  check(
    'текст при добавлении кольца не съезжает',
    Math.abs(afterRingAdd.topLineRadius - beforeRingAdd.topLineRadius) < 0.05,
    `${beforeRingAdd.topLineRadius.toFixed(2)} → ${afterRingAdd.topLineRadius.toFixed(2)}`,
  );
  await cdp.evaluate(`document.querySelector('[data-testid=seal-ring-3-delete]').click(); 'ok'`);
  await sleep(500);
  const afterRingDelete = await cdp.evaluate(`(() => ({
    rings: window.__SEAL_DESIGNER__.seal.rings.length,
    deleteButton: Boolean(document.querySelector('[data-testid=seal-ring-0-delete]')),
  }))()`);
  check('кольцо можно удалить кнопкой', afterRingDelete.rings === beforeRingAdd.rings, JSON.stringify(afterRingDelete));

  console.log('\n3. Строки по кольцам');
  await cdp.evaluate(`(() => {
    Array.from(document.querySelectorAll('[role=tab]')).find((n) => n.textContent.trim() === 'Текст')?.click();
    return 'ok';
  })()`);
  await sleep(500);
  const cards = await cdp.evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid^=seal-line-]'))
      .filter((node) => /^seal-line-\\d+$/.test(node.getAttribute('data-testid')));
    return {
      cards: cards.length,
      ptLabels: document.body.innerText.includes('КЕГЛЬ') && /\\d+(\\.\\d+)? pt/.test(document.body.innerText),
    };
  })()`);
  check('вкладка «Текст» показывает карточки строк', cards.cards >= 2, String(cards.cards));
  check('кегль и интервалы подписаны в pt', cards.ptLabels === true);

  const addedLine = await cdp.evaluate(`(async () => {
    document.querySelector('[data-testid=seal-add-ring-line]').click();
    await new Promise((r) => setTimeout(r, 500));
    const t = window.__SEAL_DESIGNER__;
    return { lines: t.seal.lines.length };
  })()`);
  check('строка добавляется', addedLine.lines === 3, JSON.stringify(addedLine));

  const movedToSlot = await cdp.evaluate(`(async () => {
    const select = document.querySelector('[data-testid=seal-line-2-slot] select');
    select.value = '1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const t = window.__SEAL_DESIGNER__;
    const line = t.seal.lines[2];
    const info = window.__sealLineInfo(line.id);
    const layout = (await import('/src/services/stampRenderService.ts')).computeStampLayout(t, (id) => window.__PDF_EDITOR__.fonts.familyOf(id));
    const slot = layout.seal.slots[1];
    return {
      slot: line.slot,
      visualCenter: info.radius + (line.side === 'top' ? 0.36 : -0.36) * info.fontSize,
      inner: slot.innerEdge,
      outer: slot.outerEdge,
    };
  })()`);
  check(
    'строку можно поставить между 2-м и 3-м кольцом',
    movedToSlot.slot === 1 &&
      movedToSlot.visualCenter > movedToSlot.inner &&
      movedToSlot.visualCenter < movedToSlot.outer,
    JSON.stringify(movedToSlot),
  );

  const pair = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const line = t.seal.lines[2];
    line.slot = 0;
    line.side = 'top';
    line.fontSize = 4;
    await new Promise((r) => setTimeout(r, 500));
    const layout = (await import('/src/services/stampRenderService.ts')).computeStampLayout(t, (id) => window.__PDF_EDITOR__.fonts.familyOf(id));
    const top = layout.seal.ringLines.filter((item) => item.side === 'top').sort((a, b) => b.radius - a.radius);
    return {
      count: top.length,
      radii: top.map((item) => Math.round(item.radius * 10) / 10),
      hint: Boolean(document.querySelector('[data-testid=seal-crowded-hint]')),
    };
  })()`);
  check('две строки в одном зазоре встают стопкой', pair.count >= 2 && pair.radii[0] > pair.radii[1], JSON.stringify(pair));
  check('есть подсказка про тесноту в зазоре', pair.hint === true);

  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid=seal-line-2-delete]').click();
    return 'ok';
  })()`);
  await sleep(500);
  const afterDelete = await cdp.evaluate(`(() => ({ lines: window.__SEAL_DESIGNER__.seal.lines.length }))()`);
  check('строку можно удалить', afterDelete.lines === 2, String(afterDelete.lines));

  console.log('\n4. Кегль, трекинг и угол дуги');
  const glyph0 = await cdp.evaluate(`window.__sealGlyph(0)`);
  check('точка на строке найдена', Boolean(glyph0));
  await cdp.click(glyph0.x, glyph0.y);
  await sleep(400);
  const selected = await cdp.evaluate(`(() => {
    const designer = document.querySelector('[data-testid=seal-designer]');
    return {
      handles: document.querySelectorAll('[data-testid^=seal-handle-]').length,
      slider: Boolean(document.querySelector('[data-testid=seal-line-0-span]')),
      tab: Array.from(designer.querySelectorAll('[role=tab]')).find((n) => n.getAttribute('aria-selected') === 'true')?.textContent.trim(),
    };
  })()`);
  check('клик по строке показывает маркеры', selected.handles === 2, JSON.stringify(selected));
  check('ползунок выбранной строки виден в панели', selected.slider === true);
  check('открылась вкладка «Текст»', selected.tab === 'Текст', String(selected.tab));

  const tracking = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const line = t.seal.lines[0];
    const before = window.__sealLineInfo(line.id);
    const slider = document.querySelector('[data-testid=seal-line-0-tracking] input');
    slider.value = '5';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const after = window.__sealLineInfo(line.id);
    const value = t.seal.lines[0].letterSpacing;
    slider.value = '1';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return { fontBefore: before.fontSize, fontAfter: after.fontSize, spanBefore: before.span, spanAfter: after.span, value };
  })()`);
  check('трекинг меняется в pt', Math.abs(tracking.value - 5) < 0.01, String(tracking.value));
  check('кегль не меняется при трекинге', Math.abs(tracking.fontAfter - tracking.fontBefore) < 0.01,
    `${tracking.fontBefore} → ${tracking.fontAfter}`);
  check('трекинг растягивает фактический угол', tracking.spanAfter > tracking.spanBefore,
    `${tracking.spanBefore.toFixed(1)}° → ${tracking.spanAfter.toFixed(1)}°`);

  const spanStart = await cdp.evaluate(`(() => {
    const line = window.__SEAL_DESIGNER__.seal.lines[0];
    return { span: window.__sealLineInfo(line.id).span, tracking: line.letterSpacing, word: line.wordSpacing };
  })()`);
  const handleGrow = await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-testid=seal-handle-0]').getBoundingClientRect();
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]').getBoundingClientRect();
    return {
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
      cx: canvas.x + canvas.width / 2,
      cy: canvas.y + canvas.height / 2,
      r: canvas.width / 2,
    };
  })()`);
  await cdp.drag(
    { x: handleGrow.x, y: handleGrow.y },
    { x: handleGrow.cx - handleGrow.r * 0.85, y: handleGrow.cy - handleGrow.r * 0.15 },
    10,
  );
  await sleep(500);
  const spanGrown = await cdp.evaluate(`(() => {
    const line = window.__SEAL_DESIGNER__.seal.lines[0];
    return { target: line.spanAngle, tracking: line.letterSpacing, word: line.wordSpacing, actual: window.__sealLineInfo(line.id).span };
  })()`);
  check('маркер растягивает строку',
    spanGrown.target > 1 && spanGrown.tracking > spanStart.tracking &&
      spanGrown.word > spanStart.word && Math.abs(spanGrown.actual - spanGrown.target) < 2,
    JSON.stringify({ spanStart, spanGrown }));

  const handleShrink = await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-testid=seal-handle-1]').getBoundingClientRect();
    return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  })()`);
  await cdp.drag(
    { x: handleShrink.x, y: handleShrink.y },
    { x: handleGrow.cx, y: handleGrow.cy - handleGrow.r * 0.9 },
    10,
  );
  await sleep(500);
  const spanShrunk = await cdp.evaluate(`(() => {
    const line = window.__SEAL_DESIGNER__.seal.lines[0];
    return { target: line.spanAngle, tracking: line.letterSpacing, word: line.wordSpacing, actual: window.__sealLineInfo(line.id).span };
  })()`);
  check('маркер сжимает строку до предела и держит актуальный угол',
    spanShrunk.tracking < spanGrown.tracking &&
      spanShrunk.word <= spanGrown.word &&
      Math.abs(spanShrunk.actual - spanShrunk.target) < 2 &&
      spanShrunk.target >= 8,
    JSON.stringify({ spanGrown, spanShrunk }));
  check('маркер двигает ползунки «Между буквами» и «Между словами»',
    Math.abs(spanGrown.tracking - spanStart.tracking) > 0.05 &&
      Math.abs(spanShrunk.tracking - spanGrown.tracking) > 0.05 &&
      Math.abs(spanGrown.word - spanStart.word) > 0.2 &&
      Math.abs(spanShrunk.word - spanGrown.word) > 0.2,
    JSON.stringify({ start: spanStart, grown: spanGrown, shrunk: spanShrunk }));
  const angleSlider = await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid=seal-line-0-span] input');
    return { value: input ? Number(input.value) : null, actual: window.__sealLineInfo(window.__SEAL_DESIGNER__.seal.lines[0].id).span };
  })()`);
  check('ползунок «Угол дуги» показывает фактический угол',
    angleSlider.value !== null && Math.abs(angleSlider.value - angleSlider.actual) < 1.5,
    JSON.stringify(angleSlider));

  console.log('\n5. Перетаскивание строки мышью');
  const beforeDrag = await cdp.evaluate(`window.__sealLineInfo(window.__SEAL_DESIGNER__.seal.lines[0].id)`);
  const dragPoint = await cdp.evaluate(`window.__sealGlyph(0)`);
  await cdp.drag({ x: dragPoint.x, y: dragPoint.y }, { x: dragPoint.x + 34, y: dragPoint.y + 12 }, 10);
  await sleep(500);
  const afterDrag = await cdp.evaluate(`window.__sealLineInfo(window.__SEAL_DESIGNER__.seal.lines[0].id)`);
  check(
    'строку можно перетащить по окружности и по радиусу',
    Math.abs(afterDrag.angleOffset - beforeDrag.angleOffset) > 1 ||
      Math.abs(afterDrag.radiusOffset - beforeDrag.radiusOffset) > 0.5,
    JSON.stringify({ before: { a: beforeDrag.angleOffset, r: beforeDrag.radiusOffset }, after: { a: afterDrag.angleOffset, r: afterDrag.radiusOffset } }),
  );

  console.log('\n6. Контекстное меню и двойной клик');
  const menuPoint = await cdp.evaluate(`window.__sealGlyph(0)`);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: menuPoint.x, y: menuPoint.y, button: 'right', buttons: 2, clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: menuPoint.x, y: menuPoint.y, button: 'right', buttons: 0, clickCount: 1,
  });
  await sleep(500);
  const menu = await cdp.evaluate(`(() => ({
    open: Boolean(document.querySelector('[data-testid=seal-text-menu]')),
    items: Array.from(document.querySelectorAll('[data-testid=seal-text-menu] button')).map((b) => b.textContent.trim()),
  }))()`);
  check('правый клик по строке открывает меню', menu.open === true, JSON.stringify(menu));
  check('в меню есть «Редактировать» и «Удалить»',
    menu.items.includes('Редактировать') && menu.items.includes('Удалить'), JSON.stringify(menu.items));

  await cdp.evaluate(`document.querySelector('[data-testid=seal-menu-edit]').click(); 'ok'`);
  await sleep(500);
  const editFocus = await cdp.evaluate(`(() => {
    const active = document.activeElement;
    return { testid: active?.closest('[data-testid]')?.getAttribute('data-testid'), caret: active?.selectionStart, length: active?.value?.length };
  })()`);
  check('«Редактировать» ставит фокус в поле строки', editFocus.testid?.startsWith('seal-line-') === true, String(editFocus.testid));

  const dblPoint = await cdp.evaluate(`window.__sealGlyph(0)`);
  await cdp.evaluate(`(() => {
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: ${dblPoint.x}, clientY: ${dblPoint.y} }));
    return 'ok';
  })()`);
  await sleep(500);
  const focusState = await cdp.evaluate(`(() => {
    const active = document.activeElement;
    return { testid: active?.closest('[data-testid]')?.getAttribute('data-testid'), caret: active?.selectionStart, length: active?.value?.length };
  })()`);
  check('двойной клик фокусирует поле строки', focusState.testid?.startsWith('seal-line-') === true, String(focusState.testid));
  check('каретка в конце текста', focusState.caret === focusState.length, `${focusState.caret}/${focusState.length}`);

  console.log('\n6б. Клик по строке центра показывает её свойства');
  const centerClick = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const t = window.__SEAL_DESIGNER__;
    const layout = stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
    const line = layout.lines[0];
    if (!line) return { error: 'нет строк центра' };
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const point = window.__SEAL_PREVIEW__.client(line.x + line.width / 2, line.baseline - line.fontSize * 0.4);
    const x = point.x;
    const y = point.y;
    const options = { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', options));
    canvas.dispatchEvent(new PointerEvent('pointerup', options));
    await new Promise((r) => setTimeout(r, 600));
    const designer = document.querySelector('[data-testid=seal-designer]');
    const card = document.querySelector('[data-testid=seal-center-card-0]');
    return {
      tab: Array.from(designer.querySelectorAll('[role=tab]')).find((n) => n.getAttribute('aria-selected') === 'true')?.textContent.trim(),
      cardActive: card?.getAttribute('data-active'),
      hasCard: Boolean(card),
    };
  })()`);
  check('клик по центру открывает вкладку «Центр»', centerClick.tab === 'Центр', JSON.stringify(centerClick));
  check('карточка этой строки центра выделена', centerClick.hasCard === true && centerClick.cardActive === 'true',
    JSON.stringify(centerClick));

  console.log('\n7. Фон, цвет, прозрачность, фактура');
  const background = await cdp.evaluate(`(async () => {
    document.querySelector('[data-testid=seal-bg-white]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const box = document.querySelector('[data-testid=seal-preview-box]');
    const white = { color: getComputedStyle(box).backgroundColor, checker: box.className.includes('checker-bg') };
    document.querySelector('[data-testid=seal-bg-none]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    return { white, none: { checker: box.className.includes('checker-bg') } };
  })()`);
  check('белый фон превью применяется', background.white.color === 'rgb(255, 255, 255)', background.white.color);
  check('без фона возвращается шахматка', background.none.checker === true);

  const color = await cdp.evaluate(`(async () => {
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Краска')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const triggers = Array.from(document.querySelectorAll('.seal-settings [data-testid=color-trigger]'));
    const trigger = triggers.find((node) => node.offsetParent) ?? triggers[triggers.length - 1];
    trigger?.click();
    await new Promise((r) => setTimeout(r, 300));
    const swatch = Array.from(document.querySelectorAll('.seal-settings button'))
      .find((node) => node.style.backgroundColor === 'rgb(124, 58, 237)');
    swatch?.click();
    await new Promise((r) => setTimeout(r, 300));
    const preset = Array.from(document.querySelectorAll('.seal-settings button'))
      .some((node) => node.style.backgroundColor === 'rgb(39, 175, 255)');
    return { color: window.__SEAL_DESIGNER__.color, preset };
  })()`);
  check('цвет из пресета применяется', color.color === '#7c3aed', color.color);
  check('пресет #27afff есть во вкладке «Краска»', color.preset === true);

  await cdp.evaluate(`(() => {
    Array.from(document.querySelectorAll('[role=tab]')).find((n) => n.textContent.trim() === 'Краска')?.click();
    return 'ok';
  })()`);
  await sleep(400);
  const inkDefault = await cdp.evaluate(`(() => ({
    enabled: window.__SEAL_DESIGNER__.seal.ink.enabled,
    checked: document.querySelector('[data-testid=seal-ink-toggle] button')?.getAttribute('aria-checked'),
  }))()`);
  check('переключатель «живой печати» выключен по умолчанию',
    inkDefault.enabled === false && inkDefault.checked === 'false', JSON.stringify(inkDefault));

  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid=seal-ink-toggle] button').click();
    return 'ok';
  })()`);
  await sleep(500);
  const inkOn = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const layout = stamp.computeStampLayout(window.__SEAL_DESIGNER__, (id) => app.fonts.familyOf(id));
    return {
      enabled: window.__SEAL_DESIGNER__.seal.ink.enabled,
      jitter: layout.seal.ink.rings.some((ring) => (ring.points?.length ?? 0) > 0),
      specks: layout.seal.ink.specks.length,
    };
  })()`);
  check('эффект включается: неровные кольца и зерно', inkOn.enabled && inkOn.jitter && inkOn.specks > 5,
    JSON.stringify(inkOn));

  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid=seal-ink-toggle] button').click();
    const input = document.querySelector('[data-testid=seal-opacity] input');
    input.value = '0.8';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(500);
  const opacity = await cdp.evaluate(`window.__SEAL_DESIGNER__.opacity`);
  check('прозрачность оттиска применяется', Math.abs(opacity - 0.8) < 0.001, String(opacity));

  console.log('\n8. Пипетка сворачивает окно');
  const pipetteStart = await cdp.evaluate(`(async () => {
    const right = document.querySelector('[data-testid=seal-right-column]');
    // Палитра могла остаться открытой после выбора цвета — тогда не закрываем её.
    if (!right?.querySelector('[data-testid=color-eyedropper]')) {
      right?.querySelector('[data-testid=color-trigger]')?.click();
      await new Promise((r) => setTimeout(r, 250));
    }
    right?.querySelector('[data-testid=color-eyedropper]')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const overlay = document.querySelector('.fixed.inset-0.z-\\\\[100\\\\]');
    const canvas = document.querySelector('[data-testid=editor-canvas]') || document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    return {
      suspended: overlay ? overlay.className.includes('pointer-events-none') : null,
      active: await import('/src/services/eyedropperService.ts').then((m) => m.isEyedropperActive()),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  })()`);
  check('окно свернулось для пипетки', pipetteStart.suspended === true && pipetteStart.active === true,
    JSON.stringify(pipetteStart));
  await cdp.click(pipetteStart.x, pipetteStart.y);
  await sleep(900);
  const pipetteEnd = await cdp.evaluate(`(() => {
    const overlay = document.querySelector('.fixed.inset-0.z-\\\\[100\\\\]');
    return {
      suspended: overlay ? overlay.className.includes('pointer-events-none') : null,
      color: window.__SEAL_DESIGNER__?.color,
      modalOpen: window.__PDF_EDITOR__.ui.modals.sealDesigner,
    };
  })()`);
  check('окно вернулось с выбранным цветом',
    pipetteEnd.suspended === false && pipetteEnd.modalOpen === true && /^#[0-9a-f]{6}$/i.test(pipetteEnd.color ?? ''),
    JSON.stringify(pipetteEnd));

  console.log('\n9. Вставка на документ');
  await cdp.evaluate(`(() => {
    window.__SEAL_DESIGNER__.color = '#7c3aed';
    return 'ok';
  })()`);
  await sleep(300);
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid=seal-insert]').click();
    return 'ok';
  })()`);
  await sleep(1300);
  const inserted = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const objects = app.objects.objects.filter((item) => item.type === 'stamp');
    const object = objects[objects.length - 1];
    return object
      ? {
          id: object.id,
          width: object.width,
          kind: object.payload.template.kind,
          hasSeal: Boolean(object.payload.template.seal),
          lines: object.payload.template.seal?.lines?.length,
          color: object.payload.template.color,
          modalClosed: app.ui.modals.sealDesigner,
          seals: app.library.seals.length,
        }
      : null;
  })()`);
  check('печать добавлена на страницу', Boolean(inserted), 'объект не найден');
  check('объект — печать со строками', inserted?.kind === 'seal' && inserted?.hasSeal === true && inserted?.lines === 2,
    JSON.stringify(inserted));
  check('цвет сохранился', inserted?.color === '#7c3aed', String(inserted?.color));
  check('печать сохранена в библиотеку', (inserted?.seals ?? 0) >= 1, String(inserted?.seals));
  check('конструктор закрылся', inserted?.modalClosed === false);

  console.log('\n10. Объект на странице и векторный PDF');
  const transformed = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const id = ${JSON.stringify(inserted?.id ?? '')};
    app.objects.update(id, { x: 120, y: 140, rotation: 15 }, 'тест');
    app.objects.setOpacity([id], 0.75);
    const object = app.objects.byId(id);
    return { x: object.x, y: object.y, rotation: object.rotation, opacity: object.opacity };
  })()`);
  check('печать перемещается', transformed.x === 120 && transformed.y === 140, JSON.stringify(transformed));
  check('печать поворачивается', transformed.rotation === 15);
  check('прозрачность объекта меняется', Math.abs(transformed.opacity - 0.75) < 0.001);

  const scaled = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const stamp = await import('/src/services/stampRenderService.ts');
    const id = ${JSON.stringify(inserted?.id ?? '')};
    app.objects.update(id, { width: 340.16, height: 340.16 }, 'масштаб');
    const object = app.objects.byId(id);
    const fitted = stamp.fitStampTemplate(object.payload.template, object.width, object.height);
    const layout = stamp.computeStampLayout(fitted, (fontId) => app.fonts.familyOf(fontId));
    return { width: object.width, ring: layout.seal.ink.rings[0].radius, fontSize: layout.seal.ringLines[0].fontSize };
  })()`);
  check('печать масштабируется вместе с текстом', scaled.ring > 160 && scaled.fontSize > 8, JSON.stringify(scaled));

  const duplicated = await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    const before = app.objects.objects.length;
    const copy = app.objects.duplicate([${JSON.stringify(inserted?.id ?? '')}]);
    return { before, after: app.objects.objects.length, copyId: copy[0]?.id ?? null };
  })()`);
  check('печать дублируется', duplicated.after === duplicated.before + 1);
  const removed = await cdp.evaluate(`(() => {
    window.__PDF_EDITOR__.objects.remove([${JSON.stringify(duplicated.copyId)}]);
    return window.__PDF_EDITOR__.objects.objects.length;
  })()`);
  check('копия удаляется', removed === duplicated.before);

  const exported = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.objects.select([]);
    app.exporter.setFormat('pdf');
    const result = await app.exporter.run({ download: false });
    if (!result.ok) return { ok: false, error: result.error };
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return { ok: true, b64: btoa(binary) };
  })()`);
  check('PDF с печатью собран', exported.ok === true, exported.error ?? '');

  if (exported.ok) {
    const doc = await PDFDocument.load(Buffer.from(exported.b64, 'base64'));
    const streams = [];
    const walk = (ref) => {
      const value = ref && ref.constructor?.name === 'PDFRef' ? doc.context.lookup(ref) : ref;
      if (value instanceof PDFRawStream) {
        try {
          streams.push(inflateSync(Buffer.from(value.contents)).toString('latin1'));
        } catch {
          streams.push(Buffer.from(value.contents).toString('latin1'));
        }
      } else if (value instanceof PDFArray) {
        for (let i = 0; i < value.size(); i += 1) walk(value.get(i));
      }
    };
    for (const page of doc.getPages()) walk(page.node.get(PDFName.of('Contents')));
    const content = streams.join('\n');
    const curves = (content.match(/^[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ c$/gm) ?? []).length;
    const lines = (content.match(/^[-\d.]+ [-\d.]+ l$/gm) ?? []).length;
    const textOps = (content.match(/Tj/g) ?? []).length;
    const fills = [...content.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) rg/g)].map((m) => m.slice(1, 4).map(Number));
    const purple = fills.some(
      ([r, g, b]) => Math.abs(r - 0.486) < 0.02 && Math.abs(g - 0.227) < 0.02 && Math.abs(b - 0.929) < 0.02,
    );
    console.log(`  в PDF: ${curves} кривых, ${lines} отрезков, ${textOps} текстовых операций`);
    check('кольца в PDF — векторные кривые', curves + lines >= 8, `${curves}/${lines}`);
    check('текст печати остался текстом', textOps > 20, String(textOps));
    check('цвет печати попал в PDF', purple, JSON.stringify(fills.slice(0, 4)));
  }

  console.log('\n11. Повторное открытие печати из «Свойств»');
  const reopened = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.ui.closeAllModals();
    app.objects.select([${JSON.stringify(inserted?.id ?? '')}]);
    app.ui.setRightTab('properties');
    await new Promise((r) => setTimeout(r, 500));
    const button = Array.from(document.querySelectorAll('button')).find((node) => node.textContent.trim() === 'Редактировать');
    button?.click();
    await new Promise((r) => setTimeout(r, 1000));
    const t = window.__SEAL_DESIGNER__;
    return {
      open: Boolean(document.querySelector('[data-testid=seal-designer]')),
      mm: t?.seal?.diameterMm,
      lines: t?.seal?.lines?.length,
      color: t?.color,
    };
  })()`);
  check('кнопка «Редактировать» открывает конструктор', reopened.open === true);
  check('настройки объекта подхватились', reopened.lines === 2 && reopened.color === '#7c3aed', JSON.stringify(reopened));

  console.log('\n12. Черновик, удаление через меню и очистка');
  const draft = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const t = window.__SEAL_DESIGNER__;
    t.name = 'Черновик-проверка';
    t.color = '#0f766e';
    await new Promise((r) => setTimeout(r, 200));
    app.ui.closeModal('sealDesigner');
    await new Promise((r) => setTimeout(r, 500));
    // Открываем снова тот же контекст (объект) — как «Редактировать» повторно.
    app.ui.openModal('sealDesigner', { objectId: ${JSON.stringify(inserted?.id ?? '')} });
    await new Promise((r) => setTimeout(r, 900));
    const restored = window.__SEAL_DESIGNER__;
    return {
      name: restored?.name,
      color: restored?.color,
      notice: Boolean(document.querySelector('[data-testid=seal-draft-notice]')),
    };
  })()`);
  check('черновик восстанавливается после закрытия', draft.name === 'Черновик-проверка' && draft.color === '#0f766e',
    JSON.stringify(draft));
  check('показана плашка о восстановлении', draft.notice === true);

  const menuDelete = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const before = t.seal.lines.length;
    Array.from(document.querySelectorAll('[role=tab]')).find((n) => n.textContent.trim() === 'Текст')?.click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('[data-testid=seal-add-ring-line]').click();
    await new Promise((r) => setTimeout(r, 500));
    const line = t.seal.lines[t.seal.lines.length - 1];
    line.text = 'ВРЕМЕННАЯ';
    line.slot = Math.max(0, t.seal.rings.length - 1);
    line.side = 'bottom';
    await new Promise((r) => setTimeout(r, 500));
    return { before, afterAdd: t.seal.lines.length, lineId: line.id };
  })()`);
  check('временная строка добавлена', menuDelete.afterAdd === menuDelete.before + 1, JSON.stringify(menuDelete));

  const tempPoint = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const stamp = await import('/src/services/stampRenderService.ts');
    const layout = stamp.computeStampLayout(t, (id) => window.__PDF_EDITOR__.fonts.familyOf(id));
    const line = layout.seal.ringLines.find((item) => item.lineId === ${JSON.stringify(menuDelete.lineId)});
    if (!line) return null;
    const ch = line.chars[Math.floor(line.chars.length / 2)];
    const rad = (ch.angle * Math.PI) / 180;
    const w = ch.fontSize * 0.6;
    return window.__SEAL_PREVIEW__.client(
      ch.x + Math.cos(rad) * w / 2 + Math.sin(rad) * ch.fontSize * 0.35,
      ch.y + Math.sin(rad) * w / 2 - Math.cos(rad) * ch.fontSize * 0.35,
    );
  })()`);

  if (tempPoint) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: tempPoint.x, y: tempPoint.y, button: 'right', buttons: 2, clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: tempPoint.x, y: tempPoint.y, button: 'right', buttons: 0, clickCount: 1,
    });
    await sleep(500);
    await cdp.evaluate(`document.querySelector('[data-testid=seal-menu-delete]')?.click(); 'ok'`);
    await sleep(500);
  }
  const afterMenuDelete = await cdp.evaluate(`(() => ({
    lines: window.__SEAL_DESIGNER__.seal.lines.length,
    menu: Boolean(document.querySelector('[data-testid=seal-text-menu]')),
  }))()`);
  check('меню «Удалить» убирает строку',
    afterMenuDelete.lines === menuDelete.before && afterMenuDelete.menu === false, JSON.stringify(afterMenuDelete));

  const cleared = await cdp.evaluate(`(async () => {
    document.querySelector('[data-testid=seal-clear]').click();
    await new Promise((r) => setTimeout(r, 400));
    const dialog = document.querySelector('[role=alertdialog]');
    const confirm = dialog ? Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Очистить') : null;
    confirm?.click();
    await new Promise((r) => setTimeout(r, 700));
    const t = window.__SEAL_DESIGNER__;
    return { lines: t?.seal?.lines?.length, centerLines: t?.lines?.length, logo: t?.logo };
  })()`);
  check('«Очистить» удаляет все строки', cleared.lines === 0 && cleared.centerLines === 0, JSON.stringify(cleared));

  console.log('\n13. Кольца, центр, логотип и клавиатура');

  await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    window.__sealLayout = () => stamp.computeStampLayout(window.__SEAL_DESIGNER__, (id) => window.__PDF_EDITOR__.fonts.familyOf(id));
    window.__ringPoint = (index = 0) => {
      const ring = window.__sealLayout().seal.ink.rings[index];
      return window.__SEAL_PREVIEW__.client(ring.cx - ring.radius, ring.cy);
    };
    window.__centerPoint = (index = 0) => {
      const line = window.__sealLayout().lines[index];
      if (!line) return null;
      return window.__SEAL_PREVIEW__.client(line.x + line.width / 2, line.baseline - line.fontSize * 0.4);
    };
    window.__clickTab = (label) => Array.from(document.querySelectorAll('[role=tab]')).find((n) => n.textContent.trim() === label)?.click();
    return 'ok';
  })()`);

  // --- кольцо: выбор, штрих, перетаскивание, меню ---
  const ringPoint = await cdp.evaluate(`window.__ringPoint(1)`);
  await cdp.click(ringPoint.x, ringPoint.y);
  await sleep(500);
  const ringSelected = await cdp.evaluate(`(() => {
    const d = document.querySelector('[data-testid=seal-designer]');
    return {
      tab: Array.from(d.querySelectorAll('[role=tab]')).find((n) => n.getAttribute('aria-selected') === 'true')?.textContent.trim(),
      active: document.querySelector('[data-testid=seal-ring-1]')?.getAttribute('data-active'),
    };
  })()`);
  check('клик по кольцу показывает его настройки', ringSelected.tab === 'Кольца' && ringSelected.active === 'true',
    JSON.stringify(ringSelected));

  const ringDrag = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const ring = window.__sealLayout().seal.ink.rings[1];
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const p = window.__ringPoint(1);
    const options = { bubbles: true, clientX: p.x, clientY: p.y, button: 0, pointerId: 21 };
    const beforeGap = t.seal.rings[1].gap;
    canvas.dispatchEvent(new PointerEvent('pointerdown', options));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: p.x + 10, clientY: p.y, pointerId: 21 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 21 }));
    await new Promise((r) => setTimeout(r, 500));
    return { beforeGap, afterGap: t.seal.rings[1].gap, radius: ring.radius };
  })()`);
  check('кольцо тянется — меняется расстояние до предыдущего',
    Math.abs(ringDrag.afterGap - ringDrag.beforeGap) > 0.2, JSON.stringify(ringDrag));

  const ringMenuPoint = await cdp.evaluate(`window.__ringPoint(1)`);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: ringMenuPoint.x, y: ringMenuPoint.y, button: 'right', buttons: 2, clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: ringMenuPoint.x, y: ringMenuPoint.y, button: 'right', buttons: 0, clickCount: 1,
  });
  await sleep(400);
  const ringMenu = await cdp.evaluate(`(() => ({
    open: Boolean(document.querySelector('[data-testid=seal-menu-ring-delete]')),
    rings: window.__SEAL_DESIGNER__.seal.rings.length,
  }))()`);
  if (ringMenu.open) {
    await cdp.evaluate(`document.querySelector('[data-testid=seal-menu-ring-delete]').click(); 'ok'`);
    await sleep(500);
  }
  const ringDeleted = await cdp.evaluate(`window.__SEAL_DESIGNER__.seal.rings.length`);
  check('контекстное меню кольца удаляет его', ringMenu.open && ringDeleted === ringMenu.rings - 1,
    JSON.stringify({ ...ringMenu, after: ringDeleted }));

  // --- строка центра: маркеры, растяжение, перетаскивание ---
  await cdp.evaluate(`window.__clickTab('Центр'); 'ok'`);
  await sleep(300);
  await cdp.evaluate(`document.querySelector('[data-testid=seal-add-line]').click(); 'ok'`);
  await sleep(600);
  const centerPoint = await cdp.evaluate(`window.__centerPoint(0)`);
  await cdp.click(centerPoint.x, centerPoint.y);
  await sleep(500);
  const centerSelected = await cdp.evaluate(`(() => ({
    handles: document.querySelectorAll('[data-testid^=seal-center-handle-]').length,
    active: document.querySelector('[data-testid=seal-center-card-0]')?.getAttribute('data-active'),
  }))()`);
  check('клик по строке центра показывает маркеры', centerSelected.handles === 2 && centerSelected.active === 'true',
    JSON.stringify(centerSelected));

  const centerHandle = await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-testid=seal-center-handle-1]')?.getBoundingClientRect();
    return node ? { x: node.x + node.width / 2, y: node.y + node.height / 2 } : null;
  })()`);
  await cdp.drag(centerHandle, { x: centerHandle.x + 18, y: centerHandle.y }, 8);
  await sleep(500);
  const centerStretch = await cdp.evaluate(`(() => ({
    letterSpacing: window.__SEAL_DESIGNER__.lines[0].letterSpacing,
    width: window.__sealLayout().lines[0].width,
  }))()`);
  check('маркер растягивает строку центра через трекинг', centerStretch.letterSpacing !== 0,
    JSON.stringify(centerStretch));

  const centerDrag = await cdp.evaluate(`(() => {
    const t = window.__SEAL_DESIGNER__;
    const p = window.__centerPoint(0);
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const options = { bubbles: true, clientX: p.x, clientY: p.y, button: 0, pointerId: 31 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', options));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: p.x + 12, clientY: p.y + 8, pointerId: 31 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 31 }));
    return new Promise((resolve) => setTimeout(() => resolve({ x: t.lines[0].offsetX, y: t.lines[0].offsetY }), 500));
  })()`);
  check('строку центра можно перетащить в любое место',
    Math.abs(centerDrag.x) > 0.5 || Math.abs(centerDrag.y) > 0.5, JSON.stringify(centerDrag));

  const centerIndependence = await cdp.evaluate(`(async () => {
    const before = window.__sealLayout().lines[0]?.baseline;
    document.querySelector('[data-testid=seal-add-line]').click();
    await new Promise((r) => setTimeout(r, 600));
    const after = window.__sealLayout().lines[0]?.baseline;
    return { before, after, lines: window.__SEAL_DESIGNER__.lines.length };
  })()`);
  check('добавление строки центра не двигает первую',
    Math.abs(centerIndependence.after - centerIndependence.before) < 0.1,
    JSON.stringify(centerIndependence));

  const centerWord = await cdp.evaluate(`(async () => {
    const input = document.querySelector('[data-testid=seal-center-line-0-word] input');
    if (!input) return { error: 'нет поля' };
    const before = window.__sealLayout().lines[0].width;
    input.value = '6';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return { before, after: window.__sealLayout().lines[0].width, wordSpacing: window.__SEAL_DESIGNER__.lines[0].wordSpacing };
  })()`);
  check('у строки центра есть межсловный интервал',
    centerWord.error === undefined && centerWord.after > centerWord.before,
    JSON.stringify(centerWord));

  // --- угол 400 ---
  await cdp.evaluate(`window.__clickTab('Текст'); 'ok'`);
  await sleep(300);
  await cdp.evaluate(`document.querySelector('[data-testid=seal-add-ring-line]')?.click(); 'ok'`);
  await sleep(500);
  const angle400 = await cdp.evaluate(`(async () => {
    const slider = document.querySelector('[data-testid=seal-line-0-span] input');
    if (!slider) return { error: 'нет ползунка' };
    slider.value = '400';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const line = window.__SEAL_DESIGNER__.seal.lines[0];
    const geo = window.__sealLayout().seal.ringLines.find((item) => item.lineId === line.id);
    return { target: line.spanAngle, actual: Math.abs(geo.endAngle - geo.startAngle) };
  })()`);
  check('угол дуги можно выставить до 400°', angle400.target === 400 && Math.abs(angle400.actual - 400) < 1.5,
    JSON.stringify(angle400));

  // --- Ctrl+Z на русской раскладке и Del ---
  const undoStart = await cdp.evaluate(`(() => {
    window.__SEAL_DESIGNER__.seal.lines[0].text = 'ПРОВЕРКА ОТМЕНЫ';
    return { lines: window.__SEAL_DESIGNER__.seal.lines.length };
  })()`);
  await sleep(500);
  await cdp.evaluate(`document.body.focus(); 'ok'`);
  await cdp.pressKey('я', 'KeyZ', 90, 2);
  await sleep(600);
  const undoResult = await cdp.evaluate(`(() => ({
    text: window.__SEAL_DESIGNER__.seal.lines[0]?.text,
    lines: window.__SEAL_DESIGNER__.seal.lines.length,
  }))()`);
  check('Ctrl+Z работает на русской раскладке', undoResult.text !== 'ПРОВЕРКА ОТМЕНЫ',
    JSON.stringify({ start: undoStart, now: undoResult }));

  const deleteState = await cdp.evaluate(`(async () => {
    const card = document.querySelector('[data-testid=seal-line-0]');
    card?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { lines: window.__SEAL_DESIGNER__.seal.lines.length };
  })()`);
  await cdp.pressKey('Delete', 'Delete', 46, 0);
  await sleep(600);
  const afterKeyDelete = await cdp.evaluate(`window.__SEAL_DESIGNER__.seal.lines.length`);
  check('Delete удаляет выбранную строку', afterKeyDelete === deleteState.lines - 1,
    JSON.stringify({ before: deleteState.lines, after: afterKeyDelete }));
  await cdp.pressKey('я', 'KeyZ', 90, 2);
  await sleep(600);
  const afterUndoDelete = await cdp.evaluate(`window.__SEAL_DESIGNER__.seal.lines.length`);
  check('Ctrl+Z возвращает удалённую строку', afterUndoDelete === deleteState.lines,
    JSON.stringify({ expected: deleteState.lines, after: afterUndoDelete }));

  // --- логотип как объект ---
  await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';
    t.logo = { src: png, width: 30, height: 20, offsetX: 0, offsetY: 0, opacity: 1, rotation: 0 };
    return 'ok';
  })()`);
  await sleep(700);
  const logoPoint = await cdp.evaluate(`(() => {
    const logo = window.__sealLayout().logo;
    return window.__SEAL_PREVIEW__.client(logo.x + logo.width / 2, logo.y + logo.height / 2);
  })()`);
  await cdp.click(logoPoint.x, logoPoint.y);
  await sleep(500);
  const logoSelected = await cdp.evaluate(`(() => ({
    handles: document.querySelectorAll('[data-testid^=seal-logo-handle-]').length,
    rotate: Boolean(document.querySelector('[data-testid=seal-logo-rotate]')),
  }))()`);
  check('клик по логотипу показывает маркеры объекта', logoSelected.handles === 4 && logoSelected.rotate,
    JSON.stringify(logoSelected));

  const logoTransform = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const before = { w: t.logo.width, h: t.logo.height };
    const logo = window.__sealLayout().logo;
    const p = window.__SEAL_PREVIEW__.client(logo.x + logo.width / 2, logo.y + logo.height / 2);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: p.x, clientY: p.y, button: 0, pointerId: 41 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: p.x + 10, clientY: p.y + 6, pointerId: 41 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 41 }));
    await new Promise((r) => setTimeout(r, 400));
    const moved = { x: t.logo.offsetX, y: t.logo.offsetY };
    const corner = document.querySelector('[data-testid=seal-logo-handle-se]');
    const cr = corner?.getBoundingClientRect();
    const cp = cr ? { x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 } : null;
    if (corner && cp) {
      corner.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cp.x, clientY: cp.y, button: 0, pointerId: 42 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cp.x + 10, clientY: cp.y + 10, shiftKey: true, pointerId: 42 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 42 }));
      await new Promise((r) => setTimeout(r, 400));
    }
    const resized = { w: t.logo.width, h: t.logo.height };
    const rotateBtn = document.querySelector('[data-testid=seal-logo-rotate]');
    const rr = rotateBtn?.getBoundingClientRect();
    const rp = rr ? { x: rr.left + rr.width / 2, y: rr.top + rr.height / 2 } : null;
    if (rotateBtn && rp) {
      rotateBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rp.x, clientY: rp.y, button: 0, pointerId: 43 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rp.x + 22, clientY: rp.y + 8, pointerId: 43 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 43 }));
      await new Promise((r) => setTimeout(r, 400));
    }
    return { moved, before, resized, rotation: t.logo.rotation };
  })()`);
  const ratioBefore = logoTransform.before.w / logoTransform.before.h;
  const ratioAfter = logoTransform.resized.w / logoTransform.resized.h;
  check('логотип можно переместить', Math.abs(logoTransform.moved.x) > 0.3 || Math.abs(logoTransform.moved.y) > 0.3,
    JSON.stringify(logoTransform.moved));
  check('Shift сохраняет пропорции при растяжении',
    logoTransform.resized.w > logoTransform.before.w && Math.abs(ratioAfter - ratioBefore) < 0.03,
    JSON.stringify({ before: logoTransform.before, after: logoTransform.resized, ratios: [ratioBefore, ratioAfter] }));
  check('логотип можно повернуть', Math.abs(logoTransform.rotation) > 1, String(logoTransform.rotation));

  // --- штриховой маркер поворота у объектов ---
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.closeModal('sealDesigner'); 'ok'`);
  await sleep(700);
  const rotationAnchor = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    const stage = window.__PDF_EDITOR_STAGE__;
    if (!stage) return { error: 'нет сцены' };
    const factory = await import('/src/services/objectFactory.ts');
    const shape = factory.createShapeObject('rect', {
      page: 0, x: 120, y: 120, width: 160, height: 100,
      defaults: { stroke: '#111111', strokeWidth: 1, fill: '#ffffff' },
    });
    app.objects.add([shape], 'проверка маркера');
    app.objects.select([shape.id]);
    await new Promise((r) => setTimeout(r, 600));
    const rotater = stage.findOne('Transformer')?.findOne('.rotater');
    return rotater ? { fill: rotater.fill(), width: rotater.width(), name: rotater.name() } : { error: 'нет rotater' };
  })()`);
  check('маркер поворота — синий круг со стрелкой',
    rotationAnchor.fill === '#2f6bff' && rotationAnchor.width === 22,
    JSON.stringify(rotationAnchor));

  // --- фон переживает закрытие и вставку ---
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.openModal('sealDesigner'); 'ok'`);
  await sleep(900);
  await cdp.evaluate(`document.querySelector('[data-testid=seal-bg-dark]')?.click(); 'ok'`);
  await sleep(300);
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.closeModal('sealDesigner'); 'ok'`);
  await sleep(600);
  await cdp.evaluate(`window.__PDF_EDITOR__.ui.openModal('sealDesigner'); 'ok'`);
  await sleep(900);
  const bgAfterReopen = await cdp.evaluate(`(() => {
    const active = Array.from(document.querySelectorAll('[data-testid=seal-backgrounds] button')).find((b) => b.className.includes('border-brand-500'));
    return active?.textContent?.trim();
  })()`);
  check('фон превью переживает закрытие окна', bgAfterReopen === 'Тёмный', String(bgAfterReopen));

  await cdp.evaluate(`document.querySelector('[data-testid=seal-insert]').click(); 'ok'`);
  await sleep(1000);
  const insertedObjectId = await cdp.evaluate(`(() => {
    const objects = window.__PDF_EDITOR__.objects.all;
    return objects[objects.length - 1]?.id ?? null;
  })()`);
  await cdp.evaluate(
    `window.__PDF_EDITOR__.ui.openModal('sealDesigner', { objectId: ${JSON.stringify(insertedObjectId)} }); 'ok'`,
  );
  await sleep(1000);
  const bgAfterInsert = await cdp.evaluate(`(() => {
    const active = Array.from(document.querySelectorAll('[data-testid=seal-backgrounds] button')).find((b) => b.className.includes('border-brand-500'));
    return { background: active?.textContent?.trim() };
  })()`);
  check('фон печати помнится после вставки на документ', bgAfterInsert.background === 'Тёмный',
    JSON.stringify({ ...bgAfterInsert, objectId: insertedObjectId }));

  console.log('\n14. Меню добавления, панорама, образец и вкладки');

  const emptyMenu = await cdp.evaluate(`(async () => {
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: rect.left + 6, clientY: rect.top + 6, button: 2,
    }));
    await new Promise((r) => setTimeout(r, 300));
    return {
      items: Array.from(document.querySelectorAll('[data-testid=seal-text-menu] button')).map((b) => b.textContent.trim()),
    };
  })()`);
  check(
    'меню на пустом месте предлагает добавить кольцо и текст',
    ['Добавить кольцо', 'Добавить текст по кольцу', 'Добавить текст в центре'].every((label) =>
      emptyMenu.items.includes(label),
    ),
    JSON.stringify(emptyMenu.items),
  );

  const ringsBeforeMenu = await cdp.evaluate(`window.__SEAL_DESIGNER__.seal.rings.length`);
  await cdp.evaluate(`document.querySelector('[data-testid=seal-menu-add-ring]').click(); 'ok'`);
  await sleep(600);
  const ringsAfterMenu = await cdp.evaluate(`window.__SEAL_DESIGNER__.seal.rings.length`);
  check('из меню добавляется кольцо', ringsAfterMenu === ringsBeforeMenu + 1,
    JSON.stringify({ before: ringsBeforeMenu, after: ringsAfterMenu }));

  // Три дуги: добавляем третью строку и проверяем, что выбирается каждая.
  await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const stamp = await import('/src/services/stampRenderService.ts');
    while (stamp.computeStampLayout(t, (id) => window.__PDF_EDITOR__.fonts.familyOf(id)).seal.ringLines.length < 3) {
      document.querySelector('[data-testid=seal-add-ring-line]')?.click();
      await new Promise((r) => setTimeout(r, 400));
      if (t.seal.lines.filter((line) => line.text.trim()).length >= 4) break;
    }
    return 'ok';
  })()`);
  await sleep(500);
  const arcSelection = await cdp.evaluate(`(async () => {
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const picked = [];
    const count = window.__sealLayout().seal.ringLines.length;
    for (let i = 0; i < count; i += 1) {
      const g = window.__sealGlyph(i);
      if (!g) break;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: g.x, clientY: g.y, button: 0, pointerId: 120 + i }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 120 + i }));
      await new Promise((r) => setTimeout(r, 250));
      picked.push({
        lineId: g.lineId,
        selected: window.__SEAL_DESIGNER__.seal.lines.some((line) => line.id === g.lineId) &&
          Boolean(document.querySelector('[data-testid=seal-handle-0]')),
        handles: document.querySelectorAll('[data-testid^=seal-handle-]').length,
      });
    }
    return picked;
  })()`);
  check('каждую дугу текста можно выбрать кликом',
    arcSelection.length >= 3 && arcSelection.every((item) => item.handles === 2),
    JSON.stringify(arcSelection));

  const nearRing = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const stamp = await import('/src/services/stampRenderService.ts');
    const app = window.__PDF_EDITOR__;
    const layout = () => stamp.computeStampLayout(t, (id) => app.fonts.familyOf(id));
    const g = window.__sealGlyph(0);
    const gapBefore = t.seal.rings[1]?.gap;
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: g.x, clientY: g.y, button: 0, pointerId: 130 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: g.x + 16, clientY: g.y + 6, pointerId: 130 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 130 }));
    await new Promise((r) => setTimeout(r, 500));
    return { gapBefore, gapAfter: t.seal.rings[1]?.gap, radius: layout().seal.ringLines[0]?.radius };
  })()`);
  check('текст рядом с кольцом не тянет кольцо', Math.abs((nearRing.gapAfter ?? 0) - (nearRing.gapBefore ?? 0)) < 0.01,
    JSON.stringify(nearRing));

  const cursor = await cdp.evaluate(`getComputedStyle(document.querySelector('[data-testid=seal-preview-canvas]')).cursor`);
  check('курсор на превью — обычная стрелка', cursor === 'default', String(cursor));

  const panState = await cdp.evaluate(`(async () => {
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const before = window.__SEAL_PREVIEW__.pan();
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
    await new Promise((r) => setTimeout(r, 200));
    const afterWheel = window.__SEAL_PREVIEW__.pan();
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 20, button: 1, pointerId: 131 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + 50, clientY: rect.top + 45, pointerId: 131 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 131 }));
    await new Promise((r) => setTimeout(r, 200));
    const afterDrag = window.__SEAL_PREVIEW__.pan();
    // Сбрасываем панораму, чтобы следующие проверки считали координаты оттиска.
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Вписать')?.click();
    await new Promise((r) => setTimeout(r, 300));
    return { before, afterWheel, afterDrag, reset: window.__SEAL_PREVIEW__.pan() };
  })()`);
  check('превью панорамируется колесом и средней кнопкой',
    (panState.afterWheel.x !== panState.before.x || panState.afterWheel.y !== panState.before.y) &&
      (panState.afterDrag.x !== panState.afterWheel.x || panState.afterDrag.y !== panState.afterWheel.y) &&
      panState.reset.x === 0 && panState.reset.y === 0,
    JSON.stringify(panState));

  const outside = await cdp.evaluate(`(async () => {
    const g = window.__sealGlyph(0);
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: g.x, clientY: g.y, button: 0, pointerId: 132 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 132 }));
    await new Promise((r) => setTimeout(r, 300));
    const before = document.querySelectorAll('[data-testid^=seal-handle-]').length;
    const box = document.querySelector('[data-testid=seal-preview-box]').getBoundingClientRect();
    document.querySelector('[data-testid=seal-preview-box]').dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: box.left + 4, clientY: box.top + 4, button: 0, pointerId: 133,
    }));
    await new Promise((r) => setTimeout(r, 300));
    return { before, after: document.querySelectorAll('[data-testid^=seal-handle-]').length };
  })()`);
  check('клик вне печати снимает фокус', outside.before === 2 && outside.after === 0, JSON.stringify(outside));

  const shrink = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    if (t.seal.rings.length < 2) document.querySelector('[data-testid=seal-add-ring]')?.click();
    Array.from(document.querySelectorAll('[role=tab]')).find((n) => n.textContent.trim() === 'Кольца')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const inputs = Array.from(document.querySelectorAll('[data-testid=seal-ring-1] input'));
    const slider = inputs[inputs.length - 1];
    if (!slider) return { error: 'нет ползунка' };
    slider.value = '60';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const radii = window.__sealLayout().seal.ink.rings.map((ring) => ring.radius);
    return { gap: t.seal.rings[1].gap, radii };
  })()`);
  check('кольцо можно сжать почти до центра',
    shrink.error === undefined && Math.min(...shrink.radii) < 12,
    JSON.stringify(shrink));

  const tabsState = await cdp.evaluate(`(async () => {
    const labels = Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]')).map((n) => n.textContent.trim());
    const click = (label) => Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === label)?.click();
    click('Кольца');
    await new Promise((r) => setTimeout(r, 250));
    const divider = (document.querySelector('[data-testid=seal-right-column]')?.textContent ?? '').includes('Разделитель центра');
    click('Центр');
    await new Promise((r) => setTimeout(r, 250));
    const logoInCenter = Boolean(document.querySelector('[data-testid=seal-logo-section]')?.offsetParent);
    click('Логотип');
    await new Promise((r) => setTimeout(r, 250));
    const logoInTab = Boolean(document.querySelector('[data-testid=seal-logo-section]')?.offsetParent);
    return { labels, divider, logoInCenter, logoInTab };
  })()`);
  check('во вкладке «Кольца» больше нет разделителя центра', tabsState.divider === false, JSON.stringify(tabsState));
  check('логотип перенесён во вкладку «Логотип»',
    tabsState.labels.includes('Логотип') && tabsState.logoInCenter === false && tabsState.logoInTab === true,
    JSON.stringify(tabsState));

  // Логотип: маркер поворота ведёт себя как у объекта.
  const logoRotate = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';
    t.logo = { src: png, width: 30, height: 20, offsetX: 0, offsetY: 0, opacity: 1, rotation: 0 };
    await new Promise((r) => setTimeout(r, 500));
    const logo = window.__sealLayout().logo;
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const c = window.__SEAL_PREVIEW__.client(logo.x + logo.width / 2, logo.y + logo.height / 2);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: c.x, clientY: c.y, button: 0, pointerId: 140 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 140 }));
    await new Promise((r) => setTimeout(r, 400));
    const btn = document.querySelector('[data-testid=seal-logo-rotate]');
    const before = btn.getBoundingClientRect();
    const p = { x: before.left + before.width / 2, y: before.top + before.height / 2 };
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: p.x, clientY: p.y, button: 0, pointerId: 141 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: p.x + 30, clientY: p.y + 4, pointerId: 141 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 141 }));
    await new Promise((r) => setTimeout(r, 400));
    const after = document.querySelector('[data-testid=seal-logo-rotate]').getBoundingClientRect();
    return { rotation: t.logo.rotation, beforeX: Math.round(before.left), afterX: Math.round(after.left) };
  })()`);
  check('маркер поворота логотипа идёт за мышью вправо',
    logoRotate.rotation > 5 && logoRotate.afterX > logoRotate.beforeX,
    JSON.stringify(logoRotate));

  // Образец печати: загрузка (подменяем через отладочный хук), выбор, трансформации.
  const referenceBase = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 140;
    const x = c.getContext('2d');
    x.fillStyle = '#f59e0b'; x.fillRect(0, 0, 200, 140);
    x.fillStyle = '#111'; x.font = 'bold 28px Arial'; x.fillText('ОБРАЗЕЦ', 22, 80);
    window.__SEAL_REFERENCE__.set({
      src: c.toDataURL('image/png'),
      x: t.width * 0.75,
      y: t.height * 0.5,
      width: t.width * 0.45,
      height: t.height * 0.3,
      rotation: 0,
      opacity: 0.6,
      visible: true,
    });
    await new Promise((r) => setTimeout(r, 500));
    return {
      image: Boolean(document.querySelector('[data-testid=seal-reference-image]')),
      controls: Boolean(document.querySelector('[data-testid=seal-reference-controls]')),
    };
  })()`);
  check('образец печати добавляется под превью и имеет настройки',
    referenceBase.image && referenceBase.controls, JSON.stringify(referenceBase));

  const referenceTransform = await cdp.evaluate(`(async () => {
    const img = document.querySelector('[data-testid=seal-reference-image]');
    const r = img.getBoundingClientRect();
    const point = { x: r.left + r.width * 0.82, y: r.top + r.height * 0.18 };
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 150 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 150 }));
    await new Promise((r2) => setTimeout(r2, 400));
    const handles = document.querySelectorAll('[data-testid^=seal-ref-handle-]').length;
    const before = JSON.parse(JSON.stringify(window.__SEAL_REFERENCE__.get()));
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 151 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: point.x + 12, clientY: point.y + 6, pointerId: 151 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 151 }));
    await new Promise((r2) => setTimeout(r2, 400));
    const moved = JSON.parse(JSON.stringify(window.__SEAL_REFERENCE__.get()));
    const corner = document.querySelector('[data-testid=seal-ref-handle-se]');
    const cr = corner.getBoundingClientRect();
    const cp = { x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 };
    corner.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cp.x, clientY: cp.y, button: 0, pointerId: 152 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cp.x + 14, clientY: cp.y + 14, shiftKey: true, pointerId: 152 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 152 }));
    await new Promise((r2) => setTimeout(r2, 400));
    const resized = JSON.parse(JSON.stringify(window.__SEAL_REFERENCE__.get()));
    const rotateBtn = document.querySelector('[data-testid=seal-ref-rotate]');
    const rr = rotateBtn.getBoundingClientRect();
    const rp = { x: rr.left + rr.width / 2, y: rr.top + rr.height / 2 };
    rotateBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rp.x, clientY: rp.y, button: 0, pointerId: 153 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rp.x + 20, clientY: rp.y + 8, pointerId: 153 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 153 }));
    await new Promise((r2) => setTimeout(r2, 400));
    const rotated = JSON.parse(JSON.stringify(window.__SEAL_REFERENCE__.get()));
    return { handles, before, moved, resized, rotated };
  })()`);
  const refRatioBefore = referenceTransform.before.width / referenceTransform.before.height;
  const refRatioAfter = referenceTransform.resized.width / referenceTransform.resized.height;
  check('образец выбирается и показывает маркеры объекта', referenceTransform.handles === 4,
    JSON.stringify({ handles: referenceTransform.handles }));
  check('образец можно перемещать',
    Math.abs(referenceTransform.moved.x - referenceTransform.before.x) > 0.3 ||
      Math.abs(referenceTransform.moved.y - referenceTransform.before.y) > 0.3,
    JSON.stringify({ before: referenceTransform.before, moved: referenceTransform.moved }));
  check('Shift сохраняет пропорции образца',
    referenceTransform.resized.width > referenceTransform.before.width &&
      Math.abs(refRatioAfter - refRatioBefore) < 0.03,
    JSON.stringify({ before: referenceTransform.before, after: referenceTransform.resized }));
  check('образец можно повернуть', Math.abs(referenceTransform.rotated.rotation) > 1,
    String(referenceTransform.rotated.rotation));

  const referenceControls = await cdp.evaluate(`(async () => {
    const switchButton = document.querySelector('[data-testid=seal-reference-visible] button');
    switchButton?.click();
    await new Promise((r) => setTimeout(r, 300));
    const hidden = !document.querySelector('[data-testid=seal-reference-image]');
    switchButton?.click();
    await new Promise((r) => setTimeout(r, 300));
    const visible = Boolean(document.querySelector('[data-testid=seal-reference-image]'));
    const slider = document.querySelector('[data-testid=seal-reference-opacity] input');
    slider.value = '0.9';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { hidden, visible, opacity: JSON.parse(JSON.stringify(window.__SEAL_REFERENCE__.get())).opacity };
  })()`);
  check('образец скрывается и меняет прозрачность',
    referenceControls.hidden && referenceControls.visible && Math.abs(referenceControls.opacity - 0.9) < 0.01,
    JSON.stringify(referenceControls));

  await cdp.evaluate(`window.__PDF_EDITOR__.ui.closeModal('sealDesigner'); 'ok'`);
  await sleep(600);
  await cdp.evaluate(
    `window.__PDF_EDITOR__.ui.openModal('sealDesigner', { objectId: ${JSON.stringify(insertedObjectId)} }); 'ok'`,
  );
  await sleep(1000);
  const referenceRestore = await cdp.evaluate(`(() => {
    const ref = window.__SEAL_REFERENCE__.get();
    return {
      image: Boolean(document.querySelector('[data-testid=seal-reference-image]')),
      rotation: ref?.rotation,
      opacity: ref?.opacity,
    };
  })()`);
  check('образец восстанавливается после закрытия конструктора',
    referenceRestore.image === true && Math.abs(referenceRestore.rotation) > 1 &&
      Math.abs(referenceRestore.opacity - 0.9) < 0.01,
    JSON.stringify(referenceRestore));

  console.log('\n15. Полосы, курсоры, точное попадание и вкладки');

  const layoutState = await cdp.evaluate(`(() => {
    const box = document.querySelector('[data-testid=seal-preview-box]');
    const style = getComputedStyle(box);
    return {
      overflow: style.overflow,
      noHorizontalScroll: box.scrollWidth <= box.clientWidth + 1,
      noVerticalScroll: box.scrollHeight <= box.clientHeight + 1,
      colorControls: document.querySelectorAll('[data-testid^=seal-color-]').length,
      tabs: Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]')).map((n) => n.textContent.trim()),
    };
  })()`);
  check('превью без полос прокрутки',
    layoutState.overflow === 'hidden' && layoutState.noHorizontalScroll && layoutState.noVerticalScroll,
    JSON.stringify(layoutState));
  check('пресеты цвета убраны из-под превью', layoutState.colorControls === 0,
    String(layoutState.colorControls));
  check('есть вкладки «Логотип», «Образец» и «Краска»',
    ['Логотип', 'Образец', 'Краска'].every((label) => layoutState.tabs.includes(label)),
    JSON.stringify(layoutState.tabs));

  const sampleTab = await cdp.evaluate(`(async () => {
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Образец')?.click();
    await new Promise((r) => setTimeout(r, 350));
    const tab = document.querySelector('[data-testid=seal-sample-tab]');
    return {
      open: Boolean(tab && tab.offsetParent),
      reference: Boolean(tab?.querySelector('[data-testid=seal-reference-controls]')),
      presets: Array.from(tab?.querySelectorAll('button') ?? []).map((b) => b.textContent.trim()),
    };
  })()`);
  check('во вкладке «Образец» лежат пресеты и образец печати',
    sampleTab.open && sampleTab.reference && sampleTab.presets.includes('Организация'),
    JSON.stringify(sampleTab));

  // Меню у нижнего края не прячется под полосы превью.
  const menuEdge = await cdp.evaluate(`(async () => {
    const box = document.querySelector('[data-testid=seal-preview-box]').getBoundingClientRect();
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: box.right - 12, clientY: box.bottom - 12, button: 2,
    }));
    await new Promise((r) => setTimeout(r, 300));
    const menu = document.querySelector('[data-testid=seal-text-menu]');
    if (!menu) return { open: false };
    const rect = menu.getBoundingClientRect();
    return {
      open: true,
      fixed: getComputedStyle(menu).position === 'fixed',
      inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      z: getComputedStyle(menu).zIndex,
    };
  })()`);
  check('меню у края превью видно целиком', menuEdge.open && menuEdge.fixed && menuEdge.inViewport,
    JSON.stringify(menuEdge));
  await cdp.evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); 'ok'`);

  // Точное попадание: кольцо и текст рядом.
  await cdp.evaluate(`(async () => {
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Кольца')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const t = window.__SEAL_DESIGNER__;
    while (t.seal.rings.length < 2) {
      document.querySelector('[data-testid=seal-add-ring]')?.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    return 'ok';
  })()`);
  const preciseHit = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const ring = window.__sealLayout().seal.ink.rings[0];
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const ringPoint = window.__SEAL_PREVIEW__.client(ring.cx - ring.radius, ring.cy);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ringPoint.x, clientY: ringPoint.y, button: 0, pointerId: 401 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 401 }));
    await new Promise((r) => setTimeout(r, 300));
    const ringSelected = document.querySelector('[data-testid=seal-ring-0]')?.getAttribute('data-active') === 'true';
    const g = window.__sealGlyph(0);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: g.x, clientY: g.y, button: 0, pointerId: 402 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 402 }));
    await new Promise((r) => setTimeout(r, 300));
    return { ringSelected, textHandles: document.querySelectorAll('[data-testid^=seal-handle-]').length };
  })()`);
  check('точное попадание: кольцо и текст выбираются по клику',
    preciseHit.ringSelected === true && preciseHit.textHandles === 2, JSON.stringify(preciseHit));

  // Курсор над выбранным кольцом — две стрелки.
  const ringCursor = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const ring = window.__sealLayout().seal.ink.rings[0];
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const point = window.__SEAL_PREVIEW__.client(ring.cx - ring.radius, ring.cy);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 403 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 403 }));
    await new Promise((r) => setTimeout(r, 250));
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: point.x, clientY: point.y, pointerId: 403 }));
    await new Promise((r) => setTimeout(r, 200));
    return { cursor: getComputedStyle(canvas).cursor };
  })()`);
  check('над выбранным кольцом курсор — две стрелки',
    ringCursor.cursor === 'ew-resize' || ringCursor.cursor === 'ns-resize', String(ringCursor.cursor));

  // Курсор панорамирования.
  const panCursor = await cdp.evaluate(`(async () => {
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + 30, clientY: rect.top + 30, button: 1, pointerId: 404 }));
    await new Promise((r) => setTimeout(r, 120));
    const during = getComputedStyle(canvas).cursor;
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 404 }));
    await new Promise((r) => setTimeout(r, 120));
    return { during, after: getComputedStyle(canvas).cursor };
  })()`);
  check('при панорамировании курсор — «рука»',
    panCursor.during === 'grabbing' || panCursor.during === 'grab', JSON.stringify(panCursor));

  // Логотип: маркеры как у объекта, курсоры на углах.
  const logoMarkers = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';
    t.logo = { src: png, width: 28, height: 20, offsetX: 0, offsetY: 0, opacity: 1, rotation: 0 };
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Логотип')?.click();
    await new Promise((r) => setTimeout(r, 600));
    const logo = window.__sealLayout().logo;
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const point = window.__SEAL_PREVIEW__.client(logo.x + logo.width / 2, logo.y + logo.height / 2);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 405 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 405 }));
    await new Promise((r) => setTimeout(r, 400));
    const nw = document.querySelector('[data-testid=seal-logo-handle-nw]');
    const rotate = document.querySelector('[data-testid=seal-logo-rotate]');
    return {
      corners: document.querySelectorAll('[data-testid^=seal-logo-handle-]').length,
      nwCursor: nw ? [...nw.classList].find((c) => c.startsWith('cursor-')) : null,
      rotateCursor: rotate ? [...rotate.classList].find((c) => c.startsWith('cursor-')) : null,
    };
  })()`);
  check('у логотипа четыре угла и курсоры как у объекта',
    logoMarkers.corners === 4 && logoMarkers.nwCursor === 'cursor-nwse-resize' &&
      logoMarkers.rotateCursor === 'cursor-grab',
    JSON.stringify(logoMarkers));

  console.log('\n16. Несколько логотипов');

  const multiLogo = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const make = (color) => {
      const c = document.createElement('canvas');
      c.width = 90; c.height = 90;
      const x = c.getContext('2d');
      x.fillStyle = color; x.fillRect(0, 0, 90, 90);
      x.fillStyle = '#fff'; x.font = 'bold 34px Arial'; x.textAlign = 'center';
      x.fillText('Л', 45, 60);
      return c.toDataURL('image/png');
    };
    t.logos = [
      { id: 'l1', src: make('#1d4ed8'), width: 26, height: 26, offsetX: -12, offsetY: 0, opacity: 1, rotation: 0 },
      { id: 'l2', src: make('#b91c1c'), width: 26, height: 26, offsetX: 12, offsetY: 0, opacity: 1, rotation: 0 },
    ];
    t.logo = t.logos[0];
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Логотип')?.click();
    await new Promise((r) => setTimeout(r, 700));
    const cards = document.querySelectorAll('[data-testid^=seal-logo-card-]').length;
    const logos = window.__sealLayout().logos.length;
    const second = window.__sealLayout().logos[1];
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const center = window.__SEAL_PREVIEW__.client(second.x + second.width / 2, second.y + second.height / 2);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: center.x, clientY: center.y, button: 0, pointerId: 430 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 430 }));
    await new Promise((r) => setTimeout(r, 400));
    const activeCard = document.querySelector('[data-testid=seal-logo-card-1]')?.getAttribute('data-active');
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: center.x + 14, clientY: center.y + 8, pointerId: 430 }));
    const beforeOffsets = t.logos.map((logo) => ({ x: logo.offsetX, y: logo.offsetY }));
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: center.x, clientY: center.y, button: 0, pointerId: 431 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: center.x + 14, clientY: center.y + 8, pointerId: 431 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 431 }));
    await new Promise((r) => setTimeout(r, 400));
    return {
      cards,
      logos,
      activeCard,
      handles: document.querySelectorAll('[data-testid^=seal-logo-handle-]').length,
      beforeOffsets,
      afterOffsets: t.logos.map((logo) => ({ x: logo.offsetX, y: logo.offsetY })),
    };
  })()`);
  check('можно добавить несколько логотипов',
    multiLogo.cards === 2 && multiLogo.logos === 2, JSON.stringify(multiLogo));
  check('второй логотип выбирается и двигается отдельно',
    multiLogo.activeCard === 'true' && multiLogo.handles === 4 &&
      Math.abs(multiLogo.afterOffsets[1].x - multiLogo.beforeOffsets[1].x) > 0.3 &&
      Math.abs(multiLogo.afterOffsets[0].x - multiLogo.beforeOffsets[0].x) < 0.01,
    JSON.stringify(multiLogo));

  const multiLogoRemove = await cdp.evaluate(`(async () => {
    document.querySelector('[data-testid=seal-logo-remove-1]')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const t = window.__SEAL_DESIGNER__;
    return { logos: t.logos.length, first: Boolean(t.logo), cards: document.querySelectorAll('[data-testid^=seal-logo-card-]').length };
  })()`);
  check('логотип удаляется по одному', multiLogoRemove.logos === 1 && multiLogoRemove.cards === 1 && multiLogoRemove.first,
    JSON.stringify(multiLogoRemove));

  console.log('\n17. Множественное выделение и группа');

  const marquee = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    // Сбрасываем одиночный фокус.
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const rect = canvas.getBoundingClientRect();
    const start = { x: rect.left + 5, y: rect.top + 5 };
    const end = { x: rect.right - 5, y: rect.bottom - 5 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: start.x, clientY: start.y, button: 0, pointerId: 501 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: end.x, clientY: end.y, pointerId: 501 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: end.x, clientY: end.y, pointerId: 501 }));
    await new Promise((r) => setTimeout(r, 500));
    const card = document.querySelector('[data-testid=seal-multi-card]');
    return {
      card: Boolean(card),
      text: card?.textContent?.trim() ?? '',
      lines: window.__sealLayout().seal.ringLines.length,
    };
  })()`);
  check('рамкой выделяются сразу несколько объектов', marquee.card === true, JSON.stringify(marquee));

  const groupMove = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const before = window.__sealLayout();
    const first = before.seal.ringLines[0];
    const glyph = window.__sealGlyph(0);
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: glyph.x, clientY: glyph.y, button: 0, pointerId: 502 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: glyph.x + 18, clientY: glyph.y + 10, pointerId: 502 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 502 }));
    await new Promise((r) => setTimeout(r, 500));
    const after = window.__sealLayout();
    const moved = after.seal.ringLines[0];
    return {
      lineAngle: t.seal.lines[0]?.angleOffset,
      before: { a: first.centerAngle, r: first.radius },
      after: { a: moved.centerAngle, r: moved.radius },
      multiStill: Boolean(document.querySelector('[data-testid=seal-multi-card]')),
    };
  })()`);
  check('группу можно двигать мышью',
    groupMove.multiStill === true &&
      (Math.abs(groupMove.after.a - groupMove.before.a) > 0.5 ||
        Math.abs(groupMove.after.r - groupMove.before.r) > 0.3),
    JSON.stringify(groupMove));

  const groupDelete = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const before = t.seal.lines.length + t.lines.length;
    document.querySelector('[data-testid=seal-multi-delete]')?.click();
    await new Promise((r) => setTimeout(r, 600));
    return {
      before,
      after: t.seal.lines.length + t.lines.length,
      card: Boolean(document.querySelector('[data-testid=seal-multi-card]')),
    };
  })()`);
  check('группу можно удалить одной кнопкой',
    groupDelete.after < groupDelete.before && groupDelete.card === false,
    JSON.stringify(groupDelete));

  console.log('\n18. Фокус, вся площадь превью и замок образца');

  const focusBlurState = await cdp.evaluate(`(async () => {
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Текст')?.click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('[data-testid=seal-add-ring-line]')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const stamp = await import('/src/services/stampRenderService.ts');
    const layout = () => stamp.computeStampLayout(window.__SEAL_DESIGNER__, (id) => window.__PDF_EDITOR__.fonts.familyOf(id));
    const line = layout().seal.ringLines[0];
    if (!line) return { error: 'нет строки' };
    const ch = line.chars[Math.floor(line.chars.length / 2)];
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const rect = canvas.getBoundingClientRect();
    const radians = (ch.angle * Math.PI) / 180;
    const glyphWidth = ch.fontSize * 0.6;
    const glyph = window.__SEAL_PREVIEW__.client(
      ch.x + Math.cos(radians) * glyphWidth / 2 + Math.sin(radians) * ch.fontSize * 0.35,
      ch.y + Math.sin(radians) * glyphWidth / 2 - Math.cos(radians) * ch.fontSize * 0.35,
    );
    const x = glyph.x;
    const y = glyph.y;
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
    await new Promise((r) => setTimeout(r, 400));
    const before = document.activeElement?.tagName;
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + 4, clientY: rect.top + 4, button: 0, pointerId: 701 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 701 }));
    await new Promise((r) => setTimeout(r, 300));
    const after = document.activeElement?.tagName;
    return { before, after, inputFocusedBefore: before === 'INPUT', inputFocusedAfter: after === 'INPUT' };
  })()`);
  check('клик по пустому месту снимает фокус с поля текста',
    focusBlurState.inputFocusedBefore === true && focusBlurState.inputFocusedAfter === false,
    JSON.stringify(focusBlurState));

  const fullArea = await cdp.evaluate(`(async () => {
    const box = document.querySelector('[data-testid=seal-preview-box]').getBoundingClientRect();
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]').getBoundingClientRect();
    const root = document.querySelector('[data-testid=seal-preview]');
    const rootRect = root.getBoundingClientRect();
    const stamp = window.__SEAL_DESIGNER__;
    const viewport = window.__SEAL_PREVIEW__.viewport();
    root.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: rootRect.right - 6, clientY: rootRect.bottom - 6, button: 2,
    }));
    await new Promise((r) => setTimeout(r, 300));
    const menu = Boolean(document.querySelector('[data-testid=seal-text-menu]'));
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const before = window.__SEAL_PREVIEW__.pan();
    root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 90 }));
    await new Promise((r) => setTimeout(r, 250));
    const after = window.__SEAL_PREVIEW__.pan();
    return {
      menu,
      wider:
        canvas.width >= box.width - 2 &&
        canvas.height >= box.height - 2 &&
        viewport.w > stamp.width * 1.5,
      before,
      after,
    };
  })()`);
  check('превью работает по всей площади, а не только по квадрату оттиска',
    fullArea.wider === true && fullArea.menu === true, JSON.stringify(fullArea));
  check('панорама двигает содержимое превью',
    fullArea.after.x !== fullArea.before.x || fullArea.after.y !== fullArea.before.y,
    JSON.stringify({ before: fullArea.before, after: fullArea.after }));

  const lock = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    t.lines = [];
    t.seal.lines = [];
    t.logos = [];
    t.logo = null;
    const c = document.createElement('canvas');
    c.width = 120; c.height = 120;
    const x = c.getContext('2d');
    x.fillStyle = '#f59e0b'; x.fillRect(0, 0, 120, 120);
    window.__SEAL_REFERENCE__.set({
      src: c.toDataURL('image/png'),
      x: t.width / 2, y: t.height / 2,
      width: t.width * 0.7, height: t.height * 0.7,
      rotation: 0, opacity: 0.7, visible: true, locked: false,
    });
    await new Promise((r) => setTimeout(r, 600));
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const center = window.__SEAL_PREVIEW__.client(window.__SEAL_DESIGNER__.width / 2, window.__SEAL_DESIGNER__.height / 2);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: center.x, clientY: center.y, button: 0, pointerId: 710 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 710 }));
    await new Promise((r) => setTimeout(r, 400));
    const tab = Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.getAttribute('aria-selected') === 'true')?.textContent.trim();
    const handlesBefore = document.querySelectorAll('[data-testid^=seal-ref-handle-]').length;
    document.querySelector('[data-testid=seal-reference-lock] button')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const locked = window.__SEAL_REFERENCE__.get()?.locked;
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: center.x, clientY: center.y, button: 0, pointerId: 711 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 711 }));
    await new Promise((r) => setTimeout(r, 300));
    const handlesLocked = document.querySelectorAll('[data-testid^=seal-ref-handle-]').length;
    document.querySelector('[data-testid=seal-reference-lock] button')?.click();
    await new Promise((r) => setTimeout(r, 300));
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: center.x, clientY: center.y, button: 0, pointerId: 712 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 712 }));
    await new Promise((r) => setTimeout(r, 300));
    const handlesUnlocked = document.querySelectorAll('[data-testid^=seal-ref-handle-]').length;
    return { tab, handlesBefore, locked, handlesLocked, handlesUnlocked };
  })()`);
  check('выбор образца открывает вкладку «Образец»', lock.tab === 'Образец' && lock.handlesBefore === 4,
    JSON.stringify(lock));
  check('замок образца отключает клики по нему',
    lock.locked === true && lock.handlesLocked === 0 && lock.handlesUnlocked === 4, JSON.stringify(lock));

  const marginMarquee = await cdp.evaluate(`(async () => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const t = window.__SEAL_DESIGNER__;
    const { createSealRingLine } = await import('/src/services/sealRenderService.ts');
    if (t.seal.lines.length < 2) {
      t.seal.lines.push(createSealRingLine({ text: 'ВЕРХНЯЯ', slot: 0, side: 'top', fontSize: 5 }));
      t.seal.lines.push(createSealRingLine({ text: 'НИЖНЯЯ', slot: 0, side: 'bottom', fontSize: 5 }));
    }
    await new Promise((r) => setTimeout(r, 500));
    const root = document.querySelector('[data-testid=seal-preview]');
    const rect = root.getBoundingClientRect();
    const start = { x: rect.left + 4, y: rect.top + 4 };
    const end = { x: rect.right - 4, y: rect.bottom - 4 };
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: start.x, clientY: start.y, button: 0, pointerId: 720 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: end.x, clientY: end.y, pointerId: 720 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 720 }));
    await new Promise((r) => setTimeout(r, 500));
    return {
      card: Boolean(document.querySelector('[data-testid=seal-multi-card]')),
      text: document.querySelector('[data-testid=seal-multi-card]')?.textContent?.trim() ?? '',
    };
  })()`);
  check('рамкой можно выделять объекты по всей площади превью', marginMarquee.card === true,
    JSON.stringify(marginMarquee));

  console.log('\n19. Зум, кегль, оси центрирования и размеры колец');

  const zoomMax = await cdp.evaluate(`(async () => {
    const slider = document.querySelector('[data-testid=seal-zoom]');
    slider.value = '12';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const text = slider.parentElement?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
    const ok = text.includes('1200%');
    slider.value = '3';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return { max: slider.max, text, ok };
  })()`);
  check('зум превью доходит до 1200%', zoomMax.max === '12' && zoomMax.ok === true, JSON.stringify(zoomMax));

  const geometry = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const t = window.__SEAL_DESIGNER__;
    const layout = () => stamp.computeStampLayout(t, (id) => window.__PDF_EDITOR__.fonts.familyOf(id));
    // Кольцо: минимальная толщина.
    while (t.seal.rings.length < 1) {
      document.querySelector('[data-testid=seal-add-ring]')?.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Кольца')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const widthInput = document.querySelector('[data-testid=seal-ring-0] input');
    if (widthInput) {
      widthInput.value = '0.2';
      widthInput.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
    }
    const ringWidth = t.seal.rings[0]?.width;
    const layoutWidth = layout().seal.ink.rings[0]?.width;

    // Кегль центра не должен уменьшаться от трекинга и межсловного интервала.
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Центр')?.click();
    await new Promise((r) => setTimeout(r, 250));
    if (t.lines.length === 0) {
      const { createStampLine } = await import('/src/services/stampRenderService.ts');
      t.lines.push(createStampLine('ЦЕНТР', { fontSize: 10 }));
      await new Promise((r) => setTimeout(r, 400));
    }
    t.lines[0].fontSize = 10;
    t.lines[0].letterSpacing = 0;
    t.lines[0].wordSpacing = 0;
    await new Promise((r) => setTimeout(r, 400));
    const fontBefore = layout().lines[0]?.fontSize;
    t.lines[0].letterSpacing = 18;
    t.lines[0].wordSpacing = 14;
    await new Promise((r) => setTimeout(r, 400));
    const fontAfter = layout().lines[0]?.fontSize;
    return { ringWidth, layoutWidth, fontBefore, fontAfter };
  })()`);
  check('минимальная толщина кольца — 0.2 pt',
    Math.abs(geometry.ringWidth - 0.2) < 0.01 && Math.abs((geometry.layoutWidth ?? 0) - 0.2) < 0.05,
    JSON.stringify(geometry));
  check('кегль не меняется от растяжения и интервалов',
    Math.abs(geometry.fontAfter - geometry.fontBefore) < 0.01,
    JSON.stringify(geometry));

  const guides = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const t = window.__SEAL_DESIGNER__;
    const line = stamp.computeStampLayout(t, (id) => window.__PDF_EDITOR__.fonts.familyOf(id)).lines[0];
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const point = window.__SEAL_PREVIEW__.client(line.x + line.width / 2, line.baseline - line.fontSize * 0.4);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 801 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: point.x + 1, clientY: point.y, pointerId: 801 }));
    await new Promise((r) => setTimeout(r, 500));
    const overlay = document.querySelector('[data-testid=seal-designer] [data-testid=seal-overlay]');
    const ctx = overlay.getContext('2d');
    let lit = 0;
    for (let attempt = 0; attempt < 10 && lit === 0; attempt += 1) {
      await new Promise((r) => setTimeout(r, 120));
      const data = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
      lit = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit += 1;
    }
    const during = document.querySelector('[data-testid=seal-preview]').getAttribute('data-guides');
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 801 }));
    await new Promise((r) => setTimeout(r, 250));
    return {
      selected: window.__SEAL_DESIGNER_STATE__.get().selectedCenterIndex,
      lit,
      guides: during,
      after: document.querySelector('[data-testid=seal-preview]').getAttribute('data-guides'),
      overlay: { w: overlay.width, h: overlay.height },
    };
  })()`);
  check('при перемещении текста центра видны оси центрирования',
    guides.selected !== null && guides.guides === 'true' && guides.lit > 10 && guides.after === 'false',
    JSON.stringify(guides));

  const marqueeOverlay = await cdp.evaluate(`(async () => {
    const root = document.querySelector('[data-testid=seal-preview]');
    const overlay = document.querySelector('[data-testid=seal-overlay]');
    const rect = root.getBoundingClientRect();
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + 6, clientY: rect.top + 6, button: 0, pointerId: 802 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.right - 6, clientY: rect.bottom - 6, pointerId: 802 }));
    await new Promise((r) => setTimeout(r, 250));
    const during = root.getAttribute('data-marquee');
    const ctx = overlay.getContext('2d');
    const data = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit += 1;
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 802 }));
    await new Promise((r) => setTimeout(r, 200));
    return {
      during,
      after: root.getAttribute('data-marquee'),
      lit,
      overlayWider: overlay.getBoundingClientRect().width >= root.getBoundingClientRect().width - 2,
    };
  })()`);
  check('рамка выделения видна по всей площади превью',
    marqueeOverlay.during === 'true' && marqueeOverlay.after === 'false' &&
      marqueeOverlay.lit > 100 && marqueeOverlay.overlayWider === true,
    JSON.stringify(marqueeOverlay));

  const ringDimension = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    while (t.seal.rings.length < 2) {
      document.querySelector('[data-testid=seal-add-ring]')?.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Кольца')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const stamp = await import('/src/services/stampRenderService.ts');
    const ring = stamp.computeStampLayout(t, (id) => window.__PDF_EDITOR__.fonts.familyOf(id)).seal.ink.rings[1];
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const angle = Math.PI / 4;
    const point = window.__SEAL_PREVIEW__.client(
      ring.cx + Math.cos(angle) * ring.radius,
      ring.cy + Math.sin(angle) * ring.radius,
    );
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 803 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: point.x + 14, clientY: point.y + 10, pointerId: 803 }));
    await new Promise((r) => setTimeout(r, 300));
    const overlay = document.querySelector('[data-testid=seal-designer] [data-testid=seal-overlay]');
    const overlayCtx = overlay.getContext('2d');
    const pixels = overlayCtx.getImageData(0, 0, overlay.width, overlay.height).data;
    let red = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 150 && pixels[i + 1] < 110 && pixels[i + 2] < 140 && pixels[i + 3] > 20) red += 1;
    }
    const before = {
      annotation: document.querySelector('[data-testid=seal-preview]').getAttribute('data-ring-annotation'),
      gap: t.seal.rings[1].gap,
      red,
    };
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 803 }));
    await new Promise((r) => setTimeout(r, 250));
    return {
      before,
      after: document.querySelector('[data-testid=seal-preview]').getAttribute('data-ring-annotation'),
    };
  })()`);
  check('при перетаскивании кольца видна размерная линия между кольцами',
    ringDimension.before.annotation === 'true' && ringDimension.after === 'false',
    JSON.stringify(ringDimension));
  check('размерная линия и число при перетаскивании кольца — красные',
    ringDimension.before.red > 5, JSON.stringify(ringDimension.before));

  console.log('\n20. Центрирование, предел кольца и кнопки выравнивания');

  const align = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Текст')?.click();
    await new Promise((r) => setTimeout(r, 300));
    t.seal.lines[0].radiusOffset = 7;
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('[data-testid=seal-line-align-gap]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const arcOffset = t.seal.lines[0].radiusOffset;
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Центр')?.click();
    await new Promise((r) => setTimeout(r, 300));
    t.lines[0].offsetX = 9;
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('[data-testid=seal-center-align]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    return { arcOffset, centerOffset: t.lines[0].offsetX };
  })()`);
  check('кнопка центрирует строку по кольцевому зазору', Math.abs(align.arcOffset) < 0.01, JSON.stringify(align));
  check('кнопка центрирует текст по вертикальной оси печати',
    Math.abs(align.centerOffset) < 0.01, JSON.stringify(align));

  const ringLimit = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    while (t.seal.rings.length < 2) {
      document.querySelector('[data-testid=seal-add-ring]')?.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Кольца')?.click();
    t.seal.rings[1].gap = 8;
    await new Promise((r) => setTimeout(r, 500));
    const stamp = await import('/src/services/stampRenderService.ts');
    const ring = stamp.computeStampLayout(t, (id) => window.__PDF_EDITOR__.fonts.familyOf(id)).seal.ink.rings[1];
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const angle = Math.PI / 4;
    const point = window.__SEAL_PREVIEW__.client(
      ring.cx + Math.cos(angle) * ring.radius,
      ring.cy + Math.sin(angle) * ring.radius,
    );
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 901 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: point.x + 120, clientY: point.y + 120, pointerId: 901 }));
    await new Promise((r) => setTimeout(r, 300));
    const first = { gap: t.seal.rings[1].gap, shown: window.__SEAL_PREVIEW__.ringGap(), annotation: document.querySelector('[data-testid=seal-preview]').getAttribute('data-ring-annotation') };
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: point.x + 260, clientY: point.y + 260, pointerId: 901 }));
    await new Promise((r) => setTimeout(r, 300));
    const second = { gap: t.seal.rings[1].gap, shown: window.__SEAL_PREVIEW__.ringGap() };
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 901 }));
    await new Promise((r) => setTimeout(r, 200));
    return { first, second, after: document.querySelector('[data-testid=seal-preview]').getAttribute('data-ring-annotation') };
  })()`);
  check('на пределе зазора размер останавливается и не «считается» дальше',
    Math.abs(ringLimit.first.gap - 0.5) < 0.01 &&
      Math.abs(ringLimit.second.gap - 0.5) < 0.01 &&
      Math.abs((ringLimit.first.shown ?? 0) - (ringLimit.second.shown ?? 0)) < 0.01 &&
      ringLimit.first.annotation === 'true',
    JSON.stringify(ringLimit));

  const groupGuides = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const stamp = await import('/src/services/stampRenderService.ts');
    for (let attempt = 0; attempt < 6 && t.lines.length < 2; attempt += 1) {
      Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
        .find((n) => n.textContent.trim() === 'Центр')?.click();
      document.querySelector('[data-testid=seal-add-line]')?.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    t.lines.forEach((line, index) => {
      if (!line.text.trim()) line.text = index === 0 ? 'ЦЕНТР' : 'ВТОРАЯ';
      line.offsetX = 0;
      line.offsetY = 0;
    });
    await new Promise((r) => setTimeout(r, 500));
    const layout = stamp.computeStampLayout(t, (id) => window.__PDF_EDITOR__.fonts.familyOf(id));
    const points = layout.lines.map((line) => window.__SEAL_PREVIEW__.client(line.x + line.width / 2, line.baseline - line.fontSize * 0.35));
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    // Рамкой вокруг центра — группа строк.
    const root = document.querySelector('[data-testid=seal-preview]');
    const rootRect = root.getBoundingClientRect();
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rootRect.left + 12, clientY: rootRect.top + 12, button: 0, pointerId: 915 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rootRect.right - 12, clientY: rootRect.bottom - 12, pointerId: 915 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 915 }));
    await new Promise((r) => setTimeout(r, 500));
    const multi = window.__SEAL_DESIGNER_STATE__.get().multi;
    // Тянем группу — оси должны появиться только на время движения.
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: points[0].x, clientY: points[0].y, button: 0, pointerId: 930 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: points[0].x + 2, clientY: points[0].y + 2, pointerId: 930 }));
    await new Promise((r) => setTimeout(r, 400));
    const during = document.querySelector('[data-testid=seal-preview]').getAttribute('data-guides');
    const overlay = document.querySelector('[data-testid=seal-designer] [data-testid=seal-overlay]');
    const ctx = overlay.getContext('2d');
    const data = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit += 1;
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 930 }));
    await new Promise((r) => setTimeout(r, 300));
    const after = document.querySelector('[data-testid=seal-preview]').getAttribute('data-guides');
    const boxes = multi.centers.map((index) => stamp.computeStampLayout(t, (id) => window.__PDF_EDITOR__.fonts.familyOf(id)).lines[index]).filter(Boolean);
    const left = Math.min(...boxes.map((item) => item.x));
    const right = Math.max(...boxes.map((item) => item.x + item.width));
    const top = Math.min(...boxes.map((item) => item.baseline - item.fontSize));
    const bottom = Math.max(...boxes.map((item) => item.baseline));
    return {
      centers: multi.centers.length,
      during,
      after,
      lit,
      groupX: (left + right) / 2,
      groupY: (top + bottom) / 2,
      center: t.width / 2,
    };
  })()`);
  check('при движении группы текста оси идут по центру группы',
    groupGuides.centers >= 2 && groupGuides.during === 'true' && groupGuides.after === 'false' &&
      groupGuides.lit > 10 &&
      Math.abs(groupGuides.groupX - groupGuides.center) < 3 &&
      Math.abs(groupGuides.groupY - groupGuides.center) < 3,
    JSON.stringify(groupGuides));

  console.log('\n21. Кнопки текста, красные маркеры и оси по прилипанию');

  const textButtons = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Текст')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const card = document.querySelector('[data-testid=seal-line-0]');
    const bold = card?.querySelector('button[title^="Полужирный"]');
    const italic = card?.querySelector('button[title="Курсив"]');
    const center = card?.querySelector('button[title^="Центрировать"]');
    const underline = card?.querySelector('[data-testid=seal-line-underline]');
    const boldSpan = bold?.querySelector('span');
    if (underline) underline.click();
    await new Promise((r) => setTimeout(r, 300));
    const underlineOn = t.seal.lines[0].underline;
    if (underline) underline.click();
    await new Promise((r) => setTimeout(r, 300));
    const underlineOff = t.seal.lines[0].underline;
    return {
      bold: bold?.textContent?.trim(),
      weight: boldSpan ? getComputedStyle(boldSpan).fontWeight : null,
      italicText: italic?.textContent?.trim() ?? null,
      centerText: center?.textContent?.trim() ?? null,
      underline: Boolean(underline),
      underlineOn,
      underlineOff,
    };
  })()`);
  check('жирная кнопка — только полужирная B',
    textButtons.bold === 'B' && textButtons.weight === '600', JSON.stringify(textButtons));

  const underlineCheck = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Центр')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const button = document.querySelector('[data-testid=seal-center-underline]');
    const before = Boolean(t.lines[0].underline);
    button?.click();
    await new Promise((r) => setTimeout(r, 300));
    const after = Boolean(t.lines[0].underline);
    button?.click();
    await new Promise((r) => setTimeout(r, 300));
    const again = Boolean(t.lines[0].underline);
    return { before, after, again, exists: Boolean(button) };
  })()`);
  check('кнопка подчёркивания работает в обе стороны',
    underlineCheck.exists && underlineCheck.after === !underlineCheck.before &&
      underlineCheck.again === underlineCheck.before, JSON.stringify(underlineCheck));

  const redMarker = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const layout = window.__sealLayout();
    const line = layout.seal.ringLines[0];
    const point = window.__SEAL_PREVIEW__.client(
      line.chars[Math.floor(line.chars.length / 2)].x,
      line.chars[Math.floor(line.chars.length / 2)].y,
    );
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 950 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 950 }));
    await new Promise((r) => setTimeout(r, 350));
    const handle = document.querySelector('[data-testid=seal-handle-0]');
    return {
      border: handle ? getComputedStyle(handle).borderColor : null,
      center: { x: t.lines[0] ? window.__SEAL_PREVIEW__.client(0, 0) : null },
    };
  })()`);
  check('текстовые маркеры с красной обводкой',
    redMarker.border === 'rgb(225, 29, 72)', JSON.stringify(redMarker));

  const centerMarker = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const layout = window.__sealLayout();
    const line = layout.lines[0];
    const point = window.__SEAL_PREVIEW__.client(line.x + line.width / 2, line.baseline - line.fontSize * 0.35);
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 951 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 951 }));
    await new Promise((r) => setTimeout(r, 350));
    const overlay = document.querySelector('[data-testid=seal-designer] [data-testid=seal-overlay]');
    const rect = overlay.getBoundingClientRect();
    const ctx = overlay.getContext('2d');
    const ratio = overlay.width / rect.width;
    const cx = Math.round((point.x - rect.left) * ratio);
    const cy = Math.round((point.y - rect.top) * ratio);
    const data = ctx.getImageData(Math.max(0, cx - 8), Math.max(0, cy - 8), 16, 16).data;
    let red = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 120 && data[i + 3] > 40) red += 1;
    }
    return { selected: window.__SEAL_DESIGNER_STATE__.get().selectedCenterIndex, red };
  })()`);
  check('у выбранной строки центра есть красный маркер центра',
    centerMarker.selected !== null && centerMarker.red > 0, JSON.stringify(centerMarker));

  check('кнопки курсива и центрирования без букв',
    textButtons.italicText === '' && textButtons.centerText === '', JSON.stringify(textButtons));

  const snapAxes = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Центр')?.click();
    await new Promise((r) => setTimeout(r, 300));
    t.lines[0].offsetX = 0;
    t.lines[0].offsetY = 15;
    await new Promise((r) => setTimeout(r, 400));
    const layout = window.__sealLayout();
    const line = layout.lines[0];
    const point = window.__SEAL_PREVIEW__.client(line.x + line.width / 2, line.baseline - line.fontSize * 0.35);
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 960 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: point.x + 1, clientY: point.y, pointerId: 960 }));
    await new Promise((r) => setTimeout(r, 350));
    const during = {
      axes: window.__SEAL_PREVIEW__.axes(),
      guides: document.querySelector('[data-testid=seal-preview]').getAttribute('data-guides'),
    };
    const overlay = document.querySelector('[data-testid=seal-designer] [data-testid=seal-overlay]');
    const ctx = overlay.getContext('2d');
    const rect = overlay.getBoundingClientRect();
    const ratio = overlay.width / rect.width;
    const data = ctx.getImageData(Math.round((rect.width / 2) * ratio), 0, 1, Math.round((rect.height * 0.3) * ratio)).data;
    during.pixel = Array.from(data);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 960 }));
    await new Promise((r) => setTimeout(r, 250));
    return { during, after: window.__SEAL_PREVIEW__.axes() };
  })()`);
  check('показывается только та ось, к которой прилип текст',
    snapAxes.during.axes.vertical === true && snapAxes.during.axes.horizontal === false &&
      snapAxes.during.guides === 'true' && snapAxes.after.vertical === false,
    JSON.stringify(snapAxes));
  let axisRed = 0;
  for (let i = 0; i < snapAxes.during.pixel.length; i += 4) {
    if (snapAxes.during.pixel[i] > 150 && snapAxes.during.pixel[i + 1] < 100 && snapAxes.during.pixel[i + 2] < 130) axisRed += 1;
  }
  check('ось центрирования красная', axisRed > 0,
    JSON.stringify({ red: axisRed, samples: snapAxes.during.pixel.length / 4 }));

  const horizontalSnap = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    t.lines[0].offsetX = 15;
    const current = window.__sealLayout().lines[0];
    t.lines[0].offsetY += t.width / 2 - (current.inkCenterY ?? current.baseline - current.fontSize * 0.36);
    await new Promise((r) => setTimeout(r, 400));
    const line = window.__sealLayout().lines[0];
    const point = window.__SEAL_PREVIEW__.client(line.x + line.width / 2, line.inkCenterY ?? line.baseline);
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 1010 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: point.x, clientY: point.y + 1, pointerId: 1010 }));
    await new Promise((r) => setTimeout(r, 350));
    const axes = window.__SEAL_PREVIEW__.axes();
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1010 }));
    await new Promise((r) => setTimeout(r, 250));
    return { axes, offsetY: t.lines[0].offsetY };
  })()`);
  check('текст прилипает к горизонтальной оси по центру букв',
    horizontalSnap.axes.horizontal === true && horizontalSnap.axes.vertical === false,
    JSON.stringify(horizontalSnap));

  const circular = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Текст')?.click();
    t.seal.lines[0].radiusOffset = 0;
    t.seal.lines[0].angleOffset = 0;
    await new Promise((r) => setTimeout(r, 400));
    const line = window.__sealLayout().seal.ringLines[0];
    const ch = line.chars[Math.floor(line.chars.length / 2)];
    const point = window.__SEAL_PREVIEW__.client(ch.x, ch.y);
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 961 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: point.x, clientY: point.y - 2, pointerId: 961 }));
    await new Promise((r) => setTimeout(r, 300));
    const during = {
      axes: window.__SEAL_PREVIEW__.axes(),
      guides: document.querySelector('[data-testid=seal-preview]').getAttribute('data-guides'),
    };
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 961 }));
    await new Promise((r) => setTimeout(r, 250));
    return { during, after: window.__SEAL_PREVIEW__.axes() };
  })()`);
  check('круговая строка прилипает к середине зазора и показывает кольцевую ось',
    circular.during.axes.circular === true && circular.during.guides === 'true' &&
      circular.after.circular === false,
    JSON.stringify(circular));

  const marqueeBlue = await cdp.evaluate(`(async () => {
    const root = document.querySelector('[data-testid=seal-preview]');
    const rect = root.getBoundingClientRect();
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + rect.width * 0.15, clientY: rect.top + rect.height * 0.15, button: 0, pointerId: 962 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + rect.width * 0.65, clientY: rect.top + rect.height * 0.65, pointerId: 962 }));
    await new Promise((r) => setTimeout(r, 250));
    const overlay = document.querySelector('[data-testid=seal-designer] [data-testid=seal-overlay]');
    const ctx = overlay.getContext('2d');
    const ratio = overlay.width / overlay.getBoundingClientRect().width;
    const x = Math.round(rect.width * 0.4 * ratio);
    const y = Math.round(rect.height * 0.4 * ratio);
    const data = ctx.getImageData(x, y, 1, 1).data;
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 962 }));
    await new Promise((r) => setTimeout(r, 200));
    return Array.from(data);
  })()`);
  check('область выделения мышкой — синеватая',
    marqueeBlue[2] > marqueeBlue[0] + 10 && marqueeBlue[3] > 15, JSON.stringify(marqueeBlue));

  const ringColors = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    t.color = '#1d4ed8';
    await new Promise((r) => setTimeout(r, 300));
    const blueStroke = window.__SEAL_PREVIEW__.ringStroke();
    t.color = '#b91c1c';
    await new Promise((r) => setTimeout(r, 300));
    const redStroke = window.__SEAL_PREVIEW__.ringStroke();
    return { blueStroke, redStroke };
  })()`);
  check('штрих кольца контрастен цвету печати',
    ringColors.blueStroke !== '#1d4ed8' && ringColors.redStroke !== '#b91c1c' &&
      ringColors.blueStroke !== ringColors.redStroke,
    JSON.stringify(ringColors));

  const wordSlider = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Текст')?.click();
    await new Promise((r) => setTimeout(r, 300));
    t.seal.lines[0].wordSpacing = 7;
    await new Promise((r) => setTimeout(r, 300));
    const input = document.querySelector('[data-testid=seal-line-0-word] input');
    const shown = input ? Number(input.value) : null;
    input.value = '9';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { shown, value: t.seal.lines[0].wordSpacing };
  })()`);
  check('ползунок «Между словами» показывает и меняет значение',
    wordSlider.shown === 7 && wordSlider.value === 9, JSON.stringify(wordSlider));

  console.log('\n22. Стрелки, прямые линии и поворот текста');

  const angleSpacing = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Текст')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const line = t.seal.lines[0];
    line.text = 'ТЕСТ ТЕКСТ';
    line.letterSpacing = 1;
    line.wordSpacing = 2;
    await new Promise((r) => setTimeout(r, 300));
    const slider = document.querySelector('[data-testid=seal-line-0-span] input');
    slider.value = '250';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const geometry = window.__sealLayout().seal.ringLines.find((item) => item.lineId === line.id);
    return {
      target: line.spanAngle,
      actual: Math.abs(geometry.endAngle - geometry.startAngle),
      tracking: line.letterSpacing,
      word: line.wordSpacing,
    };
  })()`);
  check('смена угла двигает и трекинг, и межсловный интервал',
    Math.abs(angleSpacing.actual - 250) < 2 && angleSpacing.tracking > 1 && angleSpacing.word > 2,
    JSON.stringify(angleSpacing));

  const keyboardMoves = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const centerLine = window.__sealLayout().lines[0];
    const point = window.__SEAL_PREVIEW__.client(centerLine.x + centerLine.width / 2, centerLine.inkCenterY ?? centerLine.baseline);
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 970 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 970 }));
    t.lines[0].offsetX = 0;
    t.lines[0].offsetY = 0;
    await new Promise((r) => setTimeout(r, 300));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp' }));
    await new Promise((r) => setTimeout(r, 400));
    const centerOffset = { x: t.lines[0].offsetX, y: t.lines[0].offsetY };
    const arcLine = window.__sealLayout().seal.ringLines[0];
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Текст')?.click();
    await new Promise((r) => setTimeout(r, 250));
    const arcCard = document.querySelector('[data-testid=seal-line-0]');
    arcCard?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 971 }));
    await new Promise((r) => setTimeout(r, 300));
    const arcBefore = { radius: t.seal.lines[0].radiusOffset, angle: t.seal.lines[0].angleOffset };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight' }));
    await new Promise((r) => setTimeout(r, 400));
    const arcAfter = { radius: t.seal.lines[0].radiusOffset, angle: t.seal.lines[0].angleOffset };
    if (t.seal.rings.length < 2) document.querySelector('[data-testid=seal-add-ring]')?.click();
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Кольца')?.click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('[data-testid=seal-ring-1]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 972 }));
    await new Promise((r) => setTimeout(r, 300));
    const gapBefore = t.seal.rings[1].gap;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp' }));
    await new Promise((r) => setTimeout(r, 300));
    return { centerOffset, arcBefore, arcAfter, gapBefore, gapAfter: t.seal.rings[1].gap };
  })()`);
  check('стрелки двигают строку центра с шагом 0.1 pt',
    Math.abs(keyboardMoves.centerOffset.x - 0.1) < 0.01 &&
      Math.abs(keyboardMoves.centerOffset.y + 0.1) < 0.01,
    JSON.stringify(keyboardMoves));
  check('стрелки двигают дуговой текст',
    keyboardMoves.arcAfter.radius > keyboardMoves.arcBefore.radius &&
      keyboardMoves.arcAfter.angle !== keyboardMoves.arcBefore.angle,
    JSON.stringify(keyboardMoves));
  check('стрелка вверх увеличивает расстояние до кольца на 0.1 pt',
    Math.abs((keyboardMoves.gapAfter - keyboardMoves.gapBefore) - 0.1) < 0.01,
    JSON.stringify(keyboardMoves));

  const straight = await cdp.evaluate(`(async () => {
    const stamp = await import('/src/services/stampRenderService.ts');
    const t = window.__SEAL_DESIGNER__;
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Линии')?.click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('[data-testid=seal-add-straight-line]')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const lines = t.seal.straightLines ?? [];
    const line = lines[0];
    const svg = stamp.stampTemplateToSvg(t, (id) => window.__PDF_EDITOR__.fonts.familyOf(id));
    return { count: lines.length, svg: svg.includes('<line'), width: line?.width, rotation: line?.rotation };
  })()`);
  check('линия добавляется и рисуется в SVG',
    straight.count === 1 && straight.svg === true && straight.width > 0,
    JSON.stringify(straight));

  const straightInteraction = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const geometry = window.__sealLayout().seal.straightLines[0];
    const center = window.__SEAL_PREVIEW__.client(geometry.cx, geometry.cy);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: center.x, clientY: center.y, button: 0, pointerId: 980 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 980 }));
    await new Promise((r) => setTimeout(r, 400));
    const selected = {
      handles: document.querySelectorAll('[data-testid^=seal-stroke-handle-]').length,
      rotate: Boolean(document.querySelector('[data-testid=seal-stroke-rotate]')),
      state: window.__SEAL_DESIGNER_STATE__.get(),
    };
    const before = { x: t.seal.straightLines[0].x, y: t.seal.straightLines[0].y };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: center.x, clientY: center.y, button: 0, pointerId: 981 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: center.x + 12, clientY: center.y + 4, pointerId: 981 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 981 }));
    await new Promise((r) => setTimeout(r, 300));
    const moved = { x: t.seal.straightLines[0].x, y: t.seal.straightLines[0].y };
    const beforeGeometry = window.__sealLayout().seal.straightLines[0];
    const endHandle = document.querySelector('[data-testid=seal-stroke-handle-end]');
    const endRect = endHandle?.getBoundingClientRect();
    const startHandle = endRect ? { x: endRect.left + endRect.width / 2, y: endRect.top + endRect.height / 2 } : null;
    if (!startHandle || !endHandle) return { selected, moved, before, error: 'нет маркера' };
    endHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startHandle.x, clientY: startHandle.y, button: 0, pointerId: 982 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: startHandle.x + 28, clientY: startHandle.y + 8, pointerId: 982 }));
    await new Promise((r) => setTimeout(r, 300));
    const duringAnnotation = document.querySelector('[data-testid=seal-preview]').getAttribute('data-stroke-annotation');
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 982 }));
    await new Promise((r) => setTimeout(r, 300));
    const afterGeometry = window.__sealLayout().seal.straightLines[0];
    const rotateButton = document.querySelector('[data-testid=seal-stroke-rotate]');
    const rotationBefore = t.seal.straightLines[0].rotation;
    let rotationAfter = rotationBefore;
    if (rotateButton) {
      const rr = rotateButton.getBoundingClientRect();
      const rotateStart = { x: rr.left + rr.width / 2, y: rr.top + rr.height / 2 };
      rotateButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rotateStart.x, clientY: rotateStart.y, button: 0, pointerId: 983 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rotateStart.x + 26, clientY: rotateStart.y + 12, pointerId: 983 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 983 }));
      await new Promise((r) => setTimeout(r, 300));
      rotationAfter = t.seal.straightLines[0].rotation;
    }
    return {
      selected,
      moved,
      before,
      lengthBefore: beforeGeometry.length,
      lengthAfter: afterGeometry.length,
      fixedStart: Math.hypot(afterGeometry.x1 - beforeGeometry.x1, afterGeometry.y1 - beforeGeometry.y1),
      duringAnnotation,
      afterAnnotation: document.querySelector('[data-testid=seal-preview]').getAttribute('data-stroke-annotation'),
      rotationBefore,
      rotationAfter,
    };
  })()`);
  check('линия выделяется, двигается за тело и имеет маркеры концов и поворота',
    straightInteraction.selected?.handles === 2 && straightInteraction.selected?.rotate === true &&
      Math.abs((straightInteraction.moved?.x ?? 0) - (straightInteraction.before?.x ?? 0)) > 0.5,
    JSON.stringify(straightInteraction));
  check('растягивание за конец сохраняет второй конец и показывает красный размер',
    straightInteraction.lengthAfter > straightInteraction.lengthBefore &&
      straightInteraction.fixedStart < 1 &&
      straightInteraction.duringAnnotation === 'true' &&
      straightInteraction.afterAnnotation === 'false',
    JSON.stringify(straightInteraction));
  check('прямую линию можно вращать маркером',
    Math.abs(straightInteraction.rotationAfter - straightInteraction.rotationBefore) > 1,
    JSON.stringify(straightInteraction));

  const groupRotate = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const root = document.querySelector('[data-testid=seal-preview]');
    const rect = root.getBoundingClientRect();
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + rect.width * 0.2, clientY: rect.top + rect.height * 0.2, button: 0, pointerId: 1001 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + rect.width * 0.8, clientY: rect.top + rect.height * 0.8, pointerId: 1001 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1001 }));
    await new Promise((r) => setTimeout(r, 500));
    const before = t.lines.map((line) => line.rotation ?? 0);
    const button = document.querySelector('[data-testid=seal-center-rotate]');
    if (!button) return { error: 'нет маркера' };
    const b = button.getBoundingClientRect();
    const start = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: start.x, clientY: start.y, button: 0, pointerId: 1002 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: start.x + 30, clientY: start.y + 14, pointerId: 1002 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1002 }));
    await new Promise((r) => setTimeout(r, 400));
    return {
      kind: button.getAttribute('data-kind'),
      changed: t.lines.some((line, index) => Math.abs((line.rotation ?? 0) - before[index]) > 1),
    };
  })()`);
  check('группу строк можно вращать общим маркером',
    groupRotate.kind === 'group' && groupRotate.changed === true,
    JSON.stringify(groupRotate));

  const arcGroupSnap = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const root = document.querySelector('[data-testid=seal-preview]');
    const rect = root.getBoundingClientRect();
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + rect.width * 0.2, clientY: rect.top + rect.height * 0.2, button: 0, pointerId: 1003 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + rect.width * 0.8, clientY: rect.top + rect.height * 0.8, pointerId: 1003 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1003 }));
    await new Promise((r) => setTimeout(r, 500));
    t.seal.lines.forEach((line) => { line.radiusOffset = 0.5; });
    await new Promise((r) => setTimeout(r, 400));
    const line = window.__sealLayout().seal.ringLines[0];
    const p = window.__SEAL_PREVIEW__.client(line.chars[Math.floor(line.chars.length / 2)].x, line.chars[Math.floor(line.chars.length / 2)].y);
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: p.x, clientY: p.y, button: 0, pointerId: 1004 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: p.x, clientY: p.y + 1, pointerId: 1004 }));
    await new Promise((r) => setTimeout(r, 300));
    const circular = window.__SEAL_PREVIEW__.axes().circular;
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1004 }));
    await new Promise((r) => setTimeout(r, 300));
    return {
      circular,
      offsets: t.seal.lines.map((item) => item.radiusOffset),
    };
  })()`);
  check('группа дугового текста прилипает к середине зазора',
    arcGroupSnap.circular === true &&
      arcGroupSnap.offsets.every((offset) => Math.abs(offset) < 0.01),
    JSON.stringify(arcGroupSnap));

  const centerRotate = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    Array.from(document.querySelectorAll('[data-testid=seal-designer] [role=tab]'))
      .find((n) => n.textContent.trim() === 'Центр')?.click();
    await new Promise((r) => setTimeout(r, 300));
    t.lines[0].rotation = 0;
    await new Promise((r) => setTimeout(r, 300));
    const layout = window.__sealLayout();
    const line = layout.lines[0];
    const p = window.__SEAL_PREVIEW__.client(line.x + line.width / 2, line.inkCenterY ?? line.baseline);
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: p.x, clientY: p.y, button: 0, pointerId: 990 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 990 }));
    await new Promise((r) => setTimeout(r, 300));
    const button = document.querySelector('[data-testid=seal-center-rotate]');
    if (!button) return { error: 'нет маркера поворота' };
    const rect = button.getBoundingClientRect();
    const start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: start.x, clientY: start.y, button: 0, pointerId: 991 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: start.x + 30, clientY: start.y + 10, pointerId: 991 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 991 }));
    await new Promise((r) => setTimeout(r, 400));
    return { rotation: t.lines[0].rotation };
  })()`);
  check('строку центра можно вращать маркером',
    centerRotate.rotation !== undefined && Math.abs(centerRotate.rotation) > 1,
    JSON.stringify(centerRotate));

  console.log('\n23. Стрелки для группы, логотипа, образца и линии');

  const groupArrows = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const root = document.querySelector('[data-testid=seal-preview]');
    const rect = root.getBoundingClientRect();
    root.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + rect.width * 0.2, clientY: rect.top + rect.height * 0.2, button: 0, pointerId: 995 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + rect.width * 0.8, clientY: rect.top + rect.height * 0.8, pointerId: 995 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 995 }));
    await new Promise((r) => setTimeout(r, 500));
    const selection = window.__SEAL_DESIGNER_STATE__.get().multi;
    const before = t.lines.slice(0, 2).map((line) => ({ x: line.offsetX ?? 0, y: line.offsetY }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp' }));
    await new Promise((r) => setTimeout(r, 400));
    const after = t.lines.slice(0, 2).map((line) => ({ x: line.offsetX ?? 0, y: line.offsetY }));
    return { centers: selection?.centers.length ?? 0, before, after, rotate: Boolean(document.querySelector('[data-testid=seal-center-rotate]')) };
  })()`);
  check('стрелки двигают группу строк',
    groupArrows.centers >= 2 &&
      Math.abs(groupArrows.after[0].x - groupArrows.before[0].x - 0.1) < 0.001 &&
      Math.abs(groupArrows.after[1].y - groupArrows.before[1].y + 0.1) < 0.001,
    JSON.stringify(groupArrows));
  check('у группы строк есть общий маркер поворота', groupArrows.rotate === true, JSON.stringify(groupArrows));

  const objectArrows = await cdp.evaluate(`(async () => {
    const t = window.__SEAL_DESIGNER__;
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';
    t.logos = [{ id: 'arrow-logo', src: png, width: 20, height: 20, offsetX: 0, offsetY: 0, opacity: 1, rotation: 0 }];
    t.logo = t.logos[0];
    await new Promise((r) => setTimeout(r, 500));
    const logo = window.__sealLayout().logo;
    const point = window.__SEAL_PREVIEW__.client(logo.x + logo.width / 2, logo.y + logo.height / 2);
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0, pointerId: 996 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 996 }));
    await new Promise((r) => setTimeout(r, 300));
    const logoBefore = t.logos[0].offsetX;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight' }));
    await new Promise((r) => setTimeout(r, 300));
    const logoAfter = t.logos[0].offsetX;

    const c = document.createElement('canvas');
    c.width = 100; c.height = 100;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f59e0b'; ctx.fillRect(0, 0, 100, 100);
    window.__SEAL_REFERENCE__.set({ src: c.toDataURL('image/png'), x: t.width * 0.5, y: t.height * 0.5, width: t.width * 1.2, height: t.height * 1.2, rotation: 0, opacity: 0.5, visible: true, locked: false });
    await new Promise((r) => setTimeout(r, 500));
    const refRect = document.querySelector('[data-testid=seal-reference-image]').getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: refRect.right - 4, clientY: refRect.top + 4, button: 0, pointerId: 997 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 997 }));
    await new Promise((r) => setTimeout(r, 300));
    const refBefore = window.__SEAL_REFERENCE__.get().x;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft' }));
    await new Promise((r) => setTimeout(r, 300));
    const refAfter = window.__SEAL_REFERENCE__.get().x;

    document.querySelector('[data-testid=seal-straight-line-0]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const lineBefore = t.seal.straightLines[0].y;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown' }));
    await new Promise((r) => setTimeout(r, 300));
    return { logoBefore, logoAfter, refBefore, refAfter, lineBefore, lineAfter: t.seal.straightLines[0].y };
  })()`);
  check('стрелки двигают логотип с шагом 0.1 pt',
    Math.abs((objectArrows.logoAfter - objectArrows.logoBefore) - 0.1) < 0.01, JSON.stringify(objectArrows));
  check('стрелки двигают образец с шагом 0.1 pt',
    Math.abs((objectArrows.refAfter - objectArrows.refBefore) + 0.1) < 0.08, JSON.stringify(objectArrows));
  check('стрелки двигают прямую линию с шагом 0.1 pt',
    Math.abs((objectArrows.lineAfter - objectArrows.lineBefore) - 0.1) < 0.08, JSON.stringify(objectArrows));



  await cdp.evaluate(`window.__PDF_EDITOR__.ui.closeAllModals(); 'ok'`);
  await sleep(600);

  console.log('\n--- Ошибки консоли ---');
  console.log(cdp.errors.length === 0 ? '(нет)' : cdp.errors.join('\n'));
  if (cdp.errors.length > 0) process.exitCode = 1;
} finally {
  close();
}

console.log(`\nПроверок пройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;

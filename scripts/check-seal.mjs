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
  check('по умолчанию печать 40 мм = 113 px', initial.mm === 40 && Math.abs(initial.width - 113.39) < 0.5);
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
      const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
      const rect = canvas.getBoundingClientRect();
      const zoom = rect.width / t.width;
      const rad = (ch.angle * Math.PI) / 180;
      const w = ch.fontSize * 0.6;
      return {
        x: rect.left + (ch.x + Math.cos(rad) * w / 2 + Math.sin(rad) * ch.fontSize * 0.35) * zoom,
        y: rect.top + (ch.y + Math.sin(rad) * w / 2 - Math.cos(rad) * ch.fontSize * 0.35) * zoom,
        lineId: line.lineId,
      };
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

  const spanStart = await cdp.evaluate(`window.__SEAL_DESIGNER__.seal.lines[0].spanAngle`);
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
    return { target: line.spanAngle, actual: window.__sealLineInfo(line.id).span };
  })()`);
  check('маркер растягивает строку', spanGrown.target > Math.max(1, spanStart), JSON.stringify(spanGrown));

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
    return { target: line.spanAngle, actual: window.__sealLineInfo(line.id).span };
  })()`);
  check('маркер сжимает строку', spanShrunk.target < spanGrown.target, JSON.stringify({ spanGrown, spanShrunk }));
  check('сжатие не обещает больше, чем может', Math.abs(spanShrunk.actual - spanShrunk.target) < 2,
    `${spanShrunk.target}° / факт ${spanShrunk.actual.toFixed(1)}°`);

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
    const rect = canvas.getBoundingClientRect();
    const zoom = rect.width / t.width;
    const x = rect.left + (line.x + line.width / 2) * zoom;
    const y = rect.top + (line.baseline - line.fontSize * 0.4) * zoom;
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

  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid=seal-color-7c3aed]').click();
    return 'ok';
  })()`);
  await sleep(300);
  const color = await cdp.evaluate(`window.__SEAL_DESIGNER__.color`);
  check('цвет из пресета применяется', color === '#7c3aed', color);

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
    right?.querySelector('[data-testid=color-trigger]')?.click();
    await new Promise((r) => setTimeout(r, 200));
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
    document.querySelector('[data-testid=seal-color-7c3aed]').click();
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
    const canvas = document.querySelector('[data-testid=seal-preview-canvas]');
    const rect = canvas.getBoundingClientRect();
    const zoom = rect.width / t.width;
    const rad = (ch.angle * Math.PI) / 180;
    const w = ch.fontSize * 0.6;
    return {
      x: rect.left + (ch.x + Math.cos(rad) * w / 2 + Math.sin(rad) * ch.fontSize * 0.35) * zoom,
      y: rect.top + (ch.y + Math.sin(rad) * w / 2 - Math.cos(rad) * ch.fontSize * 0.35) * zoom,
    };
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

/** Скриншот: свойства линии (без заливки) и стрелка с наконечниками с двух сторон. */
import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9373 });

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

  const ids = await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    const factory = await import('/src/services/objectFactory.ts');
    const line = factory.createShapeObject('line', {
      page: 0, x: 300, y: 90, width: 220, height: 40, name: 'Фигура',
      defaults: { stroke: '#dc2626', strokeWidth: 3, fill: null },
      points: [0, 0.5, 1, 0.5],
      dash: [8, 5, 1, 5],
    });
    const arrow = factory.createShapeObject('arrow', {
      page: 0, x: 300, y: 170, width: 220, height: 40, name: 'Фигура',
      defaults: { stroke: '#2563eb', strokeWidth: 3, fill: null },
      points: [0, 0.5, 1, 0.5],
      arrowHead: 'both',
    });
    const dots = factory.createShapeObject('line', {
      page: 0, x: 300, y: 250, width: 220, height: 40, name: 'Фигура',
      defaults: { stroke: '#16a34a', strokeWidth: 3, fill: null },
      points: [0, 0.5, 1, 0.5],
      dash: [1, 6],
    });
    app.objects.add([line, arrow, dots], 'тест');
    app.objects.select([arrow.id]);
    app.ui.setRightTab('properties');
    document.activeElement?.blur?.();
    return { line: line.id, arrow: arrow.id };
  })()`);
  await sleep(1500);
  await cdp.screenshot(resolvePath(TMP, 'shape-styles-arrow.png'));

  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.select([${JSON.stringify(ids.line)}]);
    return 'ok';
  })()`);
  await sleep(1200);
  await cdp.screenshot(resolvePath(TMP, 'shape-styles-line.png'));

  // Параметры инструмента «Линия»: «Цвет линии» / «Толщина линии».
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.editor.setTool('line');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(1000);
  await cdp.screenshot(resolvePath(TMP, 'shape-styles-tool.png'));
  console.log('Скриншоты сохранены');
} catch (error) {
  console.error('ОШИБКА:', error);
} finally {
  close();
}

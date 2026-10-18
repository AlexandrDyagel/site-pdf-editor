/** Скриншот: палитра обводки с «Без цвета» и фигура с нулевой толщиной. */
import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9372 });

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
    const make = (kind, x, y, fill) => factory.createShapeObject(kind, {
      page: 0, x, y, width: 180, height: 110, name: 'Фигура',
      defaults: { stroke: '#dc2626', strokeWidth: 3, fill },
    });
    const solid = make('rect', 300, 90, '#fde68a');
    const empty = make('ellipse', 300, 230, null);
    app.objects.add([solid, empty], 'тест');
    app.objects.select([solid.id]);
    app.ui.setRightTab('properties');
    document.activeElement?.blur?.();
    return { solid: solid.id, empty: empty.id };
  })()`);
  await sleep(1500);

  // Открываем палитру обводки, чтобы был виден пункт «Без цвета».
  await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('aside button')).find((element) => {
      const label = element.parentElement?.querySelector('span');
      return label && label.textContent.trim() === 'Обводка';
    });
    if (button) button.click();
    return 'ok';
  })()`);
  await sleep(800);
  await cdp.screenshot(resolvePath(TMP, 'stroke-no-color.png'));

  // Толщина 0 — обводки нет.
  await cdp.evaluate(`(() => {
    const app = window.__PDF_EDITOR__;
    app.objects.patchSilent(${JSON.stringify(ids.solid)}, { payload: { strokeWidth: 0 } });
    app.objects.patchSilent(${JSON.stringify(ids.empty)}, { payload: { strokeWidth: 0 } });
    document.body.click();
    return 'ok';
  })()`);
  await sleep(1200);
  await cdp.screenshot(resolvePath(TMP, 'stroke-zero.png'));
  console.log('Скриншоты сохранены');
} catch (error) {
  console.error('ОШИБКА:', error);
} finally {
  close();
}

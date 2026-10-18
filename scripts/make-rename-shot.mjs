/** Скриншот: переименование объекта в «Служебном» и имя в «Слоях». */
import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');

const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9375 });

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

  await cdp.evaluate(`(async () => {
    const app = window.__PDF_EDITOR__;
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    const factory = await import('/src/services/objectFactory.ts');
    const make = (kind, x, y, fill) => factory.createShapeObject(kind, {
      page: 0, x, y, width: 170, height: 100,
      defaults: { stroke: '#1d4ed8', strokeWidth: 2, fill },
    });
    const plan = make('rect', 300, 90, '#dbeafe');
    const zone = make('ellipse', 300, 220, '#dcfce7');
    app.objects.add([plan, zone], 'тест');
    app.objects.rename(plan.id, 'План зала');
    app.objects.rename(zone.id, 'Зона VIP');
    app.objects.select([plan.id]);
    app.ui.setRightTab('properties');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(1400);

  // Открываем раздел «Служебное» и панель «Слои» на скриншоте не покажем сразу —
  // сначала свойства с открытым разделом.
  await cdp.evaluate(`(() => {
    const aside = Array.from(document.querySelectorAll('aside')).pop();
    const header = Array.from(aside.querySelectorAll('button')).find((button) =>
      (button.textContent || '').includes('Служебное'),
    );
    if (header) header.click();
    return 'ok';
  })()`);
  await sleep(900);
  // Прокручиваем свойства вниз, чтобы был виден раздел «Служебное».
  await cdp.evaluate(`(() => {
    const aside = Array.from(document.querySelectorAll('aside')).pop();
    const scroller = aside.querySelector('.overflow-y-auto') ?? aside;
    scroller.scrollTop = scroller.scrollHeight;
    return 'ok';
  })()`);
  await sleep(700);
  await cdp.screenshot(resolvePath(TMP, 'rename-properties.png'));

  await cdp.evaluate(`window.__PDF_EDITOR__.ui.setRightTab('layers'); 'ok'`);
  await sleep(1000);
  await cdp.screenshot(resolvePath(TMP, 'rename-layers.png'));
  console.log('Скриншоты сохранены');
} catch (error) {
  console.error('ОШИБКА:', error);
} finally {
  close();
}

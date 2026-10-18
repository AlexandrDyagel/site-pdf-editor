import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');
const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9377 });
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
    const factory = await import('/src/services/objectFactory.ts');
    app.editor.fitToWidth();
    app.objects.clearAll(false);
    const make = (kind, x, y, fill) => factory.createShapeObject(kind, {
      page: 0, x, y, width: 150, height: 100,
      defaults: { stroke: '#1d4ed8', strokeWidth: 2, fill },
    });
    const a = make('rect', 140, 120, '#dbeafe');
    const b = make('ellipse', 240, 210, '#dcfce7');
    const c = make('rect', 420, 150, '#fde68a');
    app.objects.add([a, b, c], 'тест');
    app.objects.select([a.id, b.id]);
    app.objects.group();
    app.objects.clearSelection();
    app.editor.setTool('select');
    app.ui.setRightTab('layers');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(1200);
  await cdp.screenshot(resolvePath(TMP, 'groups.png'));

  // Открываем контекстное меню по строке группы.
  await cdp.evaluate(`(() => {
    const right = Array.from(document.querySelectorAll('aside')).pop();
    const row = right.querySelector('[data-group-id]');
    if (!row) return 'нет строки';
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(rect.left + 40), clientY: Math.round(rect.top + 12) }));
    return 'ok';
  })()`);
  await sleep(700);
  await cdp.screenshot(resolvePath(TMP, 'groups-menu.png'));
  console.log('Скриншоты сохранены');
} catch (error) {
  console.error('ОШИБКА:', error);
} finally {
  close();
}

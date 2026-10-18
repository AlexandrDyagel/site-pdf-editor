import { readFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';

const TMP = resolvePath('.tmp');
await mkdir(TMP, { recursive: true });
const base64 = (await readFile(resolvePath(TMP, 'test.pdf'))).toString('base64');
const { cdp, close } = await launchBrowser({ url: 'http://127.0.0.1:5173/', port: 9370 });
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
    const triangle = factory.createShapeObject('triangle', {
      page: 0, x: 300, y: 90, width: 200, height: 173,
      defaults: { stroke: '#1d4ed8', strokeWidth: 2, fill: '#dbeafe' },
    });
    const polygon = factory.createShapeObject('polygon', {
      page: 0, x: 300, y: 290, width: 180, height: 180,
      defaults: { stroke: '#15803d', strokeWidth: 2, fill: '#dcfce7' },
      sides: 8,
    });
    app.objects.add([triangle, polygon], 'тест');
    app.objects.select([]);
    app.editor.setTool('triangle');
    document.activeElement?.blur?.();
    return 'ok';
  })()`);
  await sleep(1200);
  await cdp.screenshot(resolvePath(TMP, 'shift-hint.png'));
  console.log('Скриншот сохранён');
} catch (error) {
  console.error('ОШИБКА:', error);
} finally {
  close();
}

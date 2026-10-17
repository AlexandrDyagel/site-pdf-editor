/**
 * Проверка приложения в реальном браузере через Chrome DevTools Protocol.
 *
 * Запускает headless Chrome, открывает приложение, собирает ошибки консоли,
 * загружает тестовый PDF через файловый input, делает скриншоты и анализирует
 * содержимое canvas (действительно ли страница отрисована).
 *
 * Запуск: node scripts/browser-check.mjs [url]
 */

import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';

const URL_APP = process.argv[2] ?? 'http://127.0.0.1:5173/';
const PORT = 9333;
const TMP = resolvePath('.tmp');
const PDF_PATH = resolvePath('.tmp/test.pdf');
// Профиль браузера держим вне проекта, чтобы файловый watcher Vite его не трогал.
const PROFILE = resolvePath(tmpdir(), 'pdf-editor-chrome-profile');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  const found = BROWSERS.find((path) => existsSync(path));
  if (!found) throw new Error('Не найден Chrome или Edge');
  return found;
}

class Cdp {
  static async connect(wsUrl) {
    const client = new Cdp(wsUrl);
    await client.open();
    return client;
  }

  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (event) => reject(new Error(`WebSocket: ${event.message ?? 'ошибка'}`));
      this.ws.onmessage = (event) => this.onMessage(String(event.data));
    });
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    for (const handler of this.handlers) handler(message);
  }

  on(handler) {
    this.handlers.push(handler);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(description);
    }
    return result.result.value;
  }

  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await mkdir(TMP, { recursive: true });
    const file = resolvePath(TMP, name);
    await writeFile(file, Buffer.from(data, 'base64'));
    return file;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* игнорируем */
    }
  }
}

/** Ожидание цели отладки. */
async function waitForTarget(deadlineMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* браузер ещё поднимается */
    }
    await sleep(300);
  }
  throw new Error('Не удалось подключиться к Chrome DevTools Protocol');
}

const logs = [];
const errors = [];
const failedRequests = [];

function attachLogging(client) {
  client.on((message) => {
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(' ');
      logs.push(`[${message.params.type}] ${text}`);
      if (message.params.type === 'error') errors.push(text);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      const description = details.exception?.description ?? details.text;
      errors.push(`ИСКЛЮЧЕНИЕ: ${description}`);
    }
    if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry;
      logs.push(`[log:${entry.level}] ${entry.text}`);
      if (entry.level === 'error') errors.push(entry.text);
    }
    if (message.method === 'Network.responseReceived') {
      const { response } = message.params;
      if (response.status >= 400) {
        failedRequests.push(`${response.status} ${response.url}`);
      }
    }
    if (message.method === 'Network.loadingFailed') {
      failedRequests.push(`FAILED ${message.params.errorText} (${message.params.type})`);
    }
  });
}

const browser = spawn(findBrowser(), [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,BackForwardCache',
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  '--window-size=1680,950',
  'about:blank',
], { stdio: 'ignore' });

let client = null;
try {
  const target = await waitForTarget();
  client = await Cdp.connect(target.webSocketDebuggerUrl);
  attachLogging(client);

  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Page.enable');
  await client.send('Network.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1680,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });

  console.log(`→ Открываю ${URL_APP}`);
  await client.send('Page.navigate', { url: URL_APP });
  await sleep(4000);

  const startInfo = await client.evaluate(`(() => ({
    title: document.title,
    bodyText: document.body.innerText.slice(0, 400),
    hasApp: Boolean(document.querySelector('#app')?.children.length),
    canvasCount: document.querySelectorAll('canvas').length,
  }))()`);
  console.log('Стартовый экран:', JSON.stringify(startInfo, null, 2));
  console.log('Скриншот:', await client.screenshot('01-start.png'));

  if (!existsSync(PDF_PATH)) {
    console.log('! Тестовый PDF не найден — создайте его: node scripts/make-test-pdf.mjs');
  } else {
    const base64 = (await readFile(PDF_PATH)).toString('base64');
    await client.evaluate(
      `window.__TEST_PDF = ${JSON.stringify(base64)}; 'ok'`,
    );

    console.log('→ Загружаю PDF через файловый input');
    const injected = await client.evaluate(`(() => {
      const binary = atob(window.__TEST_PDF);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], 'тестовый-кириллица.pdf', { type: 'application/pdf' });
      const input = document.querySelector('input[type=file]');
      if (!input) return 'нет input[type=file]';
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'файл передан: ' + file.name + ' (' + bytes.length + ' байт)';
    })()`);
    console.log(injected);

    console.log('→ Перехожу в редактор (#/editor)');
    await client.evaluate(`location.hash = '#/editor'; 'ok'`);
    await sleep(10000);

    const editorInfo = await client.evaluate(`(() => {
      const canvases = Array.from(document.querySelectorAll('canvas')).map((canvas) => {
        let nonWhite = 0;
        let sampled = 0;
        try {
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, Math.min(canvas.width, 500), Math.min(canvas.height, 500)).data;
          for (let i = 0; i < data.length; i += 4) {
            sampled += 1;
            if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) nonWhite += 1;
          }
        } catch (error) {
          return { width: canvas.width, height: canvas.height, error: String(error) };
        }
        return {
          width: canvas.width,
          height: canvas.height,
          nonWhitePixels: nonWhite,
          sampled,
          parentClass: canvas.parentElement?.className ?? '',
        };
      });
      const container = document.querySelector('[data-testid=editor-canvas]');
      const konvaContainer = container?.firstElementChild;
      return {
        url: location.hash,
        canvases,
        editorPresent: Boolean(container),
        editorSize: container ? container.clientWidth + 'x' + container.clientHeight : null,
        konvaSize: konvaContainer ? konvaContainer.clientWidth + 'x' + konvaContainer.clientHeight : null,
        konvaStyle: konvaContainer?.getAttribute('style') ?? null,
        text: document.body.innerText.replace(/\\n{2,}/g, '\\n').slice(0, 400),
      };
    })()`);
    console.log('Редактор:', JSON.stringify(editorInfo, null, 2));
    console.log('Скриншот:', await client.screenshot('02-editor.png'));
  }

  console.log('\n--- Неудачные запросы ---');
  console.log(failedRequests.length === 0 ? '(нет)' : [...new Set(failedRequests)].join('\n'));
  console.log('\n--- Ошибки консоли ---');
  console.log(errors.length === 0 ? '(нет)' : errors.join('\n'));
  console.log('\n--- Логи консоли (последние 30) ---');
  console.log(logs.slice(-30).join('\n') || '(пусто)');
} catch (error) {
  console.error('ОШИБКА ПРОВЕРКИ:', error);
  process.exitCode = 1;
} finally {
  client?.close();
  browser.kill();
}

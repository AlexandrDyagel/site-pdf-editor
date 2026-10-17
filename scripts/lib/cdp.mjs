/**
 * Общий помощник для проверок в реальном браузере через Chrome DevTools Protocol.
 * Используется скриптами browser-check.mjs и browser-workflow.mjs.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  const found = BROWSERS.find((path) => existsSync(path));
  if (!found) throw new Error('Не найден Chrome или Edge для автоматической проверки');
  return found;
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.logs = [];
    this.errors = [];
    this.failedRequests = [];
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

    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(' ');
      this.logs.push(`[${message.params.type}] ${text}`);
      if (message.params.type === 'error') this.errors.push(text);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      this.errors.push(`ИСКЛЮЧЕНИЕ: ${details.exception?.description ?? details.text}`);
    }
    if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry;
      this.logs.push(`[log:${entry.level}] ${entry.text}`);
      if (entry.level === 'error') this.errors.push(entry.text);
    }
    if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
      this.failedRequests.push(`${message.params.response.status} ${message.params.response.url}`);
    }
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
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value;
  }

  /** Нажатие клавиши (через реальный ввод браузера). */
  async pressKey(key, code, virtualKeyCode, modifiers = 0) {
    const base = { modifiers, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: key.length === 1 ? key : undefined, ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** Клик мышью по координатам окна. */
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  }

  /** Перетаскивание мышью. */
  async drag(from, to, steps = 8) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    for (let i = 1; i <= steps; i += 1) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'mouse' });
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const dir = resolvePath(path, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(path, Buffer.from(data, 'base64'));
    return path;
  }
}

/**
 * Запуск браузера и подключение к первой странице.
 * Возвращает { cdp, close }.
 */
export async function launchBrowser({ url, port = 9333, width = 1680, height = 950 }) {
  const profile = resolvePath(tmpdir(), `pdf-editor-check-${port}`);
  const browser = spawn(findBrowser(), [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,BackForwardCache',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const deadline = Date.now() + 25000;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
    } catch {
      /* браузер ещё поднимается */
    }
    if (!target) await sleep(300);
  }
  if (!target) {
    browser.kill();
    throw new Error('Не удалось подключиться к Chrome DevTools Protocol');
  }

  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  if (url) {
    await cdp.send('Page.navigate', { url });
    await sleep(3500);
  }

  return {
    cdp,
    close: () => {
      try {
        cdp.ws?.close();
      } catch {
        /* игнорируем */
      }
      browser.kill();
    },
  };
}

/** Итоговый отчёт: печатает ошибки и выставляет код выхода. */
export function report(cdp, { requireNoErrors = true } = {}) {
  const uniqueFailed = [...new Set(cdp.failedRequests)];
  console.log('\n--- Неудачные запросы ---');
  console.log(uniqueFailed.length === 0 ? '(нет)' : uniqueFailed.join('\n'));
  console.log('\n--- Ошибки консоли ---');
  console.log(cdp.errors.length === 0 ? '(нет)' : cdp.errors.join('\n'));
  if (requireNoErrors && (cdp.errors.length > 0 || uniqueFailed.length > 0)) {
    process.exitCode = 1;
  }
}

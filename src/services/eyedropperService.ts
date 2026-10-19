/**
 * Пипетка: берёт цвет пикселя с холста и отдаёт его в HEX.
 *
 * Палитра (`AppColorPicker`) вызывает `startEyedropper()`; следующий клик по
 * холсту перехватывается в `EditorCanvas` (фаза перехвата, до Konva), поэтому
 * клик не создаёт объект и не начинает штрих. Пиксель складывается из всех
 * слоёв сцены — получается ровно тот цвет, который видит пользователь.
 */

import type Konva from 'konva';
import { rgbToHex } from '@/utils/pdf';

let stage: Konva.Stage | null = null;
let pending: ((color: string | null) => void) | null = null;
const listeners = new Set<() => void>();

/** Подключение сцены (вызывается из `EditorCanvas`). */
export function bindEyedropperStage(value: Konva.Stage | null): void {
  stage = value;
}

/** Включена ли пипетка. */
export function isEyedropperActive(): boolean {
  return pending !== null;
}

/** Подписка на включение/выключение пипетки (для курсора и подсказки). */
export function onEyedropperChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Включает пипетку: следующий клик по холсту отдаст цвет (или null). */
export function startEyedropper(): Promise<string | null> {
  cancelEyedropper();
  return new Promise<string | null>((resolve) => {
    pending = resolve;
    window.addEventListener('keydown', onEscape, true);
    notify();
  });
}

/** Отменяет пипетку (Esc, повторный вызов, уход со страницы). */
export function cancelEyedropper(): void {
  if (!pending) return;
  const resolve = pending;
  pending = null;
  window.removeEventListener('keydown', onEscape, true);
  notify();
  resolve(null);
}

/** Завершает выбор: читает пиксель и возвращает цвет. */
export function resolveEyedropper(clientX: number, clientY: number): string | null {
  const resolve = pending;
  if (!resolve) return null;
  pending = null;
  window.removeEventListener('keydown', onEscape, true);
  notify();
  const color = readColorAt(clientX, clientY);
  resolve(color);
  return color;
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  cancelEyedropper();
}

/** Цвет пикселя под курсором (в координатах окна). */
export function readColorAt(clientX: number, clientY: number): string | null {
  const instance = stage;
  if (!instance) return null;
  const box = instance.container().getBoundingClientRect();
  const x = clientX - box.left;
  const y = clientY - box.top;
  if (x < 0 || y < 0 || x > box.width || y > box.height) return null;

  const pixel = document.createElement('canvas');
  pixel.width = 1;
  pixel.height = 1;
  const ctx = pixel.getContext('2d');
  if (!ctx) return null;
  // Слои снизу вверх: страница PDF, объекты, служебный слой.
  for (const layer of instance.getLayers()) {
    const canvas = layer.getCanvas()._canvas;
    const ratio = instance.width() > 0 ? canvas.width / instance.width() : 1;
    ctx.drawImage(canvas, x * ratio, y * ratio, 1, 1, 0, 0, 1, 1);
  }
  const data = ctx.getImageData(0, 0, 1, 1).data;
  // Прозрачное место — это подложка страницы, считаем её белой.
  if (data[3] < 10) return '#ffffff';
  return rgbToHex({ r: data[0] / 255, g: data[1] / 255, b: data[2] / 255 });
}

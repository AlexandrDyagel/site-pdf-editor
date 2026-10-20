/**
 * Воркер детекции текста: PP-OCRv4 det (DBNet) через onnxruntime-web.
 *
 * Зачем воркер: инференс на wasm занимает сотни миллисекунд, в главном потоке это
 * заметный фриз. Здесь же он не блокирует ни рисование, ни прокрутку.
 *
 * Вход: RGBA-пиксели ROI (ImageData.data) + размеры.
 * Выход: маска текста 0/1 в тех же размерах (Uint8Array), переносится без копирования.
 */

// Важно: сборка «wasm» без WebGPU/jsep — иначе ORT тянет лишний 27 МБ бандл.
import * as ort from 'onnxruntime-web/wasm';

const MODEL_URL = '/models/text-det.onnx';
/** Длинная сторона входа: PP-OCRv4 det обучен на 960, больше не нужно. */
const MAX_SIDE = 960;
/** Порог вероятности «это текст» (DBNet отдаёт карту вероятностей). */
const TEXT_THRESHOLD = 0.3;

ort.env.wasm.wasmPaths = '/ort/';
// Потоки требуют COOP/COEP-заголовков; без них wasm обязан быть однопоточным.
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

let sessionPromise: Promise<ort.InferenceSession> | null = null;

/** Загружает модель один раз на воркер. */
function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }
  return sessionPromise;
}

interface DetectRequest {
  id: number;
  width: number;
  height: number;
  /** RGBA, 4 байта на пиксель. */
  pixels: Uint8ClampedArray;
}

self.onmessage = async (event: MessageEvent<DetectRequest>) => {
  const { id, width, height, pixels } = event.data;
  try {
    const session = await getSession();

    // Масштаб: длинную сторону ограничиваем, размеры кратны 32 (требование сети).
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const inputWidth = Math.max(32, Math.round((width * scale) / 32) * 32);
    const inputHeight = Math.max(32, Math.round((height * scale) / 32) * 32);

    // RGBA -> NCHW float32 с нормализацией ImageNet (как в PaddleOCR).
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const data = new Float32Array(3 * inputWidth * inputHeight);
    for (let y = 0; y < inputHeight; y += 1) {
      const sourceY = Math.min(height - 1, Math.floor(y / scale));
      for (let x = 0; x < inputWidth; x += 1) {
        const sourceX = Math.min(width - 1, Math.floor(x / scale));
        const source = (sourceY * width + sourceX) * 4;
        const position = y * inputWidth + x;
        for (let channel = 0; channel < 3; channel += 1) {
          data[channel * inputWidth * inputHeight + position] =
            (pixels[source + channel] / 255 - mean[channel]) / std[channel];
        }
      }
    }

    const tensor = new ort.Tensor('float32', data, [1, 3, inputHeight, inputWidth]);
    const output = await session.run({ [session.inputNames[0]]: tensor });
    const map = output[session.outputNames[0]];
    const mapDims = map.dims as number[];
    const mapHeight = mapDims[mapDims.length - 2];
    const mapWidth = mapDims[mapDims.length - 1];
    const probabilities = map.data as Float32Array;

    // Карта вероятностей -> маска в размере ROI.
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const mapY = Math.min(mapHeight - 1, Math.floor((y * mapHeight) / height));
      for (let x = 0; x < width; x += 1) {
        const mapX = Math.min(mapWidth - 1, Math.floor((x * mapWidth) / width));
        if (probabilities[mapY * mapWidth + mapX] >= TEXT_THRESHOLD) {
          mask[y * width + x] = 1;
        }
      }
    }

    (self as unknown as Worker).postMessage({ id, ok: true, mask }, [mask.buffer]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (self as unknown as Worker).postMessage({ id, ok: false, error: message });
  }
};

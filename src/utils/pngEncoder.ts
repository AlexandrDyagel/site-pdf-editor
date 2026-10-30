/**
 * Кодирование PNG из сырых RGBA-данных (ImageData).
 *
 * Зачем свой кодировщик: `canvas.toDataURL('image/png')` и `putImageData` теряют
 * цвет у **полностью прозрачных** пикселей — хранилище canvas предумножено на
 * альфу, и при alpha = 0 там остаются нули (чёрный). Если такая картинка попадает
 * в PDF маской, часть просмотрщиков интерполирует её без предумножения, и вокруг
 * мазка появляется чёрная кайма. Здесь пишем байты как есть: у прозрачных
 * пикселей сохраняется тон бумаги, поэтому каймы не бывает ни в одном
 * просмотрщике.
 */

/** CRC32 по таблице, как требует PNG. */
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) typeBytes[index] = type.charCodeAt(index);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

/** Сжимает байты zlib-потоком (PNG IDAT). */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    // Резерв: без сжатия PNG тоже валиден (stored-блоки deflate).
    const blockSize = 65535;
    const chunks: number[] = [0x78, 0x01];
    for (let offset = 0; offset < bytes.length; offset += blockSize) {
      const size = Math.min(blockSize, bytes.length - offset);
      const last = offset + size >= bytes.length ? 1 : 0;
      chunks.push(last, size & 0xff, (size >>> 8) & 0xff, ~size & 0xff, (~size >>> 8) & 0xff);
      for (let index = 0; index < size; index += 1) chunks.push(bytes[offset + index]);
    }
    let a = 1;
    let b = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      a = (a + bytes[index]) % 65521;
      b = (b + a) % 65521;
    }
    chunks.push((b << 16) | a);
    return new Uint8Array(chunks);
  }
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Кодирует RGBA-пиксели в PNG.
 *
 * @param data по 4 байта на пиксель (R, G, B, A), как в ImageData.data
 */
export async function encodePngRgba(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const stride = width * 4;
  // Каждая строка PNG начинается с байта фильтра; берём 0 (None) — сжатие
  // всё равно эффективно на однотонных участках.
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const compressed = await deflate(raw);

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // сжатие deflate
  ihdr[11] = 0; // фильтрация
  ihdr[12] = 0; // без интерлейса

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

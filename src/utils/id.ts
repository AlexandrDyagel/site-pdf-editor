/**
 * Генерация идентификаторов.
 */

const HEX = '0123456789abcdef';

/** Криптостойкий идентификатор с префиксом. */
export function createId(prefix = ''): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  let body = '';
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    body = cryptoObj.randomUUID().replace(/-/g, '').slice(0, 16);
  } else if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    cryptoObj.getRandomValues(bytes);
    body = Array.from(bytes, (b) => HEX[(b >> 4) & 0x0f] + HEX[b & 0x0f]).join('');
  } else {
    for (let i = 0; i < 16; i += 1) body += HEX[Math.floor(Math.random() * 16)];
  }
  return prefix ? `${prefix}_${body}` : body;
}

/** Детерминированный короткий хеш строки (для кэшей). */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Преобразование реактивных данных Vue в обычные объекты.
 *
 * Зачем: IndexedDB (structured clone) **не умеет копировать Proxy** —
 * попытка сохранить реактивный объект падает с ошибкой
 * «could not be cloned». А шаблоны штампов, объекты редактора и проекты
 * приходят из Pinia/`ref`, то есть являются Proxy.
 *
 * Функция рекурсивно «разворачивает» такие значения в простые объекты,
 * массивы и примитивы. Бинарные данные (ArrayBuffer, типизированные массивы,
 * Blob, File) возвращаются как есть — их structured clone поддерживает.
 */

/** Значения, которые копируются как есть (clone-safe). */
function isBinary(value: unknown): boolean {
  return (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    (typeof File !== 'undefined' && value instanceof File)
  );
}

/** Рекурсивное преобразование в «плоское» значение. */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (isBinary(value)) return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => toPlain(item)) as unknown as T;
  }
  if (value instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of value.entries()) result[String(key)] = toPlain(item);
    return result as unknown as T;
  }
  if (value instanceof Set) {
    return Array.from(value.values()).map((item) => toPlain(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Служебные поля Vue (например, __v_isRef) пропускаем.
    if (key.startsWith('__v_') || key === 'effect' || key === 'dep') continue;
    result[key] = toPlain(item);
  }
  return result as T;
}

/**
 * Глубокая копия через JSON — быстрый способ получить простые данные,
 * когда бинарных значений заведомо нет. Используется для штрихов и шаблонов.
 */
export function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

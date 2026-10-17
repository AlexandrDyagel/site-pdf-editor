/**
 * ============================================================================
 *  Хранилище (IndexedDB).
 * ============================================================================
 *
 *  Используется для:
 *   - библиотек штампов, печатей, подписей, рисунков и изображений;
 *   - сохранённых проектов;
 *   - пользовательских шрифтов и других бинарных ресурсов.
 *
 *  Если IndexedDB недоступен (приватный режим, запрет хранилища), сервис
 *  переключается в режим «в памяти» и сообщает об этом флагом `persistent`.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { IDB, LIBRARY_SCHEMA_VERSION } from '@/constants';
import type { LibraryItemType, LibraryRecord, LibraryItem, ProjectFile } from '@/types';
import { buildJson, parseJson } from '@/utils/encoding';
import { toPlain } from '@/utils/clone';

interface EditorDatabase extends DBSchema {
  library: {
    key: string;
    value: LibraryRecord;
    indexes: { type: string; updatedAt: string };
  };
  projects: {
    key: string;
    value: ProjectFile & { id: string; savedAt: string };
    indexes: { savedAt: string };
  };
  assets: {
    key: string;
    value: unknown;
  };
  meta: {
    key: string;
    value: unknown;
  };
}

/** Запись библиотеки для экспорта в JSON. */
export interface LibraryExport {
  schemaVersion: number;
  app: string;
  exportedAt: string;
  items: LibraryRecord[];
}

export class StorageService {
  private dbPromise: Promise<IDBPDatabase<EditorDatabase>> | null = null;
  private memory = new Map<string, unknown>();
  private memoryLibrary = new Map<string, LibraryRecord>();
  /** false, если используется резервное хранилище в памяти. */
  persistent = true;

  private async getDb(): Promise<IDBPDatabase<EditorDatabase> | null> {
    if (typeof indexedDB === 'undefined') {
      this.persistent = false;
      return null;
    }
    if (!this.dbPromise) {
      this.dbPromise = openDB<EditorDatabase>(IDB.name, IDB.version, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(IDB.stores.library)) {
            const store = db.createObjectStore(IDB.stores.library, { keyPath: 'id' });
            store.createIndex('type', 'type');
            store.createIndex('updatedAt', 'updatedAt');
          }
          if (!db.objectStoreNames.contains(IDB.stores.projects)) {
            const store = db.createObjectStore(IDB.stores.projects, { keyPath: 'id' });
            store.createIndex('savedAt', 'savedAt');
          }
          if (!db.objectStoreNames.contains(IDB.stores.assets)) {
            db.createObjectStore(IDB.stores.assets);
          }
          if (!db.objectStoreNames.contains(IDB.stores.meta)) {
            db.createObjectStore(IDB.stores.meta);
          }
        },
      }).catch(() => {
        this.persistent = false;
        return null as unknown as IDBPDatabase<EditorDatabase>;
      });
    }
    const db = await this.dbPromise;
    if (!db) this.persistent = false;
    return db ?? null;
  }

  /* ======================== Библиотека ======================== */

  /** Все элементы библиотеки (опционально — только указанного типа). */
  async libraryList(type?: LibraryItemType): Promise<LibraryRecord[]> {
    const db = await this.getDb();
    if (!db) {
      const all = Array.from(this.memoryLibrary.values());
      return type ? all.filter((item) => item.type === type) : all;
    }
    const all = type
      ? await db.getAllFromIndex(IDB.stores.library, 'type', type)
      : await db.getAll(IDB.stores.library);
    return all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** Добавление или обновление элемента библиотеки. */
  async libraryPut(record: LibraryRecord): Promise<void> {
    // toPlain обязателен: шаблоны приходят из реактивных сторов Pinia,
    // а IndexedDB не умеет копировать Proxy ("could not be cloned").
    const plain = toPlain(record);
    const db = await this.getDb();
    if (!db) {
      this.memoryLibrary.set(plain.id, plain);
      return;
    }
    await db.put(IDB.stores.library, plain);
  }

  /** Удаление элемента библиотеки. */
  async libraryDelete(id: string): Promise<void> {
    const db = await this.getDb();
    if (!db) {
      this.memoryLibrary.delete(id);
      return;
    }
    await db.delete(IDB.stores.library, id);
  }

  /** Очистка библиотеки (всей или по типу). */
  async libraryClear(type?: LibraryItemType): Promise<void> {
    const db = await this.getDb();
    if (!db) {
      if (!type) this.memoryLibrary.clear();
      else for (const [id, item] of this.memoryLibrary) if (item.type === type) this.memoryLibrary.delete(id);
      return;
    }
    if (!type) {
      await db.clear(IDB.stores.library);
      return;
    }
    const items = await db.getAllFromIndex(IDB.stores.library, 'type', type);
    const tx = db.transaction(IDB.stores.library, 'readwrite');
    await Promise.all([...items.map((item) => tx.store.delete(item.id)), tx.done]);
  }

  /** Экспорт библиотеки в JSON-строку (UTF-8). */
  async exportLibrary(types?: LibraryItemType[]): Promise<string> {
    const items = await this.libraryList();
    const filtered = types && types.length > 0 ? items.filter((i) => types.includes(i.type)) : items;
    const payload: LibraryExport = {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      app: 'pdf-editor',
      exportedAt: new Date().toISOString(),
      items: filtered,
    };
    return buildJson(payload);
  }

  /** Импорт библиотеки из JSON. Существующие элементы с тем же id обновляются. */
  async importLibrary(json: string): Promise<{ added: number; updated: number; skipped: number }> {
    const parsed = parseJson<LibraryExport | LibraryRecord[]>(json);
    const items: LibraryRecord[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.items)
        ? parsed.items
        : [];
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const existing = new Set((await this.libraryList()).map((item) => item.id));
    for (const raw of items) {
      const record = this.normalizeRecord(raw);
      if (!record) {
        skipped += 1;
        continue;
      }
      const isExisting = existing.has(record.id);
      await this.libraryPut(record);
      if (isExisting) updated += 1;
      else added += 1;
    }
    return { added, updated, skipped };
  }

  /** Приведение импортируемой записи к актуальной схеме. */
  private normalizeRecord(raw: Partial<LibraryRecord> & { type?: string }): LibraryRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const data = (raw.data ?? raw) as LibraryItem;
    const type = (raw.type ?? (data as { kind?: string }).kind ?? 'stamp') as LibraryItemType;
    if (!['stamp', 'seal', 'signature', 'drawing', 'image'].includes(type)) return null;
    const id = raw.id ?? (data as { id?: string }).id;
    if (!id) return null;
    const now = new Date().toISOString();
    return {
      id,
      type,
      name: raw.name ?? (data as { name?: string }).name ?? 'Без названия',
      createdAt: raw.createdAt ?? now,
      updatedAt: raw.updatedAt ?? now,
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      preview: raw.preview ?? (data as { preview?: string | null }).preview ?? null,
      data: { ...(data as object), id } as LibraryItem,
    };
  }

  /* ======================== Проекты ======================== */

  /** Сохранение проекта. */
  async projectSave(id: string, project: ProjectFile): Promise<void> {
    // Проект содержит объекты редактора из реактивного стора — их тоже
    // нужно предварительно превратить в обычные данные.
    const value = toPlain({ ...project, id, savedAt: project.savedAt });
    const db = await this.getDb();
    if (!db) {
      this.memory.set(`project:${id}`, value);
      return;
    }
    await db.put(IDB.stores.projects, value);
  }

  /** Список сохранённых проектов (без тяжёлых данных). */
  async projectList(): Promise<
    { id: string; fileName: string; savedAt: string; numPages: number; objects: number }[]
  > {
    const db = await this.getDb();
    const all = db ? await db.getAll(IDB.stores.projects) : (Array.from(this.memory.values()) as (ProjectFile & { id: string })[]).filter((v) => typeof (v as { id?: string }).id === 'string' && 'pages' in v);
    return all
      .map((item) => ({
        id: item.id,
        fileName: item.fileName,
        savedAt: item.savedAt,
        numPages: item.pages?.length ?? 0,
        objects: item.objects?.length ?? 0,
      }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  }

  /** Загрузка проекта по идентификатору. */
  async projectLoad(id: string): Promise<(ProjectFile & { id: string }) | null> {
    const db = await this.getDb();
    if (!db) return (this.memory.get(`project:${id}`) as ProjectFile & { id: string }) ?? null;
    return (await db.get(IDB.stores.projects, id)) ?? null;
  }

  /** Удаление проекта. */
  async projectDelete(id: string): Promise<void> {
    const db = await this.getDb();
    if (!db) {
      this.memory.delete(`project:${id}`);
      return;
    }
    await db.delete(IDB.stores.projects, id);
  }

  /* ======================== Ресурсы ======================== */

  /** Сохранение произвольного ресурса (например, пользовательского шрифта). */
  async assetPut(key: string, value: unknown): Promise<void> {
    const plain = toPlain(value);
    const db = await this.getDb();
    if (!db) {
      this.memory.set(key, plain);
      return;
    }
    await db.put(IDB.stores.assets, plain, key);
  }

  /** Чтение ресурса. */
  async assetGet<T>(key: string): Promise<T | null> {
    const db = await this.getDb();
    if (!db) return (this.memory.get(key) as T) ?? null;
    return ((await db.get(IDB.stores.assets, key)) as T) ?? null;
  }

  /** Все ресурсы с указанным префиксом ключа. */
  async assetGetAll<T>(prefix: string): Promise<T[]> {
    const db = await this.getDb();
    if (!db) {
      return Array.from(this.memory.entries())
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value as T);
    }
    const keys = await db.getAllKeys(IDB.stores.assets);
    const result: T[] = [];
    for (const key of keys) {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        const value = (await db.get(IDB.stores.assets, key)) as T;
        if (value) result.push(value);
      }
    }
    return result;
  }

  /** Удаление ресурса. */
  async assetDelete(key: string): Promise<void> {
    const db = await this.getDb();
    if (!db) {
      this.memory.delete(key);
      return;
    }
    await db.delete(IDB.stores.assets, key);
  }

  /** Оценка использования хранилища. */
  async estimate(): Promise<{ usage: number; quota: number } | null> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  }
}

/** Единственный экземпляр сервиса хранилища. */
export const storageService = new StorageService();

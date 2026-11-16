// The field app's IndexedDB store (Phase 3, docs/walkthrough/PHASE3_PLAN.md). Raw IndexedDB, no library (owner
// choice, 2026-11-15). One database per browser origin:
//   inspections  keyPath id                      — header, pinned definition, cursor, replica clock/seq, deviceId
//   ops          keyPath [inspectionId, opId]    — the device's copy of the op log (never pruned)
//   outbox       keyPath [inspectionId, opId]    — ops not yet acknowledged by the server
//   meta         keyPath key                     — device ids, last org, last sync
import type { Op } from '@/lib/sync';
import type { TemplateDefinition } from '@/lib/walkthrough/template';

export const DB_NAME = 'walkthrough';
const VERSION = 1;

export interface StoredInspection {
  id: string;
  org: string;
  title: string;
  templateVersion: number;
  definition: TemplateDefinition;
  /** Last server seq this device has pulled. */
  cursor: number;
  /** The device replica's Lamport clock and op counter, persisted with every op they stamp. */
  clock: number;
  seq: number;
  deviceId: string;
  /** The server answered 404 (unassigned or deleted): kept while it holds unsent ops, hidden otherwise. */
  gone?: boolean;
}
export interface OutboxEntry {
  inspectionId: string;
  opId: string;
}

export function openDb(name = DB_NAME, factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('inspections', { keyPath: 'id' });
      db.createObjectStore('ops', { keyPath: ['inspectionId', 'opId'] }).createIndex('byInspection', 'inspectionId');
      db.createObjectStore('outbox', { keyPath: ['inspectionId', 'opId'] }).createIndex('byInspection', 'inspectionId');
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/**
 * Run `fn` in one transaction and resolve when it commits (rejects if it aborts). `fn` must only issue requests
 * (no awaits on anything else), so the transaction stays alive; everything it writes commits or none of it does.
 */
export function inTx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => T | Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out: T;
    t.oncomplete = () => resolve(out);
    t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
    t.onerror = () => {}; // abort follows
    Promise.resolve(fn(t)).then(
      (v) => void (out = v),
      (e) => {
        try {
          t.abort();
        } catch {
          /* already finished */
        }
        reject(e);
      },
    );
  });
}

export async function readInspection(db: IDBDatabase, id: string) {
  return inTx(db, ['inspections', 'ops', 'outbox'], 'readonly', async (t) => {
    const [meta, ops, outbox] = await Promise.all([
      req(t.objectStore('inspections').get(id) as IDBRequest<StoredInspection | undefined>),
      req(t.objectStore('ops').index('byInspection').getAll(id) as IDBRequest<Op[]>),
      req(t.objectStore('outbox').index('byInspection').getAll(id) as IDBRequest<OutboxEntry[]>),
    ]);
    return meta ? { meta, ops, outbox: outbox.map((o) => o.opId) } : null;
  });
}

export const listInspections = (db: IDBDatabase) =>
  inTx(db, ['inspections'], 'readonly', (t) => req(t.objectStore('inspections').getAll() as IDBRequest<StoredInspection[]>));

export const countOutbox = (db: IDBDatabase) => inTx(db, ['outbox'], 'readonly', (t) => req(t.objectStore('outbox').count()));

export const getMeta = <T>(db: IDBDatabase, key: string) =>
  inTx(db, ['meta'], 'readonly', async (t) => (await req(t.objectStore('meta').get(key) as IDBRequest<{ key: string; value: T } | undefined>))?.value);

export const setMeta = (db: IDBDatabase, key: string, value: unknown) =>
  inTx(db, ['meta'], 'readwrite', (t) => void t.objectStore('meta').put({ key, value }));

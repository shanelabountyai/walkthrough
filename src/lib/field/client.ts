// The field app's sync client (Phase 3). The device is a Phase 1 `Replica` whose state lives in IndexedDB; the only
// server is the Phase 2 endpoint. Nothing here touches the DOM, so it runs in vitest against fake-indexeddb.
import { appendOp, applyAck, createReplica, localSet, outboxOps, pinnedTemplate, receive, type Json, type Op, type Replica } from '@/lib/sync';
import type { TemplateDefinition } from '@/lib/walkthrough/template';
import { getMeta, inTx, listInspections, readInspection, req, setMeta, type StoredInspection } from './db';

export type Reply = { status: number; body: unknown };
/** How the client reaches the server. `fetchTransport` in the browser; tests pass an in-memory server. */
export interface Transport {
  feed(org: string): Promise<Reply>;
  pull(org: string, id: string, since: number): Promise<Reply>;
  push(org: string, id: string, body: { deviceId: string; since: number; ops: Op[] }): Promise<Reply>;
}

/** A non-JSON answer (the guard redirected to /login) means the session is gone; unsent ops stay in the outbox. */
async function call(url: string, init?: RequestInit): Promise<Reply> {
  const res = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'follow' });
  const json = /application\/json/.test(res.headers.get('content-type') ?? '');
  if (!json) return { status: res.redirected || res.status === 200 ? 401 : res.status, body: null };
  return { status: res.status, body: await res.json() };
}
export const fetchTransport: Transport = {
  feed: (org) => call(`/o/${encodeURIComponent(org)}/inspections/feed`),
  pull: (org, id, since) => call(`/o/${encodeURIComponent(org)}/inspections/${id}/sync?since=${since}`),
  push: (org, id, body) => call(`/o/${encodeURIComponent(org)}/inspections/${id}/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
};

export type SyncOutcome = { ok: true; acked: number; received: number } | { ok: false; status: number; error: string };

// Writes to one inspection run one at a time in this tab, so two quick answers never stamp the same seq.
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(key, next.catch(() => {}));
  return next;
}

/** The device replica for a stored inspection: log, outbox, clock, seq and template version from IndexedDB. */
export async function loadReplica(db: IDBDatabase, id: string): Promise<{ meta: StoredInspection; replica: Replica } | null> {
  const got = await readInspection(db, id);
  if (!got) return null;
  const r = createReplica(got.meta.deviceId, id, got.meta.templateVersion);
  r.clock = got.meta.clock;
  r.seq = got.meta.seq;
  for (const op of got.ops) r.log = appendOp(r.log, op);
  r.outbox = new Set(got.outbox);
  return { meta: got.meta, replica: r };
}

/**
 * Answer one field. The op, its outbox entry and the replica's new clock and seq are written in one transaction
 * (`add`, so an opId that already exists aborts instead of overwriting): an answer is either durable and queued, or
 * it never happened. Returns the op.
 */
export function answer(db: IDBDatabase, id: string, path: string, value: Json): Promise<Op> {
  return serial(id, async () => {
    const got = await loadReplica(db, id);
    if (!got) throw new Error('inspection is not on this device');
    const op = localSet(got.replica, path, value);
    await inTx(db, ['ops', 'outbox', 'inspections'], 'readwrite', (t) => {
      t.objectStore('ops').add(op);
      t.objectStore('outbox').add({ inspectionId: id, opId: op.opId });
      t.objectStore('inspections').put({ ...got.meta, clock: got.replica.clock, seq: got.replica.seq });
    });
    return op;
  });
}

/** Store what the server sent and drop exactly the acked ops from the outbox, in one transaction. */
async function apply(db: IDBDatabase, got: { meta: StoredInspection; replica: Replica }, ops: Op[], acked: string[], cursor: number, extra: Partial<StoredInspection> = {}) {
  const r = got.replica;
  const before = new Set(r.log.keys());
  receive(r, ops); // throws LogIntegrityError on a changed op: nothing is written then
  applyAck(r, acked);
  const fresh = ops.filter((o) => !before.has(o.opId));
  await inTx(db, ['ops', 'outbox', 'inspections'], 'readwrite', (t) => {
    for (const op of new Map(fresh.map((o) => [o.opId, o])).values()) t.objectStore('ops').put(op);
    for (const opId of acked) t.objectStore('outbox').delete([r.inspectionId, opId]);
    t.objectStore('inspections').put({ ...got.meta, ...extra, cursor: Math.max(got.meta.cursor, cursor), clock: r.clock, templateVersion: pinnedTemplate(r.log)?.templateVersion ?? got.meta.templateVersion });
  });
  return fresh.length;
}

const errorOf = (r: Reply) => (r.body && typeof r.body === 'object' && 'error' in r.body ? String((r.body as { error: unknown }).error) : r.status === 401 ? 'signed-out' : `http-${r.status}`);

/** Push this inspection's outbox (with the cursor) and take what the server returns. Only acked ops leave the outbox. */
export function syncInspection(db: IDBDatabase, t: Transport, id: string): Promise<SyncOutcome> {
  return serial(id, async () => {
    const got = await loadReplica(db, id);
    if (!got) return { ok: false, status: 0, error: 'missing' };
    let r: Reply;
    try {
      r = await t.push(got.meta.org, id, { deviceId: got.meta.deviceId, since: got.meta.cursor, ops: outboxOps(got.replica) });
    } catch {
      return { ok: false, status: 0, error: 'network' };
    }
    if (r.status === 404) {
      await inTx(db, ['inspections'], 'readwrite', (tx) => void tx.objectStore('inspections').put({ ...got.meta, gone: true }));
      return { ok: false, status: 404, error: 'not_found' };
    }
    if (r.status !== 200) return { ok: false, status: r.status, error: errorOf(r) };
    const body = r.body as { acked: string[]; ops: Op[]; cursor: number };
    const received = await apply(db, got, body.ops, body.acked, body.cursor, { gone: false });
    return { ok: true, acked: body.acked.length, received };
  });
}

/** This browser's device id for one user in one org (D-20 binds it to that user on first push). */
async function deviceId(db: IDBDatabase, org: string, userId: string): Promise<string> {
  const key = `device:${org}:${userId}`;
  const known = await getMeta<string>(db, key);
  if (known) return known;
  const id = crypto.randomUUID();
  await setMeta(db, key, id);
  return id;
}

/** First download of an inspection: header, pinned definition and every op so far. */
export async function download(db: IDBDatabase, t: Transport, org: string, userId: string, id: string): Promise<SyncOutcome> {
  const r = await t.pull(org, id, 0).catch(() => null);
  if (!r) return { ok: false, status: 0, error: 'network' };
  if (r.status !== 200) return { ok: false, status: r.status, error: errorOf(r) };
  const body = r.body as { inspection: { title: string; templateVersion: number }; template: { version: number; definition: TemplateDefinition }; ops: Op[]; cursor: number };
  const meta: StoredInspection = {
    id, org, title: body.inspection.title, templateVersion: body.template.version, definition: body.template.definition, cursor: 0, clock: 0, seq: 0, deviceId: await deviceId(db, org, userId),
  };
  return serial(id, async () => {
    const existing = await loadReplica(db, id);
    const got = existing ?? { meta, replica: createReplica(meta.deviceId, id, meta.templateVersion) };
    const received = await apply(db, got, body.ops, [], body.cursor, { title: meta.title, definition: meta.definition, gone: false });
    return { ok: true, acked: 0, received };
  });
}

export type SyncAllResult = { ok: boolean; error?: string; inspections: number; acked: number; received: number };

/** Refresh the list for `org`, download anything new, then sync every inspection of that org on this device. */
export async function syncAll(db: IDBDatabase, t: Transport, org: string): Promise<SyncAllResult> {
  const out: SyncAllResult = { ok: true, inspections: 0, acked: 0, received: 0 };
  const fail = (e: string) => ((out.ok = false), (out.error ??= e));
  const feed = await t.feed(org).catch(() => null);
  if (!feed) return { ...out, ok: false, error: 'network' };
  if (feed.status !== 200) return { ...out, ok: false, error: errorOf(feed) };
  const { userId, inspections } = feed.body as { userId: string; inspections: { id: string }[] };
  await setMeta(db, 'lastOrg', org);
  const stored = new Set((await listInspections(db)).map((i) => i.id));
  for (const i of inspections) {
    if (stored.has(i.id)) continue;
    const r = await download(db, t, org, userId, i.id);
    if (!r.ok) fail(r.error);
  }
  for (const i of (await listInspections(db)).filter((x) => x.org === org)) {
    const r = await syncInspection(db, t, i.id);
    if (r.ok) {
      out.acked += r.acked;
      out.received += r.received;
    } else if (r.error !== 'not_found') fail(r.error);
  }
  out.inspections = (await listInspections(db)).filter((x) => x.org === org && !x.gone).length;
  if (out.ok) await setMeta(db, `lastSync:${org}`, new Date().toISOString());
  return out;
}

export { req };

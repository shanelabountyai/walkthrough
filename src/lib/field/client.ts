// The field app's sync client (Phase 3). The device is a Phase 1 `Replica` whose state lives in IndexedDB; the only
// server is the Phase 2 endpoint. Nothing here touches the DOM, so it runs in vitest against fake-indexeddb.
import { appendOp, applyAck, createReplica, localSet, materialize, outboxOps, pinnedTemplate, receive, type Json, type Op, type Replica, type SetOp } from '@/lib/sync';
import { CHUNK_BYTES, hashOf, isUploadType, MAX_BLOB_BYTES, withoutPhoto, withPhoto } from '@/lib/walkthrough/blobs';
import type { TemplateDefinition } from '@/lib/walkthrough/template';
import { dropUpload, getBlob, getMeta, inTx, listInspections, readInspection, req, setMeta, uploadsFor, type StoredInspection } from './db';

export type Reply = { status: number; body: unknown };
/** How the client reaches the server. `fetchTransport` in the browser; tests pass an in-memory server. */
export interface Transport {
  feed(org: string): Promise<Reply>;
  pull(org: string, id: string, since: number): Promise<Reply>;
  push(org: string, id: string, body: { deviceId: string; since: number; ops: Op[] }): Promise<Reply>;
  /** Phase 4: how much of a blob the server holds (`{state, received}`). */
  blobStatus(org: string, id: string, hash: string): Promise<Reply>;
  /** Phase 4: one upload chunk at `offset` of a `length`-byte blob. */
  blobChunk(org: string, id: string, hash: string, c: { offset: number; length: number; type: string; bytes: Uint8Array }): Promise<Reply>;
  /** Phase 4: complete the inspection and generate its report. */
  report(org: string, id: string): Promise<Reply>;
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
  blobStatus: (org, id, hash) => call(`/o/${encodeURIComponent(org)}/inspections/${id}/blobs/${hash}?status`),
  blobChunk: (org, id, hash, c) =>
    call(`/o/${encodeURIComponent(org)}/inspections/${id}/blobs/${hash}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-upload-offset': String(c.offset), 'x-upload-length': String(c.length), 'x-blob-type': c.type },
      body: c.bytes as BodyInit,
    }),
  report: (org, id) => call(`/o/${encodeURIComponent(org)}/inspections/${id}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
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
export function answer(db: IDBDatabase, id: string, path: string, value: Json): Promise<SetOp> {
  return serial(id, async () => {
    const got = await loadReplica(db, id);
    if (!got) throw new Error('inspection is not on this device');
    return answerTx(db, got, path, value);
  });
}

/**
 * A photo or signature answer (Phase 4). The bytes, their upload entry, the op naming their hash, its outbox entry and
 * the replica's clock and seq are written in **one** transaction: the photo is on the device and queued, or nothing
 * happened (WT-01). `value` builds the new answer from the field's current merged value and the new hash.
 */
function answerWithBlob(db: IDBDatabase, id: string, path: string, blob: { bytes: Uint8Array; type: string }, value: (current: Json, hash: string) => Json): Promise<{ op: SetOp; hash: string }> {
  if (!isUploadType(blob.type)) return Promise.reject(new Error(`cannot store ${blob.type}: JPEG, PNG or WebP only`));
  if (!blob.bytes.length || blob.bytes.length > MAX_BLOB_BYTES) return Promise.reject(new Error('the image is empty or too large'));
  return hashOf(blob.bytes).then((hash) =>
    serial(id, async () => {
      const got = await loadReplica(db, id);
      if (!got) throw new Error('inspection is not on this device');
      const current = materialize(got.replica.log).fields[path]?.value ?? null;
      const op = localSet(got.replica, path, value(current, hash));
      await inTx(db, ['ops', 'outbox', 'inspections', 'blobs', 'uploads'], 'readwrite', (t) => {
        t.objectStore('blobs').put({ hash, type: blob.type, size: blob.bytes.length, data: blob.bytes });
        t.objectStore('uploads').put({ inspectionId: id, hash, type: blob.type, size: blob.bytes.length });
        t.objectStore('ops').add(op);
        t.objectStore('outbox').add({ inspectionId: id, opId: op.opId });
        t.objectStore('inspections').put({ ...got.meta, clock: got.replica.clock, seq: got.replica.seq });
      });
      return { op, hash };
    }),
  );
}

/** Add a photo to a photo item: its answer is the list of hashes, in capture order. */
export const attachPhoto = (db: IDBDatabase, id: string, path: string, bytes: Uint8Array, type: string) => answerWithBlob(db, id, path, { bytes, type }, withPhoto);

/** Capture a signature: its answer is the image's hash. A new signature replaces the old one. */
export const sign = (db: IDBDatabase, id: string, path: string, bytes: Uint8Array, type: string) => answerWithBlob(db, id, path, { bytes, type }, (_, hash) => hash);

/** Remove one photo from a photo item (one op; the earlier answer stays in the log, WT-01). */
export function removePhoto(db: IDBDatabase, id: string, path: string, hash: string): Promise<SetOp> {
  return serial(id, async () => {
    const got = await loadReplica(db, id);
    if (!got) throw new Error('inspection is not on this device');
    return answerTx(db, got, path, withoutPhoto(materialize(got.replica.log).fields[path]?.value ?? null, hash));
  });
}

async function answerTx(db: IDBDatabase, got: { meta: StoredInspection; replica: Replica }, path: string, value: Json) {
  const op = localSet(got.replica, path, value);
  await inTx(db, ['ops', 'outbox', 'inspections'], 'readwrite', (t) => {
    t.objectStore('ops').add(op);
    t.objectStore('outbox').add({ inspectionId: got.meta.id, opId: op.opId });
    t.objectStore('inspections').put({ ...got.meta, clock: got.replica.clock, seq: got.replica.seq });
  });
  return op;
}

export type UploadOutcome = { ok: true; uploaded: number; pending: number } | { ok: false; error: string; uploaded: number; pending: number };

/**
 * Send this inspection's pending blobs (Phase 4). Ops go first (`syncInspection`), so the server's log already names
 * each hash. Per blob: ask how much the server holds, send the rest in CHUNK_BYTES chunks from there (resumable), and
 * drop the upload entry only when the server says complete. A 409 carries the server's count; continue from it.
 */
export function uploadBlobs(db: IDBDatabase, t: Transport, org: string, id: string): Promise<UploadOutcome> {
  return serial(`upload:${id}`, async () => {
    let uploaded = 0;
    let error: string | null = null;
    const entries = await uploadsFor(db, id);
    for (const u of entries) {
      const blob = await getBlob(db, u.hash);
      if (!blob) {
        error ??= 'blob-missing';
        continue;
      }
      try {
        const st = await t.blobStatus(org, id, u.hash);
        if (st.status !== 200) {
          error ??= errorOf(st);
          continue;
        }
        let state = (st.body as { state: string }).state;
        let offset = state === 'complete' ? u.size : (st.body as { received: number }).received;
        for (let guard = 0; state !== 'complete' && guard < 4 + 2 * Math.ceil(u.size / CHUNK_BYTES); guard++) {
          const bytes = blob.data.subarray(offset, Math.min(offset + CHUNK_BYTES, u.size));
          const r = await t.blobChunk(org, id, u.hash, { offset, length: u.size, type: u.type, bytes });
          const body = (r.body ?? {}) as { state?: string; received?: number };
          if (r.status === 200) {
            state = body.state ?? 'partial';
            offset = body.received ?? offset + bytes.length;
          } else if (r.status === 409 && typeof body.received === 'number') offset = body.received; // resume where the server is
          else {
            error ??= errorOf(r);
            break;
          }
        }
        if (state === 'complete') {
          await dropUpload(db, id, u.hash);
          uploaded++;
        } else error ??= 'upload-incomplete';
      } catch {
        error ??= 'network';
        break; // the connection is gone: the rest wait for the next sync
      }
    }
    const pending = (await uploadsFor(db, id)).length;
    return error ? { ok: false, error, uploaded, pending } : { ok: true, uploaded, pending };
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
  const body = r.body as { inspection: { title: string; templateVersion: number; truckroll?: string }; template: { version: number; definition: TemplateDefinition }; ops: Op[]; cursor: number };
  const meta: StoredInspection = {
    id, org, title: body.inspection.title, templateVersion: body.template.version, definition: body.template.definition, cursor: 0, clock: 0, seq: 0, deviceId: await deviceId(db, org, userId),
  };
  return serial(id, async () => {
    const existing = await loadReplica(db, id);
    const got = existing ?? { meta, replica: createReplica(meta.deviceId, id, meta.templateVersion) };
    const received = await apply(db, got, body.ops, [], body.cursor, { title: meta.title, definition: meta.definition, gone: false, ...(body.inspection.truckroll ? { truckroll: body.inspection.truckroll } : {}) });
    return { ok: true, acked: 0, received };
  });
}

export type SyncAllResult = { ok: boolean; error?: string; inspections: number; acked: number; received: number; uploaded: number };

/** Refresh the list for `org`, download anything new, then sync every inspection of that org on this device. */
export async function syncAll(db: IDBDatabase, t: Transport, org: string): Promise<SyncAllResult> {
  const out: SyncAllResult = { ok: true, inspections: 0, acked: 0, received: 0, uploaded: 0 };
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
      const u = await uploadBlobs(db, t, org, i.id); // ops first, so the server's log names every hash
      out.uploaded += u.uploaded;
      if (!u.ok) fail(u.error);
    } else if (r.error !== 'not_found') fail(r.error);
  }
  out.inspections = (await listInspections(db)).filter((x) => x.org === org && !x.gone).length;
  if (out.ok) await setMeta(db, `lastSync:${org}`, new Date().toISOString());
  return out;
}

export { req };

export type FinishOutcome = { ok: true; number: number; url: string } | { ok: false; error: string; reasons?: string[] };

/** Sync this inspection (ops, then blobs) and ask the server to complete it and generate the report. Online only. */
export async function finish(db: IDBDatabase, t: Transport, id: string): Promise<FinishOutcome> {
  const got = await loadReplica(db, id);
  if (!got) return { ok: false, error: 'missing' };
  const s = await syncInspection(db, t, id);
  if (!s.ok) return { ok: false, error: s.error };
  const u = await uploadBlobs(db, t, got.meta.org, id);
  if (!u.ok) return { ok: false, error: u.error };
  const r = await t.report(got.meta.org, id).catch(() => null);
  if (!r) return { ok: false, error: 'network' };
  const body = (r.body ?? {}) as { number?: number; url?: string; notReady?: { message: string }[] };
  if (r.status === 200 && body.url) return { ok: true, number: body.number ?? 1, url: body.url };
  return { ok: false, error: errorOf(r), ...(body.notReady ? { reasons: body.notReady.map((x) => x.message) } : {}) };
}

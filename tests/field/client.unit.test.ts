// B1/B2: the field client's IndexedDB store and sync (Phase 3), against fake-indexeddb and an in-memory server that
// runs the same engine rules as the Phase 2 endpoint (serverAccept).
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInspection, createReplica, materialize, serverAccept, SERVER_ID, type Op } from '@/lib/sync';
import { answer, attachPhoto, download, finish, loadReplica, removePhoto, sign, syncAll, syncInspection, uploadBlobs, type Transport } from '@/lib/field/client';
import { countOutbox, countUploads, getBlob, listInspections, openDb } from '@/lib/field/db';
import { CHUNK_BYTES, hashOf, refsIn } from '@/lib/walkthrough/blobs';
import { EXAMPLE_DEFINITION } from '@/lib/walkthrough/template';

const ID = '00000000-0000-4000-8000-000000000029';
type Fault = null | 'network' | 'lose-response' | { status: number; body: unknown };

function memServer() {
  const server = createReplica(SERVER_ID, ID);
  const order: Op[] = [createInspection(server, 't1', 1)];
  const s = {
    order,
    fault: null as Fault,
    pushes: 0,
    // Phase 4: the server's blobs (bytes so far) and a fault for the next chunk call.
    blobs: new Map<string, { bytes: Uint8Array; length: number; complete: boolean }>(),
    chunkFault: null as null | 'network',
    chunks: [] as { hash: string; offset: number; size: number }[],
    statusCalls: [] as { hash: string; opsOnServer: number }[],
    report: { status: 200, body: { number: 1, url: `/o/acme/inspections/${ID}/report?n=1` } } as { status: number; body: unknown },
    reportCalls: 0,
  };
  // Like the real endpoint: a blob is reachable only when a set op in the server's log names its hash.
  const named = (hash: string) => [...server.log.values()].some((o) => o.kind === 'set' && refsIn(o.value).includes(hash));
  const transport: Transport = {
    feed: async () => ({ status: 200, body: { userId: 'u1', inspections: [{ id: ID }] } }),
    pull: async (_o, _i, since) => ({
      status: 200,
      body: { inspection: { title: 'Smith house', templateVersion: 1 }, template: { version: 1, definition: EXAMPLE_DEFINITION }, ops: order.slice(since), cursor: order.length },
    }),
    push: async (_o, _i, body) => {
      s.pushes++;
      const fault = s.fault;
      s.fault = null;
      if (fault === 'network') throw new TypeError('Failed to fetch');
      if (fault && typeof fault === 'object') return fault;
      const known = new Set(server.log.keys());
      const acked = serverAccept(server, body.ops);
      for (const op of body.ops) if (!known.has(op.opId) && !order.some((o) => o.opId === op.opId)) order.push(op);
      if (fault === 'lose-response') throw new TypeError('connection reset'); // stored, but the device never hears
      return { status: 200, body: { acked, ops: order.slice(body.since), cursor: order.length } };
    },
    blobStatus: async (_o, _i, hash) => {
      s.statusCalls.push({ hash, opsOnServer: server.log.size });
      if (!named(hash)) return { status: 404, body: { error: 'not_found' } };
      const b = s.blobs.get(hash);
      return { status: 200, body: { state: b?.complete ? 'complete' : b ? 'partial' : 'missing', received: b ? b.bytes.length : 0 } };
    },
    blobChunk: async (_o, _i, hash, c) => {
      if (s.chunkFault === 'network') {
        s.chunkFault = null;
        throw new TypeError('Failed to fetch');
      }
      if (!named(hash)) return { status: 404, body: { error: 'not_found' } };
      const b = s.blobs.get(hash) ?? { bytes: new Uint8Array(), length: c.length, complete: false };
      s.blobs.set(hash, b);
      if (b.complete) return { status: 200, body: { state: 'complete', received: b.length } };
      if (c.offset !== b.bytes.length) return { status: 409, body: { error: 'offset', received: b.bytes.length } };
      s.chunks.push({ hash, offset: c.offset, size: c.bytes.length });
      const next = new Uint8Array(b.bytes.length + c.bytes.length);
      next.set(b.bytes);
      next.set(c.bytes, b.bytes.length);
      b.bytes = next;
      if (b.bytes.length === c.length) {
        if ((await hashOf(b.bytes)) !== hash) {
          s.blobs.delete(hash);
          return { status: 422, body: { error: 'hash-mismatch', received: 0 } };
        }
        b.complete = true;
      }
      return { status: 200, body: { state: b.complete ? 'complete' : 'partial', received: b.bytes.length } };
    },
    report: async () => {
      s.reportCalls++;
      return s.report;
    },
  };
  return { s, transport, server };
}

const fresh = () => openDb(`wt-${randomUUID()}`);

describe('field client store (B1)', () => {
  it('ops, outbox, clock and seq survive closing and reopening the database; a reopen never reuses an opId', async () => {
    const name = `wt-${randomUUID()}`;
    const { transport } = memServer();
    let db = await openDb(name);
    expect((await download(db, transport, 'acme', 'u1', ID)).ok).toBe(true);
    const a = await answer(db, ID, 'items.roof-condition', 'pass');
    const b = await answer(db, ID, 'items.supply-temp', 61);
    db.close();
    db = await openDb(name);
    const got = (await loadReplica(db, ID))!;
    expect([...got.replica.log.keys()].sort()).toEqual(['server:1', a.opId, b.opId].sort());
    expect([...got.replica.outbox].sort()).toEqual([a.opId, b.opId].sort());
    expect(got.replica.seq).toBe(2);
    expect(got.replica.clock).toBe(b.lamport);
    const c = await answer(db, ID, 'items.roof-condition', 'fail');
    expect(c.opId).toBe(`${got.meta.deviceId}:3`);
    expect(c.prev).toEqual([a.opId]); // it saw its own earlier answer: a clean overwrite
  });

  it('answers fired together are serialized: distinct opIds, gapless seq, all queued', async () => {
    const db = await fresh();
    await download(db, memServer().transport, 'acme', 'u1', ID);
    const ops = await Promise.all([1, 2, 3, 4, 5].map((n) => answer(db, ID, `items.n${n}`, n)));
    expect(new Set(ops.map((o) => o.opId)).size).toBe(5);
    expect((await loadReplica(db, ID))!.replica.seq).toBe(5);
    expect(await countOutbox(db)).toBe(5);
  });

  it('cannot answer before the inspection (and its server pin) is on the device', async () => {
    const db = await fresh();
    await expect(answer(db, ID, 'items.x', 1)).rejects.toThrow('not on this device');
  });
});

describe('field client sync (B2)', () => {
  async function setup() {
    const srv = memServer();
    const db = await fresh();
    await download(db, srv.transport, 'acme', 'u1', ID);
    return { ...srv, db };
  }

  it('drops exactly the acked ops from the outbox, and the server holds them', async () => {
    const { db, transport, server } = await setup();
    const a = await answer(db, ID, 'items.roof-condition', 'pass');
    const r = await syncInspection(db, transport, ID);
    expect(r).toEqual({ ok: true, acked: 1, received: 0 });
    expect(await countOutbox(db)).toBe(0);
    expect(server.log.get(a.opId)).toEqual(a);
  });

  it.each([
    ['a network failure', 'network' as Fault, 'network'],
    ['a refused batch', { status: 409, body: { error: 'integrity' } } as Fault, 'integrity'],
    ['a signed-out session', { status: 401, body: null } as Fault, 'signed-out'],
  ])('keeps the outbox on %s', async (_, fault, error) => {
    const { db, transport, s } = await setup();
    await answer(db, ID, 'items.roof-condition', 'pass');
    s.fault = fault;
    expect(await syncInspection(db, transport, ID)).toMatchObject({ ok: false, error });
    expect(await countOutbox(db)).toBe(1);
    expect((await syncInspection(db, transport, ID)).ok).toBe(true); // and the next sync delivers it
    expect(await countOutbox(db)).toBe(0);
  });

  it('a lost response (stored, never heard) is retried idempotently: acked then, stored once', async () => {
    const { db, transport, s } = await setup();
    const a = await answer(db, ID, 'items.roof-condition', 'pass');
    s.fault = 'lose-response';
    expect((await syncInspection(db, transport, ID)).ok).toBe(false);
    expect(await countOutbox(db)).toBe(1);
    expect(s.order.filter((o) => o.opId === a.opId)).toHaveLength(1);
    expect(await syncInspection(db, transport, ID)).toMatchObject({ ok: true, acked: 1 });
    expect(await countOutbox(db)).toBe(0);
    expect(s.order.filter((o) => o.opId === a.opId)).toHaveLength(1);
  });

  it('a 404 marks the inspection gone but keeps its unsent answers', async () => {
    const { db, transport, s } = await setup();
    await answer(db, ID, 'items.roof-condition', 'pass');
    s.fault = { status: 404, body: { error: 'not_found' } };
    expect(await syncInspection(db, transport, ID)).toMatchObject({ ok: false, error: 'not_found' });
    expect((await listInspections(db))[0]!.gone).toBe(true);
    expect(await countOutbox(db)).toBe(1);
  });

  it('two devices converge through the server, and a concurrent edit shows as a conflict on both (WT-02/03)', async () => {
    const srv = memServer();
    const [d1, d2] = [await fresh(), await fresh()];
    for (const d of [d1, d2]) expect((await syncAll(d, srv.transport, 'acme')).ok).toBe(true);
    await answer(d1, ID, 'items.roof-condition', 'pass');
    await answer(d2, ID, 'items.roof-condition', 'fail');
    for (const d of [d1, d2, d1]) await syncAll(d, srv.transport, 'acme');
    const [s1, s2] = await Promise.all([d1, d2].map(async (d) => materialize((await loadReplica(d, ID))!.replica.log)));
    expect(s1).toEqual(s2);
    expect(s1!.conflicts).toEqual(['items.roof-condition']);
    expect(s1!.fields['items.roof-condition']!.heads.map((h) => h.value).sort()).toEqual(['fail', 'pass']);
  });
});

// Phase 4 (C5, docs/walkthrough/PHASE4_PLAN.md): photos and signatures on the device, and their resumable upload.
/** Fake image bytes of `n` bytes with a JPEG header (the in-memory server checks hashes, not image formats). */
function image(n: number, seed = 1) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7) % 251;
  b.set([0xff, 0xd8, 0xff]);
  return b;
}

describe('photos and signatures on the device (C5)', () => {
  async function setup() {
    const srv = memServer();
    const name = `wt-${randomUUID()}`;
    const db = await openDb(name);
    await download(db, srv.transport, 'acme', 'u1', ID);
    return { ...srv, db, name };
  }

  it('a photo is stored with its op, outbox and upload entry in one go, and survives a reopen', async () => {
    const { db, name } = await setup();
    const bytes = image(1000);
    const { op, hash } = await attachPhoto(db, ID, 'items.roof-photo', bytes, 'image/jpeg');
    expect(op.value).toEqual([hash]);
    const second = await attachPhoto(db, ID, 'items.roof-photo', image(500, 2), 'image/jpeg');
    expect(second.op.value).toEqual([hash, second.hash]); // capture order
    expect(second.op.prev).toEqual([op.opId]);
    const sig = await sign(db, ID, 'items.customer-signature', image(300, 3), 'image/png');
    expect(sig.op.value).toBe(sig.hash);
    db.close();
    const again = await openDb(name);
    expect(await countOutbox(again)).toBe(3);
    expect(await countUploads(again)).toBe(3);
    expect([...(await getBlob(again, hash))!.data]).toEqual([...bytes]);
    const state = materialize((await loadReplica(again, ID))!.replica.log);
    expect(state.fields['items.roof-photo']!.value).toEqual([hash, second.hash]);
    expect((await removePhoto(again, ID, 'items.roof-photo', hash)).value).toEqual([second.hash]);
  });

  it('refuses anything but JPEG, PNG or WebP, and an empty image, writing nothing', async () => {
    const { db } = await setup();
    await expect(attachPhoto(db, ID, 'items.roof-photo', image(10), 'text/html')).rejects.toThrow('JPEG, PNG or WebP');
    await expect(attachPhoto(db, ID, 'items.roof-photo', new Uint8Array(), 'image/jpeg')).rejects.toThrow('empty');
    expect(await countOutbox(db)).toBe(0);
    expect(await countUploads(db)).toBe(0);
  });

  it('sync pushes the ops first, then uploads each blob in chunks; the server ends with the same bytes', async () => {
    const { db, transport, s } = await setup();
    const bytes = image(CHUNK_BYTES * 2 + 1234);
    const { hash } = await attachPhoto(db, ID, 'items.roof-photo', bytes, 'image/jpeg');
    const r = await syncAll(db, transport, 'acme');
    expect(r).toMatchObject({ ok: true, acked: 1, uploaded: 1 });
    expect(s.statusCalls[0]).toEqual({ hash, opsOnServer: 2 }); // the op naming the hash was already on the server
    expect(s.chunks.map((c) => [c.offset, c.size])).toEqual([[0, CHUNK_BYTES], [CHUNK_BYTES, CHUNK_BYTES], [2 * CHUNK_BYTES, 1234]]);
    expect(Buffer.from(s.blobs.get(hash)!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(await countUploads(db)).toBe(0);
    expect(await getBlob(db, hash)).toBeDefined(); // kept on the device for offline viewing
  });

  it('an interrupted upload keeps its entry and resumes from what the server holds, never re-sending a chunk', async () => {
    const { db, transport, s } = await setup();
    const bytes = image(CHUNK_BYTES * 3);
    const { hash } = await attachPhoto(db, ID, 'items.roof-photo', bytes, 'image/jpeg');
    expect((await syncInspection(db, transport, ID)).ok).toBe(true);
    // the first chunk lands, then the connection drops
    const first = await transport.blobChunk('acme', ID, hash, { offset: 0, length: bytes.length, type: 'image/jpeg', bytes: bytes.subarray(0, CHUNK_BYTES) });
    expect(first.status).toBe(200);
    s.chunkFault = 'network';
    expect(await uploadBlobs(db, transport, 'acme', ID)).toMatchObject({ ok: false, error: 'network', pending: 1 });
    expect(await countUploads(db)).toBe(1);
    expect(await uploadBlobs(db, transport, 'acme', ID)).toEqual({ ok: true, uploaded: 1, pending: 0 });
    expect(s.chunks.map((c) => c.offset)).toEqual([0, CHUNK_BYTES, 2 * CHUNK_BYTES]); // each byte sent once
    expect(Buffer.from(s.blobs.get(hash)!.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it('a blob the server already holds (dedupe) is not sent again', async () => {
    const { db, transport, s } = await setup();
    const bytes = image(700);
    const hash = await hashOf(bytes);
    s.blobs.set(hash, { bytes, length: bytes.length, complete: true });
    await attachPhoto(db, ID, 'items.roof-photo', bytes, 'image/jpeg');
    expect(await syncAll(db, transport, 'acme')).toMatchObject({ ok: true, uploaded: 1 });
    expect(s.chunks).toEqual([]);
    expect(await countUploads(db)).toBe(0);
  });

  it('finish syncs, uploads, then asks for the report; a not-ready answer comes back with its reasons', async () => {
    const { db, transport, s } = await setup();
    await sign(db, ID, 'items.customer-signature', image(400), 'image/png');
    s.report = { status: 409, body: { error: 'not_ready', notReady: [{ message: 'Roof condition is required and not answered' }] } };
    expect(await finish(db, transport, ID)).toEqual({ ok: false, error: 'not_ready', reasons: ['Roof condition is required and not answered'] });
    expect(await countUploads(db)).toBe(0); // the signature went up before the report was asked for
    s.report = { status: 200, body: { number: 1, url: '/o/acme/inspections/x/report?n=1' } };
    expect(await finish(db, transport, ID)).toEqual({ ok: true, number: 1, url: '/o/acme/inspections/x/report?n=1' });
    expect(s.reportCalls).toBe(2);
  });
});

// Review fix 2026-11-16 (must-fix 1, D-39): adding or removing a photo while the photo item is in conflict builds the
// new list from every competing value, never from the displayed one alone — no photo is silently dropped (D-36, WT-03).
describe('photos added or removed during a conflict (D-39)', () => {
  async function conflicted() {
    const srv = memServer();
    const [a, b] = [await fresh(), await fresh()];
    for (const d of [a, b]) expect((await syncAll(d, srv.transport, 'acme')).ok).toBe(true);
    const pa = await attachPhoto(a, ID, 'items.roof-photo', image(400, 11), 'image/jpeg');
    const pb = await attachPhoto(b, ID, 'items.roof-photo', image(400, 12), 'image/jpeg');
    for (const d of [a, b, a]) expect((await syncAll(d, srv.transport, 'acme')).ok).toBe(true);
    const state = materialize((await loadReplica(b, ID))!.replica.log);
    expect(state.conflicts).toEqual(['items.roof-photo']);
    return { ...srv, a, b, pa, pb };
  }

  it('two devices each add a photo, both sync, B adds a third: all three are kept and the conflict is resolved', async () => {
    const { a, b, pa, pb, transport } = await conflicted();
    const third = await attachPhoto(b, ID, 'items.roof-photo', image(400, 13), 'image/jpeg');
    const value = third.op.value as string[];
    expect(value).toHaveLength(3);
    expect(new Set(value)).toEqual(new Set([pa.hash, pb.hash, third.hash]));
    expect(value[2]).toBe(third.hash); // the new photo goes last
    for (const d of [b, a]) expect((await syncAll(d, transport, 'acme')).ok).toBe(true);
    for (const d of [a, b]) {
      const s = materialize((await loadReplica(d, ID))!.replica.log);
      expect(s.conflicts).toEqual([]);
      expect(new Set(s.fields['items.roof-photo']!.value as string[])).toEqual(new Set([pa.hash, pb.hash, third.hash]));
    }
  });

  it('removing one photo during the conflict keeps every other competing photo', async () => {
    const { a, b, pa, pb, transport } = await conflicted();
    const op = await removePhoto(b, ID, 'items.roof-photo', pb.hash);
    expect(op.value).toEqual([pa.hash]); // A's photo survives, though B was showing its own list
    const op2 = await removePhoto(a, ID, 'items.roof-photo', pa.hash);
    expect(op2.value).toEqual([pb.hash]);
    for (const d of [b, a, b]) await syncAll(d, transport, 'acme');
  });

  it('the union is stable: competing lists merge oldest head first, each in its own order, without duplicates', async () => {
    const { a, b, pa, pb } = await conflicted();
    const [x, y] = [await attachPhoto(a, ID, 'items.roof-photo', image(300, 21), 'image/jpeg'), await attachPhoto(b, ID, 'items.roof-photo', image(300, 22), 'image/jpeg')];
    // each device saw both heads, so both lists hold pa and pb in the same order, then their own new photo
    expect((x.op.value as string[]).slice(0, 2)).toEqual((y.op.value as string[]).slice(0, 2));
    expect(new Set((x.op.value as string[]).slice(0, 2))).toEqual(new Set([pa.hash, pb.hash]));
  });
});

describe('IndexedDB upgrade (C5)', () => {
  it('a version 1 database (Phase 3) opens as version 2 with its inspections, ops and outbox intact', async () => {
    const name = `wt-${randomUUID()}`;
    const { transport } = memServer();
    const v1 = await openDb(name, indexedDB, 1);
    expect([...v1.objectStoreNames].sort()).toEqual(['inspections', 'meta', 'ops', 'outbox']);
    await download(v1, transport, 'acme', 'u1', ID);
    const a = await answer(v1, ID, 'items.roof-condition', 'pass');
    v1.close();
    const v2 = await openDb(name);
    expect(v2.version).toBe(2);
    expect([...v2.objectStoreNames].sort()).toEqual(['blobs', 'inspections', 'meta', 'ops', 'outbox', 'uploads']);
    expect([...(await loadReplica(v2, ID))!.replica.outbox]).toEqual([a.opId]);
    const { op } = await attachPhoto(v2, ID, 'items.roof-photo', image(100), 'image/jpeg');
    expect(op.opId).toBe(`${(await loadReplica(v2, ID))!.meta.deviceId}:2`);
  });
});

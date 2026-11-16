// B1/B2: the field client's IndexedDB store and sync (Phase 3), against fake-indexeddb and an in-memory server that
// runs the same engine rules as the Phase 2 endpoint (serverAccept).
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInspection, createReplica, materialize, serverAccept, SERVER_ID, type Op } from '@/lib/sync';
import { answer, download, loadReplica, syncAll, syncInspection, type Transport } from '@/lib/field/client';
import { countOutbox, listInspections, openDb } from '@/lib/field/db';
import { EXAMPLE_DEFINITION } from '@/lib/walkthrough/template';

const ID = '00000000-0000-4000-8000-000000000029';
type Fault = null | 'network' | 'lose-response' | { status: number; body: unknown };

function memServer() {
  const server = createReplica(SERVER_ID, ID);
  const order: Op[] = [createInspection(server, 't1', 1)];
  const s = { order, fault: null as Fault, pushes: 0 };
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

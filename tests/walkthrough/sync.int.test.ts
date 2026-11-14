import { describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { localSet, materialize, outboxOps, SERVER_ID } from '@/lib/sync';
import { device, opCount, pull, push, sync, world } from './helpers';

// A5: push acks exactly what is durable, a retry is idempotent, pull returns what follows the cursor.
// A6: a device pin, a forged or foreign op, an opId reused with other content, a device bound to someone else:
//     the whole batch is refused and nothing is stored. A10: the op log is append-only in the database.

describe('sync endpoint: push, ack, pull (A5)', () => {
  it('acks every pushed op, stores it once, and a retry of the same batch (a lost ack) stores nothing new', async () => {
    const w = await world();
    await w.as(w.techA.id);
    const d = await device(w.slug, w.inspectionId);
    localSet(d, 'items.roof-condition', 'pass');
    localSet(d, 'items.supply-temp', 61);
    const batch = { deviceId: d.id, since: d.cursor, ops: outboxOps(d) };
    const first = await push(w.slug, w.inspectionId, batch);
    expect(first.status).toBe(200);
    expect(first.body.acked.sort()).toEqual(batch.ops.map((o) => o.opId).sort());
    expect(first.body.cursor).toBe(3);
    expect(await opCount(w.inspectionId)).toBe(3);
    const retry = await push(w.slug, w.inspectionId, batch); // the device never saw the first ack
    expect(retry.status).toBe(200);
    expect(retry.body.acked.sort()).toEqual(first.body.acked.sort());
    expect(await opCount(w.inspectionId)).toBe(3);
    expect(retry.body.cursor).toBe(3);
  });

  it('pull returns only ops after the cursor, in receive order, and two devices converge', async () => {
    const w = await world();
    await w.as(w.techA.id);
    const a = await device(w.slug, w.inspectionId);
    const b = await device(w.slug, w.inspectionId);
    expect(a.cursor).toBe(1);
    localSet(a, 'items.roof-condition', 'pass');
    await sync(w.slug, a);
    localSet(b, 'items.hvac-notes', 'filter dirty');
    const rb = await sync(w.slug, b);
    expect(rb.body.ops.map((o: { opId: string }) => o.opId)).toEqual([`${a.id}:1`, `${b.id}:1`]); // since 1: both new ops, not the pin
    const ra = await sync(w.slug, a);
    expect(ra.body.ops.map((o: { opId: string }) => o.opId)).toEqual([`${b.id}:1`]);
    expect(materialize(a.log)).toEqual(materialize(b.log));
    expect(a.outbox.size + b.outbox.size).toBe(0);
    const later = await pull(w.slug, w.inspectionId, ra.body.cursor);
    expect(later.body.ops).toEqual([]);
  });

  it('two technicians answering one field offline both survive as a visible conflict (WT-03), resolved by a later write', async () => {
    const w = await world();
    await w.as(w.techA.id);
    const a = await device(w.slug, w.inspectionId);
    const b = await device(w.slug, w.inspectionId);
    localSet(a, 'items.roof-condition', 'pass');
    localSet(b, 'items.roof-condition', 'fail');
    await sync(w.slug, a);
    const rb = await sync(w.slug, b);
    expect(rb.body.conflicts).toEqual(['items.roof-condition']);
    expect(materialize(b.log).fields['items.roof-condition']!.heads.map((h) => h.value).sort()).toEqual(['fail', 'pass']);
    expect((await db.inspection.findUniqueOrThrow({ where: { id: w.inspectionId } })).conflictPaths).toEqual(['items.roof-condition']);
    localSet(b, 'items.roof-condition', 'fail'); // b has seen both: its write supersedes both heads
    const resolved = await sync(w.slug, b);
    expect(resolved.body.conflicts).toEqual([]);
    expect((await db.inspection.findUniqueOrThrow({ where: { id: w.inspectionId } })).conflictPaths).toEqual([]);
  });
});

describe('sync endpoint: refusals store nothing (A6)', () => {
  async function setup() {
    const w = await world();
    await w.as(w.techA.id);
    const d = await device(w.slug, w.inspectionId);
    const op = (n: number, extra: Record<string, unknown> = {}) => ({
      opId: `${d.id}:${n}`, deviceId: d.id, inspectionId: w.inspectionId, lamport: n + 1, templateVersion: 1, kind: 'set', path: 'items.roof-condition', value: 'pass', prev: [], ...extra,
    });
    return { w, d, op };
  }
  const refused = async (w: Awaited<ReturnType<typeof world>>, body: unknown, status: number, error: string, headers?: Record<string, string>) => {
    const before = await opCount(w.inspectionId);
    const r = await push(w.slug, w.inspectionId, body, headers);
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    expect(r.body.error).toBe(error);
    expect(await opCount(w.inspectionId)).toBe(before);
  };

  it('a device pin, alone or beside good ops (D-15)', async () => {
    const { w, d, op } = await setup();
    const pin = { opId: `${d.id}:9`, deviceId: d.id, inspectionId: w.inspectionId, lamport: 9, templateVersion: 2, kind: 'pin', templateId: w.template.id };
    await refused(w, { deviceId: d.id, ops: [op(1), pin] }, 422, 'device-pin');
    const forged = { ...pin, opId: `${SERVER_ID}:2`, deviceId: SERVER_ID };
    await refused(w, { deviceId: d.id, ops: [forged] }, 422, 'device-pin');
    // re-sending the server's own pin is harmless: it is already in the log
    expect((await push(w.slug, w.inspectionId, { deviceId: d.id, ops: [w.pin, op(1)] })).status).toBe(200);
  });

  it('an op written by another device, or with an opId outside this device\'s namespace', async () => {
    const { w, d, op } = await setup();
    const other = crypto.randomUUID();
    await refused(w, { deviceId: d.id, ops: [op(1), op(2, { deviceId: other, opId: `${other}:1` })] }, 403, 'foreign-op');
    await refused(w, { deviceId: d.id, ops: [op(1, { opId: `${d.id}:0` })] }, 403, 'foreign-op');
    await refused(w, { deviceId: d.id, ops: [op(1, { opId: `${other}:1` })] }, 403, 'foreign-op');
  });

  it('an opId already stored, or repeated in the batch, with different content (never replaced, WT-01)', async () => {
    const { w, d, op } = await setup();
    expect((await push(w.slug, w.inspectionId, { deviceId: d.id, ops: [op(1)] })).status).toBe(200);
    await refused(w, { deviceId: d.id, ops: [op(2), op(1, { value: 'fail' })] }, 409, 'integrity');
    await refused(w, { deviceId: d.id, ops: [op(2), op(2, { value: 'fail' })] }, 409, 'integrity');
    const stored = await db.inspectionOp.findFirstOrThrow({ where: { inspectionId: w.inspectionId, opId: `${d.id}:1` } });
    expect(stored.value).toBe('pass');
  });

  it('a device id bound to another technician', async () => {
    const { w, d, op } = await setup();
    expect((await push(w.slug, w.inspectionId, { deviceId: d.id, ops: [op(1)] })).status).toBe(200);
    await w.as(w.manager.id); // a manager may sync any inspection, but not from techA's device
    await refused(w, { deviceId: d.id, ops: [op(2)] }, 403, 'device-owner');
  });

  it('ops for another inspection, malformed ops, non-JSON and cross-site posts', async () => {
    const { w, d, op } = await setup();
    await refused(w, { deviceId: d.id, ops: [op(1, { inspectionId: crypto.randomUUID() })] }, 400, 'wrong-inspection');
    await refused(w, { deviceId: d.id, ops: [op(1, { lamport: 0 })] }, 400, 'bad_request');
    await refused(w, { deviceId: d.id, ops: [op(1, { extra: true })] }, 400, 'bad_request');
    await refused(w, { deviceId: 'not-a-uuid', ops: [] }, 400, 'bad_request');
    await refused(w, '{"deviceId":', 400, 'bad_json');
    await refused(w, { deviceId: d.id, ops: [op(1)] }, 415, 'json_required', { 'content-type': 'text/plain' });
    await refused(w, { deviceId: d.id, ops: [op(1)] }, 403, 'cross_origin', { origin: 'https://evil.example' });
  });
});

describe('the op log is append-only (A10)', () => {
  it('UPDATE on InspectionOp is refused by the database', async () => {
    const w = await world();
    await expect(db.$executeRaw`UPDATE "InspectionOp" SET value = '"x"'::jsonb WHERE "inspectionId" = ${w.inspectionId}::uuid`).rejects.toThrow(/immutable/);
  });
});

// A7: WT-01, WT-02 and WT-03 through the real sync endpoint and Postgres. Random multi-device scenarios with lost
// acks, duplicate deliveries, reordered batches and partial pulls, seeded through fast-check like the Phase 1
// properties. FC_SEED (default 29) and FC_DB_RUNS (default 100; every run resets the database).
import { appendFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { compareOps, localSet, logFrom, materialize, outboxOps, receive, type Op, type SetOp } from '@/lib/sync';
import { fromRow } from '@/lib/walkthrough/store';
import { device, push, sync, world } from './helpers';
import { shuffle } from '../sync/harness';

const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : 29;
const RUNS = process.env.FC_DB_RUNS ? Number(process.env.FC_DB_RUNS) : 100;
const PATHS = ['items.roof-condition', 'items.supply-temp', 'items.hvac-notes', 'items.chimney']; // the last is off the template

type Step =
  | { t: 'edit'; d: number; path: number; value: number }
  | { t: 'push'; d: number; ackLost: boolean; dupe: boolean; order: number[] }
  | { t: 'pull'; d: number };

const scenario = fc.integer({ min: 2, max: 3 }).chain((devices) => {
  const d = fc.integer({ min: 0, max: devices - 1 });
  const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 5, arbitrary: fc.record({ t: fc.constant('edit' as const), d, path: fc.integer({ min: 0, max: PATHS.length - 1 }), value: fc.integer({ min: 0, max: 3 }) }) },
    { weight: 3, arbitrary: fc.record({ t: fc.constant('push' as const), d, ackLost: fc.boolean(), dupe: fc.boolean(), order: fc.array(fc.nat(), { maxLength: 6 }) }) },
    { weight: 2, arbitrary: fc.record({ t: fc.constant('pull' as const), d }) },
  );
  return fc.record({ devices: fc.constant(devices), steps: fc.array(step, { minLength: 1, maxLength: 24 }) });
});

const dbLog = async (inspectionId: string) =>
  logFrom((await db.inspectionOp.findMany({ where: { inspectionId }, orderBy: { seq: 'asc' } })).map(fromRow));

describe(`sync endpoint properties over Postgres (seed ${SEED}, ${RUNS} runs)`, () => {
  it('WT-01 no acknowledged op is lost; WT-02 every replica converges; WT-03 every head is visible and conflicts are flagged', async () => {
    let checked = 0;
    await fc.assert(
      fc.asyncProperty(scenario, async ({ devices: n, steps }) => {
        const w = await world();
        // Devices belong to the assignee and to a manager (both may sync, D-16); each user's devices are their own.
        const owners = Array.from({ length: n }, (_, i) => (i % 2 ? w.manager.id : w.techA.id));
        const devs = [];
        for (const u of owners) {
          await w.as(u);
          devs.push(await device(w.slug, w.inspectionId));
        }
        const acked = new Set<string>();
        const created: SetOp[] = [];
        for (const s of steps) {
          const dv = devs[s.d]!;
          await w.as(owners[s.d]!);
          if (s.t === 'edit') created.push(localSet(dv, PATHS[s.path]!, s.value));
          else if (s.t === 'pull') expect((await sync(w.slug, dv)).status).toBe(200);
          else {
            const ops = shuffle(outboxOps(dv), s.order);
            const body = { deviceId: dv.id, since: dv.cursor, ops: s.dupe ? [...ops, ...ops] : ops };
            const r = await push(w.slug, w.inspectionId, body);
            expect(r.status, JSON.stringify(r.body)).toBe(200);
            r.body.acked.forEach((id: string) => acked.add(id));
            if (!s.ackLost) {
              dv.outbox = new Set([...dv.outbox].filter((id) => !r.body.acked.includes(id)));
              receive(dv, r.body.ops as Op[]);
              dv.cursor = r.body.cursor;
            }
          }
        }
        // WT-01 (before the final sync): everything the server acknowledged is durable.
        const mid = await dbLog(w.inspectionId);
        for (const id of acked) expect(mid.has(id), `acked ${id} missing`).toBe(true);
        // Final sync: every outbox flushed, then everyone pulls.
        for (const [i, dv] of devs.entries()) {
          await w.as(owners[i]!);
          expect((await sync(w.slug, dv)).status).toBe(200);
          expect(dv.outbox.size).toBe(0);
        }
        for (const [i, dv] of devs.entries()) {
          await w.as(owners[i]!);
          await sync(w.slug, dv);
        }
        const final = await dbLog(w.inspectionId);
        for (const op of created) expect(final.get(op.opId), `created ${op.opId} missing`).toEqual(op);
        expect(final.size).toBe(created.length + 1); // + the server pin, each op exactly once
        // WT-02: devices, the server, and the server's ops in a scrambled order all materialize identically.
        const state = materialize(final);
        for (const dv of devs) expect(materialize(dv.log)).toEqual(state);
        const scrambled = logFrom(shuffle([...final.values()], steps.map((_, i) => i * 7 + 3)));
        expect(materialize(scrambled)).toEqual(state);
        expect((await db.inspection.findUniqueOrThrow({ where: { id: w.inspectionId } })).conflictPaths).toEqual(state.conflicts);
        // WT-03, recomputed independently: heads = set ops no op supersedes; every one is in the state (no value hidden),
        // and the field is a conflict exactly when head values differ (every op here is on the pinned version 1).
        const sets = [...final.values()].filter((o): o is SetOp => o.kind === 'set');
        const superseded = new Set(sets.flatMap((o) => o.prev));
        for (const path of new Set(sets.map((o) => o.path))) {
          const heads = sets.filter((o) => o.path === path && !superseded.has(o.opId)).sort(compareOps);
          const f = state.fields[path]!;
          expect(f.heads.map((h) => h.opId)).toEqual(heads.map((h) => h.opId));
          expect(f.conflict).toBe(new Set(heads.map((h) => JSON.stringify(h.value))).size > 1);
        }
        checked++;
      }),
      { seed: SEED, numRuns: RUNS, endOnFailure: true },
    );
    if (process.env.FC_REPORT) appendFileSync(process.env.FC_REPORT, `sync.db.property seed=${SEED} runs=${checked}\n`);
    expect(checked).toBe(RUNS);
  }, 600_000);
});

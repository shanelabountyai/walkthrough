// WT-01, WT-02, WT-03 as fast-check properties over random multi-device sync interleavings (seeded: FC_SEED, FC_RUNS).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyAck, createReplica, localSet, outboxOps, serverAccept, logFrom, materialize, mergeLogs, receive, type Op, type Replica, type SetOp } from '@/lib/sync';
import { checkProperty, finalSync, RUNS, scenarioArb, shuffle, simulate } from './harness';

const ids = (log: ReadonlyMap<string, Op>) => [...log.keys()].sort();
const T = 120_000;

describe(`sync engine properties (seed ${process.env.FC_SEED ?? 29}, ${RUNS} runs each)`, () => {
  it('WT-01: no acknowledged op is ever lost, in any order of sync', () => {
    checkProperty(
      'WT-01 acknowledged ops survive any sync order',
      fc.property(scenarioArb, (sc) => {
        const run = simulate(sc);
        // Mid-flight: everything the server acknowledged is durable in the server log.
        for (const id of run.serverAcked) if (!run.server.log.has(id)) return false;
        // Unacked ops are still in their device's outbox or already on the server: nothing created is in limbo.
        for (const [id, op] of run.created) {
          const dev = run.devices.find((d) => d.id === op.deviceId)!;
          if (!dev.log.has(id)) return false;
          if (!run.server.log.has(id) && !dev.outbox.has(id)) return false;
        }
        finalSync(run);
        for (const id of run.created.keys()) if (!run.server.log.has(id)) return false;
        return run.devices.every((d) => ids(d.log).join() === ids(run.server.log).join());
      }),
    );
  }, T);

  it('WT-01: mergeLogs never drops an op from either side', () => {
    checkProperty(
      'WT-01 merge is a superset of its inputs',
      fc.property(scenarioArb, fc.array(fc.nat(), { maxLength: 8 }), fc.nat(), (sc, keys, cut) => {
        const run = simulate(sc);
        const all = shuffle([...run.created.values()], keys);
        const k = all.length ? cut % (all.length + 1) : 0;
        const a = logFrom(all.slice(0, k + (k < all.length ? 1 : 0))); // overlapping halves
        const b = logFrom(all.slice(k));
        const m = mergeLogs(a, b);
        return [...a.keys(), ...b.keys()].every((id) => m.has(id)) && m.size === new Set([...a.keys(), ...b.keys()]).size;
      }),
    );
  }, T);

  it('WT-02: the same set of ops converges to the same state on every device, in any delivery order', () => {
    checkProperty(
      'WT-02 convergence under permutation and batching',
      fc.property(scenarioArb, fc.array(fc.array(fc.nat(), { maxLength: 8 }), { minLength: 3, maxLength: 3 }), fc.array(fc.nat(), { minLength: 3, maxLength: 3 }), (sc, orders, batches) => {
        const run = simulate(sc);
        finalSync(run);
        const expected = JSON.stringify(materialize(run.server.log));
        if (!run.devices.every((d) => JSON.stringify(materialize(d.log)) === expected)) return false;
        const ops = [...run.server.log.values()];
        return orders.every((order, i) => {
          const fresh = createReplica(`fresh-${i}`, 'insp-1');
          const shuffled = shuffle(ops, order);
          const size = 1 + (batches[i]! % Math.max(1, shuffled.length)); // deliver in random-size batches
          for (let j = 0; j < shuffled.length; j += size) receive(fresh, shuffled.slice(j, j + size));
          return JSON.stringify(materialize(fresh.log)) === expected;
        });
      }),
    );
  }, T);

  it('WT-02: mergeLogs is commutative, associative and idempotent', () => {
    checkProperty(
      'WT-02 merge algebra',
      fc.property(scenarioArb, fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 60 }), (sc, assign) => {
        const run = simulate(sc);
        const parts: Op[][] = [[], [], []];
        [...run.created.values()].forEach((op, i) => parts[assign.length ? assign[i % assign.length]! : i % 3]!.push(op));
        const [a, b, c] = parts.map(logFrom) as [Map<string, Op>, Map<string, Op>, Map<string, Op>];
        const same = (x: ReadonlyMap<string, Op>, y: ReadonlyMap<string, Op>) =>
          ids(x).join() === ids(y).join() && JSON.stringify(materialize(x)) === JSON.stringify(materialize(y));
        return same(mergeLogs(a, b), mergeLogs(b, a)) && same(mergeLogs(mergeLogs(a, b), c), mergeLogs(a, mergeLogs(b, c))) && same(mergeLogs(a, a), a);
      }),
    );
  }, T);

  it('WT-03: a concurrent edit to one field is a visible conflict, never a silent overwrite', () => {
    checkProperty(
      'WT-03 no silent overwrite',
      fc.property(scenarioArb, (sc) => {
        const run = simulate(sc);
        finalSync(run);
        const state = materialize(run.server.log);
        const version = state.pin?.templateVersion;
        const sets = [...run.server.log.values()].filter((o): o is SetOp => o.kind === 'set' && (version === undefined || o.templateVersion === version));
        for (const x of sets) {
          const field = state.fields[x.path];
          if (!field) return false;
          const inHeads = field.heads.some((h) => h.opId === x.opId);
          // Oracle: x may leave the heads only if some writer had x in its log when it wrote over it.
          const overwrittenKnowingly = sets.some((y) => y.path === x.path && y.prev.includes(x.opId) && run.seenAtWrite.get(y.opId)?.has(x.opId));
          if (!inHeads && !overwrittenKnowingly) return false;
          // A head with a value other than the displayed one must raise the conflict badge.
          if (inHeads && JSON.stringify(x.value) !== JSON.stringify(field.value) && !(field.conflict && state.conflicts.includes(x.path))) return false;
        }
        // And the badge is never raised without two distinct live values.
        return state.conflicts.every((p) => new Set(state.fields[p]!.heads.map((h) => JSON.stringify(h.value))).size > 1);
      }),
    );
  }, T);

  it('WT-03: two devices editing the same field offline always conflict; resolving clears it everywhere', () => {
    checkProperty(
      'WT-03 offline concurrent edit -> conflict -> resolve',
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.boolean(),
        fc.array(fc.nat(), { maxLength: 8 }),
        (base, va, vb, aPushesFirst, order) => {
          fc.pre(va !== vb);
          const run = simulate({ devices: 2, steps: [] });
          const [a, b] = run.devices as [Replica, Replica];
          const path = 'items.roof.answer';
          // Common starting point: A answers, both devices sync.
          const baseOp = localSet(a, path, base);
          finalSync(run);
          if (!b.log.has(baseOp.opId)) return false;
          // Both go offline and answer differently.
          localSet(a, path, va);
          localSet(b, path, vb);
          // Either device may reach the server first; the other then pushes and both pull.
          const first = aPushesFirst ? a : b;
          applyAck(first, serverAccept(run.server, outboxOps(first)));
          finalSync(run);
          for (const r of [run.server, a, b]) {
            const st = materialize(new Map(shuffle([...r.log.entries()], order)));
            const f = st.fields[path]!;
            const vals = f.heads.map((h) => h.value);
            if (!f.conflict || !vals.includes(va) || !vals.includes(vb)) return false;
          }
          // B resolves after seeing both values: a clean write, and the badge clears on every replica.
          localSet(b, path, vb);
          finalSync(run);
          return [run.server, a, b].every((r) => {
            const f = materialize(r.log).fields[path]!;
            return !f.conflict && f.heads.length === 1 && f.value === vb;
          });
        },
      ),
    );
  }, T);
});

describe('sequential edits are overwrites, not conflicts', () => {
  it('B edits after pulling A: B wins, no badge', () => {
    const run = simulate({ devices: 2, steps: [] });
    const [a, b] = run.devices as [Replica, Replica];
    localSet(a, 'f', 'pass');
    finalSync(run);
    localSet(b, 'f', 'fail');
    finalSync(run);
    const f = materialize(a.log).fields.f!;
    expect(f).toMatchObject({ value: 'fail', conflict: false });
    expect(f.heads).toHaveLength(1);
  });
});

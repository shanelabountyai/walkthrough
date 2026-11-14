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

  it('WT-03: a concurrent edit to one field is a visible conflict, never a silent overwrite (off-template ops included)', () => {
    checkProperty(
      'WT-03 no silent overwrite',
      fc.property(scenarioArb, (sc) => {
        const run = simulate(sc);
        finalSync(run);
        const state = materialize(run.server.log);
        const version = state.pin?.templateVersion;
        // Every set op, whatever template version it was written against: a pin must never make an answer vanish (D-14).
        const sets = [...run.server.log.values()].filter((o): o is SetOp => o.kind === 'set');
        for (const x of sets) {
          const field = state.fields[x.path];
          if (!field) return false;
          const head = field.heads.find((h) => h.opId === x.opId);
          // Oracle: x may leave the heads only if some writer had x in its log when it wrote over it.
          const overwrittenKnowingly = sets.some((y) => y.path === x.path && y.prev.includes(x.opId) && run.seenAtWrite.get(y.opId)?.has(x.opId));
          if (!head && !overwrittenKnowingly) return false;
          if (!head) continue;
          const badged = field.conflict && state.conflicts.includes(x.path);
          // A head with a value other than the displayed one must raise the conflict badge.
          if (JSON.stringify(x.value) !== JSON.stringify(field.value) && !badged) return false;
          // A head written against a version other than the pinned one is flagged and must raise the badge.
          const off = version !== undefined && x.templateVersion !== version;
          if (head.offTemplate !== off || head.templateVersion !== x.templateVersion) return false;
          if (off && !badged) return false;
        }
        // The badge is raised exactly when a field has two distinct live values or a live off-template answer.
        return Object.entries(state.fields).every(([p, f]) => {
          const due = new Set(f.heads.map((h) => JSON.stringify(h.value))).size > 1 || f.heads.some((h) => h.offTemplate);
          return due === f.conflict && due === state.conflicts.includes(p);
        });
      }),
    );
  }, T);

  it('WT-03: no answer the server acknowledged ever drops out of the rendered state silently, mid-flight or after sync', () => {
    checkProperty(
      'WT-03 acked answers stay rendered',
      fc.property(scenarioArb, (sc) => {
        const run = simulate(sc);
        const check = (r: Replica) => {
          const state = materialize(r.log);
          for (const id of run.serverAcked) {
            const x = r.log.get(id);
            if (!x || x.kind !== 'set') continue;
            const field = state.fields[x.path];
            if (!field) return false;
            if (field.heads.some((h) => h.opId === id)) continue;
            // Gone from the heads only via a write that names it in prev from a writer who had it.
            const knowingly = [...r.log.values()].some((y) => y.kind === 'set' && y.path === x.path && y.prev.includes(id) && run.seenAtWrite.get(y.opId)?.has(id));
            if (!knowingly) return false;
          }
          return true;
        };
        if (![run.server, ...run.devices].every(check)) return false;
        finalSync(run);
        return [run.server, ...run.devices].every(check);
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

  it('LWW: the displayed value is the greatest live head by (lamport, deviceId, opId), on every replica, mid-flight and after sync', () => {
    // Oracle order written out here, independent of compareOps, so a broken comparator or winner pick is caught.
    const later = (a: SetOp, b: SetOp) => a.lamport !== b.lamport ? a.lamport > b.lamport : a.deviceId !== b.deviceId ? a.deviceId > b.deviceId : a.opId > b.opId;
    const lwwHolds = (log: ReadonlyMap<string, Op>) => {
      const state = materialize(log);
      const version = state.pin?.templateVersion;
      const sets = [...log.values()].filter((o): o is SetOp => o.kind === 'set');
      for (const path of new Set(sets.map((o) => o.path))) {
        const mine = sets.filter((o) => o.path === path);
        const superseded = new Set(mine.flatMap((o) => o.prev));
        const heads = mine.filter((o) => !superseded.has(o.opId));
        const onTemplate = heads.filter((o) => version === undefined || o.templateVersion === version);
        const pool = onTemplate.length ? onTemplate : heads;
        const best = pool.reduce((m, o) => (later(o, m) ? o : m));
        const f = state.fields[path];
        if (!f || f.winner !== best.opId || JSON.stringify(f.value) !== JSON.stringify(best.value)) return false;
        // heads are reported oldest first by the same order
        const order = f.heads.map((h) => log.get(h.opId) as SetOp);
        if (order.some((o, i) => i > 0 && !later(o, order[i - 1]!))) return false;
        if (new Set(order.map((o) => o.opId)).size !== heads.length || heads.some((h) => !order.includes(h))) return false;
      }
      return true;
    };
    checkProperty(
      'LWW winner is the greatest live head',
      fc.property(scenarioArb, (sc) => {
        const run = simulate(sc);
        if (![run.server, ...run.devices].every((r) => lwwHolds(r.log))) return false;
        finalSync(run);
        return lwwHolds(run.server.log);
      }),
    );
  }, T);

  it('D-15: the pin is the server-issued one on every replica, mid-flight and after sync; device pins are rejected', () => {
    checkProperty(
      'D-15 server-issued pin never changes',
      fc.property(scenarioArb, (sc) => {
        const run = simulate(sc);
        const pinned = (r: Replica) => {
          const p = materialize(r.log).pin;
          return p?.opId === run.pin.opId && p.templateVersion === run.pin.templateVersion;
        };
        if (run.pinViolations.length) return false;
        if (![run.server, ...run.devices].every(pinned)) return false;
        // No pin op from anyone but the server reaches any log.
        if ([run.server, ...run.devices].some((r) => [...r.log.values()].some((o) => o.kind === 'pin' && o.opId !== run.pin.opId))) return false;
        finalSync(run);
        return [run.server, ...run.devices].every((r) => pinned(r) && r.templateVersion === run.pin.templateVersion);
      }),
    );
  }, T);

  it('Lamport: every local op is stamped above every op in its writer\'s log at write time', () => {
    checkProperty(
      'Lamport clock exceeds everything seen',
      fc.property(scenarioArb, (sc) => {
        const run = simulate(sc);
        for (const [id, op] of run.created) {
          const seen = run.seenAtWrite.get(id)!;
          for (const s of seen) if (op.lamport <= (run.created.get(s) ?? run.server.log.get(s))!.lamport) return false;
        }
        return true;
      }),
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

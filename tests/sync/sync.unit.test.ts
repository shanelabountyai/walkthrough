import { describe, expect, it } from 'vitest';
import { appendOp, compareOps, createReplica, localPin, localSet, LogIntegrityError, logFrom, materialize, mergeLogs, observe, receive, tick, type SetOp } from '@/lib/sync';

const set = (o: Partial<SetOp> & Pick<SetOp, 'opId' | 'deviceId' | 'lamport'>): SetOp => ({ inspectionId: 'i', kind: 'set', path: 'f', value: 1, prev: [], templateVersion: 1, ...o });

describe('Lamport clock', () => {
  it('ticks on write and jumps past anything observed', () => {
    expect(tick(3)).toBe(4);
    expect(tick(observe(3, 9))).toBe(10);
    expect(observe(9, 3)).toBe(9);
  });
  it('orders by (lamport, deviceId, opId)', () => {
    const a = set({ opId: 'a:1', deviceId: 'a', lamport: 2 });
    const b = set({ opId: 'b:1', deviceId: 'b', lamport: 2 });
    const c = set({ opId: 'a:2', deviceId: 'a', lamport: 3 });
    expect([c, b, a].sort(compareOps).map((o) => o.opId)).toEqual(['a:1', 'b:1', 'a:2']);
  });
  it('a device writing after a sync stamps a higher clock than every op it received', () => {
    const a = createReplica('a', 'i');
    const b = createReplica('b', 'i');
    for (let n = 0; n < 5; n++) localSet(a, 'f', n);
    receive(b, a.log.values());
    expect(localSet(b, 'f', 'x').lamport).toBe(6);
  });
});

describe('op log', () => {
  it('is idempotent for an identical copy and refuses a different op under the same id (never replaced)', () => {
    const op = set({ opId: 'a:1', deviceId: 'a', lamport: 1 });
    const log = appendOp(new Map(), op);
    expect(appendOp(log, { ...op }).size).toBe(1);
    expect(() => appendOp(log, { ...op, value: 2 })).toThrow(LogIntegrityError);
    expect(() => mergeLogs(log, logFrom([{ ...op, value: 2 }]))).toThrow(LogIntegrityError);
  });
});

describe('materialize', () => {
  it('keeps both values and raises the badge for concurrent writes; LWW picks the displayed one', () => {
    const s = materialize(logFrom([set({ opId: 'a:1', deviceId: 'a', lamport: 1, value: 'pass' }), set({ opId: 'b:1', deviceId: 'b', lamport: 1, value: 'fail' })]));
    expect(s.conflicts).toEqual(['f']);
    expect(s.fields.f.value).toBe('fail'); // same clock: deviceId 'b' > 'a'
    expect(s.fields.f.heads.map((h) => h.value)).toEqual(['pass', 'fail']);
  });
  it('concurrent writes of the same value are not a conflict (D-09)', () => {
    const s = materialize(logFrom([set({ opId: 'a:1', deviceId: 'a', lamport: 1, value: 'pass' }), set({ opId: 'b:1', deviceId: 'b', lamport: 4, value: 'pass' })]));
    expect(s.conflicts).toEqual([]);
    expect(s.fields.f.heads).toHaveLength(2);
  });
  it('a write naming the old value in prev is an overwrite even with a lower clock', () => {
    const s = materialize(logFrom([set({ opId: 'a:1', deviceId: 'a', lamport: 9, value: 'pass' }), set({ opId: 'b:1', deviceId: 'b', lamport: 2, value: 'fail', prev: ['a:1'] })]));
    expect(s.fields.f).toMatchObject({ value: 'fail', conflict: false });
  });
});

describe('template-version pinning', () => {
  it('the first pin by total order wins whatever order pins arrive in; off-version writes are kept but not rendered', () => {
    const a = createReplica('a', 'i');
    const b = createReplica('b', 'i');
    localPin(a, 'tpl', 3); // lamport 1, device a
    localPin(b, 'tpl', 4); // lamport 1, device b — loses the tie
    const off = localSet(b, 'f', 'x'); // written against v4
    receive(a, b.log.values());
    receive(b, a.log.values());
    for (const r of [a, b]) {
      const s = materialize(r.log);
      expect(s.pin).toMatchObject({ templateVersion: 3 });
      expect(s.offTemplate).toEqual([off.opId]);
      expect(r.log.has(off.opId)).toBe(true); // never lost (WT-01)
      expect(r.templateVersion).toBe(3);
    }
    expect(localSet(b, 'f', 'y').templateVersion).toBe(3);
  });
});

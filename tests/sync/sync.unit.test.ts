import { describe, expect, it } from 'vitest';
import { appendOp, applyAck, compareOps, createInspection, createReplica, localSet, LogIntegrityError, logFrom, materialize, mergeLogs, observe, outboxOps, PinError, receive, serverAccept, SERVER_ID, tick, type PinOp, type SetOp } from '@/lib/sync';

/** A server that created inspection `i` pinned to `version` (D-15), and devices that downloaded it. */
function inspection(version = 1, ...deviceIds: string[]) {
  const server = createReplica(SERVER_ID, 'i');
  const pin = createInspection(server, 'tpl', version);
  const devices = deviceIds.map((id) => {
    const d = createReplica(id, 'i');
    receive(d, server.log.values());
    return d;
  });
  return { server, pin, devices };
}

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
    const { devices: [a, b] } = inspection(1, 'a', 'b'); // both saw the server pin at lamport 1
    for (let n = 0; n < 5; n++) localSet(a!, 'f', n); // lamport 2..6
    receive(b!, a!.log.values());
    expect(localSet(b!, 'f', 'x').lamport).toBe(7);
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
    expect(s.fields.f!.value).toBe('fail'); // same clock: deviceId 'b' > 'a'
    expect(s.fields.f!.heads.map((h) => h.value)).toEqual(['pass', 'fail']);
  });
  it('concurrent writes of the same value are not a conflict (D-09)', () => {
    const s = materialize(logFrom([set({ opId: 'a:1', deviceId: 'a', lamport: 1, value: 'pass' }), set({ opId: 'b:1', deviceId: 'b', lamport: 4, value: 'pass' })]));
    expect(s.conflicts).toEqual([]);
    expect(s.fields.f!.heads).toHaveLength(2);
  });
  it('a write naming the old value in prev is an overwrite even with a lower clock', () => {
    const s = materialize(logFrom([set({ opId: 'a:1', deviceId: 'a', lamport: 9, value: 'pass' }), set({ opId: 'b:1', deviceId: 'b', lamport: 2, value: 'fail', prev: ['a:1'] })]));
    expect(s.fields.f).toMatchObject({ value: 'fail', conflict: false });
  });
});

describe('template-version pinning: server-issued at inspection creation (D-15)', () => {
  it('the server pins when it creates the inspection; devices render and write against that version', () => {
    const { server, pin, devices: [a] } = inspection(3, 'a');
    expect(pin).toMatchObject({ kind: 'pin', deviceId: SERVER_ID, templateVersion: 3, lamport: 1 });
    expect(materialize(server.log).pin).toEqual({ templateId: 'tpl', templateVersion: 3, opId: pin.opId });
    expect(a!.templateVersion).toBe(3);
    expect(localSet(a!, 'f', 'x').templateVersion).toBe(3);
    expect(() => createInspection(server, 'tpl', 4)).toThrow(PinError); // already-created: the pin never changes
  });

  it('a device cannot write, or push, before it has the pin; the server refuses ops for an uncreated inspection', () => {
    const fresh = createReplica('a', 'i');
    expect(() => localSet(fresh, 'f', 1)).toThrow(expect.objectContaining({ reason: 'not-created' }));
    const server = createReplica(SERVER_ID, 'i');
    expect(() => serverAccept(server, [set({ opId: 'a:1', deviceId: 'a', lamport: 1 })])).toThrow(expect.objectContaining({ reason: 'not-created' }));
    expect(server.log.size).toBe(0);
  });

  it('a late offline device pin can no longer change the pin: rejected on the device and at the server, nothing stored', () => {
    const { server, pin, devices: [dev1, dev0] } = inspection(1, 'dev-1', 'dev-0');
    const answers = [0, 1, 2, 3, 4].map((n) => localSet(dev1!, `items.p${n}.answer`, `a${n}`));
    applyAck(dev1!, serverAccept(server, outboxOps(dev1!)));

    // dev-0, offline, tries to pin v2: a device can't create a pin.
    expect(() => createInspection(dev0!, 'tpl', 2)).toThrow(expect.objectContaining({ reason: 'device-pin' }));
    // A crafted pin at the lowest clock (would have won under D-12), and one forged as the server's: both refused whole.
    const base = { inspectionId: 'i', kind: 'pin' as const, templateId: 'tpl', templateVersion: 2 };
    const late: PinOp = { ...base, opId: 'dev-0:99', deviceId: 'dev-0', lamport: 0 };
    const forged: PinOp = { ...base, opId: `${SERVER_ID}:99`, deviceId: SERVER_ID, lamport: 0 };
    const size = server.log.size;
    for (const bad of [late, forged]) {
      expect(() => serverAccept(server, [answers[0]!, bad])).toThrow(expect.objectContaining({ reason: 'device-pin', opId: bad.opId }));
    }
    expect(server.log.size).toBe(size);

    // Even if a device pin is in some log, it is ignored: the server-issued pin stays, and no answer goes off-template.
    for (const log of [server.log, mergeLogs(server.log, logFrom([late, forged].filter((o) => o.deviceId !== SERVER_ID)))]) {
      const s = materialize(log);
      expect(s.pin).toMatchObject({ opId: pin.opId, templateVersion: 1 });
      expect(s.offTemplate).toEqual([]);
      expect(s.conflicts).toEqual([]);
      for (const a of answers) expect(s.fields[a.path]).toMatchObject({ value: a.value, conflict: false });
    }
  });

  it('replaying the server pin (a device re-pushes everything it has) is idempotent', () => {
    const { server, pin, devices: [a] } = inspection(1, 'a');
    localSet(a!, 'f', 1);
    const acks = serverAccept(server, [...a!.log.values(), ...a!.log.values()]);
    expect(acks).toContain(pin.opId);
    expect(server.log.size).toBe(2);
    expect(materialize(server.log).pin?.opId).toBe(pin.opId);
  });
});

describe('answers written against another version stay visible and badged (D-14, kept under D-15)', () => {
  it('a stale client writes against v2 while the inspection is pinned to v1: every answer stays visible with a badge', () => {
    const { server, devices: [dev1, dev0] } = inspection(1, 'dev-1', 'dev-0');
    dev0!.templateVersion = 2; // stale client still rendering another version
    const answers = [0, 1, 2, 3, 4].map((n) => localSet(dev0!, `items.p${n}.answer`, `a${n}`));
    const acked = serverAccept(server, outboxOps(dev0!));
    applyAck(dev0!, acked);
    expect(acked).toHaveLength(5);
    receive(dev1!, server.log.values());
    receive(dev0!, server.log.values());
    expect(dev0!.templateVersion).toBe(1); // pulling the pin puts it back on the pinned version

    for (const r of [server, dev1!, dev0!]) {
      const s = materialize(r.log);
      expect(s.pin).toMatchObject({ templateVersion: 1 });
      expect(s.offTemplate).toEqual(answers.map((a) => a.opId).sort());
      for (const a of answers) {
        const f = s.fields[a.path];
        expect(f, `${a.path} vanished on ${r.id}`).toBeDefined();
        expect(f).toMatchObject({ value: a.value, winner: a.opId, conflict: true });
        expect(f!.heads).toEqual([{ opId: a.opId, deviceId: 'dev-0', value: a.value, templateVersion: 2, offTemplate: true }]);
      }
      expect(s.conflicts).toEqual(answers.map((a) => a.path).sort());
    }

    // Re-answering on the pinned version after seeing the flagged value is a clean overwrite: the badge clears.
    const fix = localSet(dev1!, 'items.p0.answer', 'a0');
    expect(fix.templateVersion).toBe(1);
    expect(fix.prev).toEqual([answers[0]!.opId]);
    applyAck(dev1!, serverAccept(server, outboxOps(dev1!)));
    const s = materialize(server.log);
    expect(s.fields['items.p0.answer']).toMatchObject({ value: 'a0', conflict: false });
    expect(s.conflicts).not.toContain('items.p0.answer');
  });
});

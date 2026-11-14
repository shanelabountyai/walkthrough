import { observe, tick } from './clock';
import { appendOp, mergeLogs, PinError, sameOp } from './log';
import { headsFor, pinnedTemplate } from './merge';
import { SERVER_ID, type Json, type Log, type Op, type PinOp, type SetOp } from './types';

/** One replica of one inspection's log: a technician's device, or the server. */
export interface Replica {
  id: string;
  inspectionId: string;
  clock: number;
  seq: number;
  log: Map<string, Op>;
  /** Device only: ops written or received but not yet acknowledged by the server. */
  outbox: Set<string>;
  /** Template version this replica renders with (the pinned one once a pin is known). */
  templateVersion: number;
}

export function createReplica(id: string, inspectionId: string, templateVersion = 1): Replica {
  return { id, inspectionId, clock: 0, seq: 0, log: new Map(), outbox: new Set(), templateVersion };
}

function stamp(r: Replica) {
  r.clock = tick(r.clock);
  r.seq += 1;
  return { opId: `${r.id}:${r.seq}`, deviceId: r.id, inspectionId: r.inspectionId, lamport: r.clock, templateVersion: r.templateVersion };
}

/**
 * A local edit: supersedes exactly the values this replica can see for the field.
 * Throws `PinError('not-created')` before the replica has the inspection's server-issued pin (D-15).
 */
export function localSet(r: Replica, path: string, value: Json): SetOp {
  if (!pinnedTemplate(r.log)) throw new PinError('not-created');
  const op: SetOp = { ...stamp(r), kind: 'set', path, value, prev: headsFor(r.log, path) };
  r.log = appendOp(r.log, op);
  r.outbox.add(op.opId);
  return op;
}

/**
 * Server only: create the inspection by issuing its template pin, before any device op exists (D-15).
 * Devices get the pin when they download the inspection (`receive`). A device calling this gets
 * `PinError('device-pin')`; a second call on the server gets `PinError('already-created')`.
 */
export function createInspection(server: Replica, templateId: string, templateVersion: number): PinOp {
  if (server.id !== SERVER_ID) throw new PinError('device-pin');
  if (pinnedTemplate(server.log) || server.log.size) throw new PinError('already-created');
  server.templateVersion = templateVersion;
  const op: PinOp = { ...stamp(server), kind: 'pin', templateId };
  server.log = appendOp(server.log, op);
  return op;
}

/** Receive ops (any order, duplicates allowed). Advances the Lamport clock past everything seen. */
export function receive(r: Replica, ops: Iterable<Op>): void {
  const incoming = new Map<string, Op>();
  for (const op of ops) {
    incoming.set(op.opId, op);
    r.clock = observe(r.clock, op.lamport);
  }
  r.log = mergeLogs(r.log, incoming);
  // Once a pin is known, this replica renders (and writes) against the pinned version (WT-04).
  const pin = pinnedTemplate(r.log);
  if (pin) r.templateVersion = pin.templateVersion;
}

/**
 * Server side of a push: store, then acknowledge exactly the opIds now durable in the server log.
 * The batch is checked before anything is stored (D-15): a pin op that is not the server's own issued pin is
 * rejected with `PinError('device-pin')`, and ops for an inspection the server has not created (no pin) with
 * `PinError('not-created')`. Like `LogIntegrityError`, a rejection refuses the whole batch and stores nothing.
 */
export function serverAccept(server: Replica, ops: Op[]): string[] {
  if (ops.length && !pinnedTemplate(server.log)) throw new PinError('not-created');
  for (const op of ops) {
    if (op.kind !== 'pin') continue;
    const known = server.log.get(op.opId);
    if (!known || !sameOp(known, op)) throw new PinError('device-pin', op.opId);
  }
  receive(server, ops);
  return ops.filter((o) => server.log.has(o.opId)).map((o) => o.opId);
}

/** Device side of an ack: only acknowledged ops leave the outbox. The log itself is never pruned. */
export function applyAck(device: Replica, acked: Iterable<string>): void {
  for (const id of acked) device.outbox.delete(id);
}

export const outboxOps = (r: Replica): Op[] => [...r.outbox].map((id) => r.log.get(id)!).filter(Boolean);

export const snapshot = (log: Log): Op[] => [...log.values()];

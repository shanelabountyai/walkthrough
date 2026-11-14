import type { Log, Op } from './types';

export class LogIntegrityError extends Error {
  constructor(readonly opId: string) {
    super(`op ${opId} arrived twice with different content`);
  }
}

/**
 * A template pin the engine refuses (D-15):
 * - `device-pin`: a device tried to create or push a pin — only the server pins, at inspection creation.
 * - `already-created`: the server already pinned this inspection; the pin never changes.
 * - `not-created`: an op for an inspection with no server pin yet (a device writes only after it has the pin).
 */
export class PinError extends Error {
  constructor(
    readonly reason: 'device-pin' | 'already-created' | 'not-created',
    readonly opId?: string,
  ) {
    super(
      reason === 'device-pin'
        ? `pin ${opId ?? ''} rejected: only the server pins the template version, when the inspection is created`
        : reason === 'already-created'
          ? 'inspection already has its server-issued pin; the pin never changes'
          : 'inspection has no server-issued pin yet: receive it before writing or pushing ops',
    );
  }
}

/** Canonical form for comparing two copies of an op (key order independent). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export const sameOp = (a: Op, b: Op): boolean => canonical(a) === canonical(b);

/** Add one op. Idempotent for an identical copy; a different op under a known opId throws (never replaced). */
export function appendOp(log: Log, op: Op): Map<string, Op> {
  const existing = log.get(op.opId);
  if (existing) {
    if (!sameOp(existing, op)) throw new LogIntegrityError(op.opId);
    return new Map(log);
  }
  return new Map(log).set(op.opId, op);
}

/** Set union of logs: commutative, associative, idempotent. Never drops an op from either side. */
export function mergeLogs(...logs: Log[]): Map<string, Op> {
  const out = new Map<string, Op>();
  for (const log of logs) {
    for (const op of log.values()) {
      const existing = out.get(op.opId);
      if (existing) {
        if (!sameOp(existing, op)) throw new LogIntegrityError(op.opId);
      } else out.set(op.opId, op);
    }
  }
  return out;
}

export const logFrom = (ops: Iterable<Op>): Map<string, Op> => mergeLogs(new Map([...ops].map((o) => [o.opId, o] as const)));

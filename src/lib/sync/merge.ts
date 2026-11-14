import { compareOps } from './clock';
import { SERVER_ID, type FieldState, type InspectionState, type Json, type Log, type Op, type PinOp, type SetOp } from './types';

/** Value equality for JSON values (object key order independent). */
export function sameValue(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i] as Json));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameValue(a[k] as Json, b[k] as Json));
  }
  return false;
}

/**
 * The pinned template: the server-issued pin op written when the inspection was created (D-15). A pin op from a
 * device is never authoritative: `serverAccept` rejects it, and if one is in a log anyway it is ignored here.
 * The server issues exactly one; the min by total order only keeps this total and order-independent.
 */
export function pinnedTemplate(log: Log): PinOp | null {
  let first: PinOp | null = null;
  for (const op of log.values()) {
    if (op.kind === 'pin' && op.deviceId === SERVER_ID && (!first || compareOps(op, first) < 0)) first = op;
  }
  return first;
}

/** Current head opIds for one path — what a device writing `path` now would put in `prev`. */
export function headsFor(log: Log, path: string): string[] {
  const sets = [...log.values()].filter((o): o is SetOp => o.kind === 'set' && o.path === path);
  const superseded = new Set(sets.flatMap((o) => o.prev));
  return sets.filter((o) => !superseded.has(o.opId)).sort(compareOps).map((o) => o.opId);
}

/**
 * Log → state. Deterministic in the set of ops (WT-02): it depends only on op content, never on arrival order.
 * Per field: heads are the set ops nobody superseded; the displayed value is the last head by total order;
 * more than one distinct head value is a visible conflict with every head value kept (WT-03).
 * Off-template set ops (written against a version other than the pinned one) are listed in `offTemplate`, and a
 * head among them is never dropped: it stays in the field's heads flagged `offTemplate` and raises the conflict
 * badge, whatever the pin rule (D-14). The displayed value prefers on-template heads.
 */
export function materialize(log: Log): InspectionState {
  const pin = pinnedTemplate(log);
  const version = pin?.templateVersion;
  const offTemplate: string[] = [];
  const isOff = (o: SetOp) => version !== undefined && o.templateVersion !== version;
  const byPath = new Map<string, SetOp[]>();
  for (const op of log.values()) {
    if (op.kind !== 'set') continue;
    if (isOff(op)) offTemplate.push(op.opId);
    const list = byPath.get(op.path);
    if (list) list.push(op);
    else byPath.set(op.path, [op]);
  }
  const fields: Record<string, FieldState> = {};
  const conflicts: string[] = [];
  for (const path of [...byPath.keys()].sort()) {
    const sets = byPath.get(path)!;
    // Supersession over every set op for the path — the same heads `headsFor` puts in a writer's `prev`.
    const superseded = new Set(sets.flatMap((o) => o.prev));
    const heads = sets.filter((o) => !superseded.has(o.opId)).sort(compareOps);
    // Every set op superseded is impossible (prev only names earlier ops: no cycles), but stay total anyway.
    const live = heads.length ? heads : [...sets].sort(compareOps).slice(-1);
    const onTemplate = live.filter((h) => !isOff(h));
    const shown = onTemplate.length ? onTemplate : live;
    const winner = shown[shown.length - 1]!;
    // A visible conflict: two distinct live values (WT-03), or any live answer written against another template version (D-14).
    const conflict = live.some((h) => isOff(h) || !sameValue(h.value, winner.value));
    fields[path] = {
      value: winner.value,
      winner: winner.opId,
      heads: live.map((h) => ({ opId: h.opId, deviceId: h.deviceId, value: h.value, templateVersion: h.templateVersion, offTemplate: isOff(h) })),
      conflict,
    };
    if (conflict) conflicts.push(path);
  }
  return {
    pin: pin ? { templateId: pin.templateId, templateVersion: pin.templateVersion, opId: pin.opId } : null,
    fields,
    conflicts,
    offTemplate: offTemplate.sort(),
  };
}

export type { Op };

import { compareOps } from './clock';
import type { FieldState, InspectionState, Json, Log, Op, PinOp, SetOp } from './types';

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

/** The pinned template: the first pin op by total order, whatever order the ops arrived in. */
export function pinnedTemplate(log: Log): PinOp | null {
  let first: PinOp | null = null;
  for (const op of log.values()) if (op.kind === 'pin' && (!first || compareOps(op, first) < 0)) first = op;
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
 */
export function materialize(log: Log): InspectionState {
  const pin = pinnedTemplate(log);
  const version = pin?.templateVersion;
  const offTemplate: string[] = [];
  const byPath = new Map<string, SetOp[]>();
  for (const op of log.values()) {
    if (op.kind !== 'set') continue;
    if (version !== undefined && op.templateVersion !== version) {
      offTemplate.push(op.opId);
      continue;
    }
    const list = byPath.get(op.path);
    if (list) list.push(op);
    else byPath.set(op.path, [op]);
  }
  const fields: Record<string, FieldState> = {};
  const conflicts: string[] = [];
  for (const path of [...byPath.keys()].sort()) {
    const sets = byPath.get(path)!;
    const superseded = new Set(sets.flatMap((o) => o.prev));
    const heads = sets.filter((o) => !superseded.has(o.opId)).sort(compareOps);
    // Every set op superseded is impossible (prev only names earlier ops: no cycles), but stay total anyway.
    const live = heads.length ? heads : [...sets].sort(compareOps).slice(-1);
    const winner = live[live.length - 1]!;
    const conflict = live.some((h) => !sameValue(h.value, winner.value));
    fields[path] = {
      value: winner.value,
      winner: winner.opId,
      heads: live.map((h) => ({ opId: h.opId, deviceId: h.deviceId, value: h.value })),
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

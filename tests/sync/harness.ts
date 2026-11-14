// Scenario generator + simulator for the sync property tests (WT-01..03). Seeded through fast-check.
import { appendFileSync } from 'node:fs';
import fc from 'fast-check';
import { applyAck, createInspection, createReplica, localSet, outboxOps, PinError, receive, serverAccept, SERVER_ID, type Op, type PinOp, type Replica } from '@/lib/sync';

/** FC_SEED (default fixed 29) and FC_RUNS (default 2000 per property). */
export const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : 29;
export const RUNS = process.env.FC_RUNS ? Number(process.env.FC_RUNS) : 2000;

export type Step =
  | { t: 'edit'; d: number; path: number; value: number }
  /** A device tries to pin (rejected, D-15), then keeps rendering that version until its next pull (a stale client). */
  | { t: 'pinAttempt'; d: number; version: number }
  | { t: 'push'; d: number; mask: number; ackLost: boolean; dupe: boolean }
  | { t: 'pull'; d: number; mask: number; order: number[] };

export interface Scenario {
  devices: number;
  steps: Step[];
}

const MAX_DEVICES = 4;
export const scenarioArb: fc.Arbitrary<Scenario> = fc.integer({ min: 2, max: MAX_DEVICES }).chain((devices) => {
  const d = fc.integer({ min: 0, max: devices - 1 });
  const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 6, arbitrary: fc.record({ t: fc.constant('edit' as const), d, path: fc.integer({ min: 0, max: 5 }), value: fc.integer({ min: 0, max: 4 }) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('pinAttempt' as const), d, version: fc.integer({ min: 1, max: 3 }) }) },
    { weight: 3, arbitrary: fc.record({ t: fc.constant('push' as const), d, mask: fc.nat(), ackLost: fc.boolean(), dupe: fc.boolean() }) },
    { weight: 3, arbitrary: fc.record({ t: fc.constant('pull' as const), d, mask: fc.nat(), order: fc.array(fc.nat(), { maxLength: 8 }) }) },
  );
  return fc.record({ devices: fc.constant(devices), steps: fc.array(step, { minLength: 1, maxLength: 40 }) });
});

/** Deterministic shuffle driven by generated numbers (so the permutation is part of the seeded input). */
export function shuffle<T>(items: T[], keys: number[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const k = keys.length ? keys[i % keys.length]! + i : i;
    const j = k % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Bit i of mask (cycled over 31 bits) decides whether element i is delivered. mask 0 delivers everything. */
const pick = <T>(items: T[], mask: number): T[] => (mask === 0 ? items : items.filter((_, i) => (mask >> i % 31) & 1));

export interface Run {
  server: Replica;
  /** The server-issued pin, written when the inspection was created (D-15). */
  pin: PinOp;
  /** Every pinAttempt that was not rejected, or that changed the server log: must stay empty. */
  pinViolations: string[];
  devices: Replica[];
  created: Map<string, Op>;
  /** opIds the server acknowledged (whether or not the ack reached the device). */
  serverAcked: Set<string>;
  /** opIds whose ack reached the device. */
  deviceAcked: Set<string>;
  /** For each device-created op: the opIds in the writer's log at write time. */
  seenAtWrite: Map<string, Set<string>>;
}

export const TEMPLATE_VERSION = 1;

/** Expect `fn` to throw PinError with `reason`; describe what happened otherwise. */
function rejected(fn: () => unknown, reason: PinError['reason']): string | null {
  try {
    fn();
    return 'not rejected';
  } catch (e) {
    return e instanceof PinError && e.reason === reason ? null : `wrong error: ${String(e)}`;
  }
}

export function simulate(sc: Scenario, inspectionId = 'insp-1'): Run {
  const server = createReplica(SERVER_ID, inspectionId);
  // The server creates the inspection with its pin before any device op exists (D-15); devices download it.
  const pin = createInspection(server, 'tpl-hvac', TEMPLATE_VERSION);
  const devices = Array.from({ length: sc.devices }, (_, i) => createReplica(`dev-${i}`, inspectionId));
  for (const dev of devices) receive(dev, server.log.values());
  const run: Run = { server, pin, pinViolations: [], devices, created: new Map(), serverAcked: new Set(), deviceAcked: new Set(), seenAtWrite: new Map() };
  for (const s of sc.steps) {
    const dev = devices[s.d]!;
    if (s.t === 'edit') {
      const seen = new Set(dev.log.keys());
      const op = localSet(dev, `items.p${s.path}.answer`, s.value);
      run.created.set(op.opId, op);
      run.seenAtWrite.set(op.opId, seen);
    } else if (s.t === 'pinAttempt') {
      const before = server.log.size;
      const why = rejected(() => createInspection(dev, 'tpl-hvac', s.version), 'device-pin');
      if (why) run.pinViolations.push(`createInspection on ${dev.id}: ${why}`);
      // A crafted device pin, and one forged as the server's at a lower clock: both refused, nothing stored.
      const base = { inspectionId, templateId: 'tpl-hvac', templateVersion: s.version, kind: 'pin' as const };
      const crafted: PinOp[] = [
        { ...base, opId: `${dev.id}:pin-${run.pinViolations.length}-${before}`, deviceId: dev.id, lamport: 1 },
        { ...base, opId: `${SERVER_ID}:forged-${dev.id}-${before}`, deviceId: SERVER_ID, lamport: 0 },
      ];
      for (const op of crafted) {
        const w = rejected(() => serverAccept(server, [op]), 'device-pin');
        if (w) run.pinViolations.push(`push ${op.opId}: ${w}`);
      }
      if (server.log.size !== before) run.pinViolations.push(`server log changed on ${dev.id}'s pin attempt`);
      dev.templateVersion = s.version; // stale client: answers written now carry this version (D-14 territory)
    } else if (s.t === 'push') {
      const sent = pick(outboxOps(dev), s.mask); // partial delivery: the rest stays in the outbox
      const acks = serverAccept(server, s.dupe ? [...sent, ...sent] : sent);
      acks.forEach((id) => run.serverAcked.add(id));
      if (!s.ackLost) {
        applyAck(dev, acks);
        acks.forEach((id) => run.deviceAcked.add(id));
      }
    } else {
      receive(dev, shuffle(pick([...server.log.values()], s.mask), s.order));
    }
  }
  return run;
}

/** Everyone pushes everything still unacked, then everyone pulls everything. */
export function finalSync(run: Run): void {
  for (const dev of run.devices) {
    const acks = serverAccept(run.server, outboxOps(dev));
    acks.forEach((id) => run.serverAcked.add(id));
    applyAck(dev, acks);
  }
  for (const dev of run.devices) receive(dev, [...run.server.log.values()]);
}

/** fc.check + assert, recording the run count per property for the PR body (FC_REPORT=<file>). */
export function checkProperty<Ts extends [unknown, ...unknown[]]>(name: string, prop: fc.IProperty<Ts>, runs = RUNS): void {
  const details = fc.check(prop, { seed: SEED, numRuns: runs });
  if (process.env.FC_REPORT) {
    appendFileSync(process.env.FC_REPORT, JSON.stringify({ name, seed: SEED, numRuns: details.numRuns, failed: details.failed }) + '\n');
  }
  if (details.failed) throw new Error(fc.defaultReportMessage(details) ?? `${name} failed`);
}

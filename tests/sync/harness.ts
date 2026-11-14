// Scenario generator + simulator for the sync property tests (WT-01..03). Seeded through fast-check.
import { appendFileSync } from 'node:fs';
import fc from 'fast-check';
import { applyAck, createReplica, localPin, localSet, outboxOps, receive, serverAccept, type Op, type Replica } from '@/lib/sync';

/** FC_SEED (default fixed 29) and FC_RUNS (default 2000 per property). */
export const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : 29;
export const RUNS = process.env.FC_RUNS ? Number(process.env.FC_RUNS) : 2000;

export type Step =
  | { t: 'edit'; d: number; path: number; value: number }
  | { t: 'pin'; d: number; version: number }
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
    { weight: 1, arbitrary: fc.record({ t: fc.constant('pin' as const), d, version: fc.integer({ min: 1, max: 3 }) }) },
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
  devices: Replica[];
  created: Map<string, Op>;
  /** opIds the server acknowledged (whether or not the ack reached the device). */
  serverAcked: Set<string>;
  /** opIds whose ack reached the device. */
  deviceAcked: Set<string>;
  /** For each created op (set or pin): the opIds in the writer's log at write time. */
  seenAtWrite: Map<string, Set<string>>;
}

export function simulate(sc: Scenario, inspectionId = 'insp-1'): Run {
  const server = createReplica('server', inspectionId);
  const devices = Array.from({ length: sc.devices }, (_, i) => createReplica(`dev-${i}`, inspectionId));
  const run: Run = { server, devices, created: new Map(), serverAcked: new Set(), deviceAcked: new Set(), seenAtWrite: new Map() };
  for (const s of sc.steps) {
    const dev = devices[s.d]!;
    if (s.t === 'edit') {
      const seen = new Set(dev.log.keys());
      const op = localSet(dev, `items.p${s.path}.answer`, s.value);
      run.created.set(op.opId, op);
      run.seenAtWrite.set(op.opId, seen);
    } else if (s.t === 'pin') {
      const seen = new Set(dev.log.keys());
      const op = localPin(dev, 'tpl-hvac', s.version);
      run.created.set(op.opId, op);
      run.seenAtWrite.set(op.opId, seen);
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

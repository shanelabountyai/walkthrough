import type { Op } from './types';

/** Next clock for a local write. */
export const tick = (clock: number): number => clock + 1;

/** Clock after receiving an op stamped `remote`: the next local write is strictly greater than both. */
export const observe = (clock: number, remote: number): number => Math.max(clock, remote);

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Total order over ops: (lamport, deviceId, opId). Ties are impossible for distinct opIds. */
export function compareOps(a: Pick<Op, 'lamport' | 'deviceId' | 'opId'>, b: Pick<Op, 'lamport' | 'deviceId' | 'opId'>): number {
  return a.lamport - b.lamport || cmpStr(a.deviceId, b.deviceId) || cmpStr(a.opId, b.opId);
}

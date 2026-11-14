// Shared fixture for the Walkthrough Phase 2 tests: one org, a manager, two technicians, a template and an inspection.
import { randomUUID } from 'node:crypto';
import { requireOrg } from '@/core/authz/guards';
import { dbSystem as db } from '@/core/db/system';
import { applyAck, createReplica, outboxOps, receive, type Op, type Replica } from '@/lib/sync';
import { createInspectionRecord, createTemplate } from '@/lib/walkthrough/store';
import { EXAMPLE_DEFINITION, type TemplateDefinition } from '@/lib/walkthrough/template';
import { GET, POST } from '@/app/o/[org]/inspections/[id]/sync/route';
import { resetAuthTables, signInAs } from '../helpers/auth';
import { addMember, makeOrg } from '../helpers/org';
import { jar } from '../helpers/next';
import { SESSION_COOKIE } from '@/core/auth/session';

export const APP = 'http://localhost:8200';

export async function world(slug = 'acme', definition: TemplateDefinition = EXAMPLE_DEFINITION) {
  await resetAuthTables();
  const org = await makeOrg(slug);
  const manager = await addMember(org.id, 'admin', `manager@${slug}.test`);
  const techA = await addMember(org.id, 'member', `tech-a@${slug}.test`);
  const techB = await addMember(org.id, 'member', `tech-b@${slug}.test`);
  const sessions = new Map<string, string>();
  for (const u of [manager, techA, techB]) sessions.set(u.id, await signInAs(u.id, { mfa: true }));
  const as = async (userId: string) => {
    jar.clear();
    jar.set(SESSION_COOKIE, sessions.get(userId)!);
    return requireOrg(slug);
  };
  const mctx = await as(manager.id);
  const template = await createTemplate(mctx, 'House', definition);
  const { id: inspectionId, pin } = await createInspectionRecord(mctx, { templateId: template.id, assigneeId: techA.id, title: 'Smith house' });
  return { org, slug, manager, techA, techB, as, template, inspectionId, pin };
}

const params = (org: string, id: string) => ({ params: Promise.resolve({ org, id }) });

/** GET the sync endpoint as whoever the jar is signed in as. */
export async function pull(slug: string, id: string, since = 0) {
  const res = await GET(new Request(`${APP}/o/${slug}/inspections/${id}/sync?since=${since}`, { headers: { host: 'localhost:8200' } }), params(slug, id));
  return { status: res.status, body: await res.json() };
}

/** POST the sync endpoint (same-origin JSON unless `headers` overrides). */
export async function push(slug: string, id: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await POST(
    new Request(`${APP}/o/${slug}/inspections/${id}/sync`, {
      method: 'POST',
      headers: { host: 'localhost:8200', origin: APP, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    params(slug, id),
  );
  return { status: res.status, body: await res.json() };
}

/** A device replica with a fresh uuid, downloaded from the server (it needs the pin before it can write, D-15). */
export async function device(slug: string, inspectionId: string): Promise<Replica & { cursor: number }> {
  const r = Object.assign(createReplica(randomUUID(), inspectionId), { cursor: 0 });
  const got = await pull(slug, inspectionId);
  if (got.status !== 200) throw new Error(`download failed: ${got.status}`);
  receive(r, got.body.ops as Op[]);
  r.cursor = got.body.cursor;
  return r;
}

/** Push the device's outbox, apply the ack and pulled ops. Returns the raw response. */
export async function sync(slug: string, d: Replica & { cursor: number }) {
  const r = await push(slug, d.inspectionId, { deviceId: d.id, since: d.cursor, ops: outboxOps(d) });
  if (r.status === 200) {
    applyAck(d, r.body.acked);
    receive(d, r.body.ops as Op[]);
    d.cursor = r.body.cursor;
  }
  return r;
}

export const opCount = (inspectionId: string) => db.inspectionOp.count({ where: { inspectionId } });

/** Every string in a rendered element tree (bound server actions make JSON.stringify circular). */
export function textOf(node: unknown, seen = new WeakSet<object>()): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object' || seen.has(node)) return '';
  seen.add(node);
  if (Array.isArray(node)) return node.map((n) => textOf(n, seen)).join(' ');
  const props = (node as { props?: Record<string, unknown> }).props;
  return props ? Object.values(props).map((v) => textOf(v, seen)).join(' ') : '';
}

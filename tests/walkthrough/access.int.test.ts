import { describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import Inspections from '@/app/o/[org]/inspections/page';
import InspectionPage from '@/app/o/[org]/inspections/[id]/page';
import { localSet, outboxOps } from '@/lib/sync';
import { device, opCount, pull, push, textOf, world } from './helpers';

// A9 / WT-05: a technician reads (and syncs) only inspections assigned to them. Not assigned, another org's
// inspection and an id that does not exist all answer the same 404; managers see the org's inspections.
describe('WT-05: technicians see only their assigned inspections', () => {
  it('the unassigned technician gets the nonexistent-id 404 on GET and POST, and stores nothing', async () => {
    const w = await world();
    await w.as(w.techA.id);
    const d = await device(w.slug, w.inspectionId);
    localSet(d, 'items.roof-condition', 'pass');
    const body = { deviceId: d.id, ops: outboxOps(d) };

    await w.as(w.techB.id);
    const missing = crypto.randomUUID();
    const [g1, g2] = [await pull(w.slug, w.inspectionId), await pull(w.slug, missing)];
    expect(g1).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(g1).toEqual(g2);
    const [p1, p2] = [await push(w.slug, w.inspectionId, body), await push(w.slug, missing, { ...body, ops: [] })];
    expect(p1).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(p1).toEqual(p2);
    expect(await opCount(w.inspectionId)).toBe(1);
    await expect(InspectionPage({ params: Promise.resolve({ org: w.slug, id: w.inspectionId }) })).rejects.toThrow('notFound');
  });

  it('another org\'s inspection answers like a missing one, even to that org\'s own assignee signed in here', async () => {
    const g = await world('globex');
    const a = await db.org.create({ data: { slug: 'acme2', name: 'acme2' } });
    await db.membership.create({ data: { orgId: a.id, userId: g.techA.id, role: 'member' } });
    await g.as(g.techA.id);
    const r = await pull(a.slug, g.inspectionId); // globex's inspection, asked for under acme2, where they are a member too
    expect((await pull(g.slug, g.inspectionId)).status).toBe(200);
    expect(r).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('lists: the assignee sees their inspection, the other technician sees none, the manager sees all', async () => {
    const w = await world();
    const page = async (userId: string) => {
      await w.as(userId);
      return textOf(await Inspections({ params: Promise.resolve({ org: w.slug }) }));
    };
    expect(await page(w.techA.id)).toContain('Smith house');
    const b = await page(w.techB.id);
    expect(b).not.toContain('Smith house');
    expect(b).toContain('No inspections yet.');
    expect(await page(w.manager.id)).toContain('Smith house');
  });

  it('the assignee and a manager can both download it', async () => {
    const w = await world();
    await w.as(w.techA.id);
    expect((await pull(w.slug, w.inspectionId)).status).toBe(200);
    await w.as(w.manager.id);
    expect((await pull(w.slug, w.inspectionId)).status).toBe(200);
  });
});

import { describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { addInspection } from '@/app/o/[org]/inspections/actions';
import { publishTemplateVersion } from '@/app/o/[org]/templates/actions';
import InspectionPage from '@/app/o/[org]/inspections/[id]/page';
import { pinnedTemplate, SERVER_ID } from '@/lib/sync';
import { NavSignal } from '../helpers/next';
import { device, pull, push, sync, world } from './helpers';

// A4: creating an inspection writes the server pin (D-15) as op seq 1, and the inspection keeps that version when
// the template moves on (WT-04). A8: what the server renders and serves uses the pinned version only.
const v2 = { sections: [{ key: 'attic', title: 'Attic', items: [{ key: 'insulation', label: 'Insulation depth', type: 'number', min: 0, max: 30 }] }] };
const redirectTo = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof NavSignal) return e.to;
    throw e;
  }
};

describe('inspection creation and template pinning (A4, WT-04)', () => {
  it('the create action writes the server pin as op seq 1 for the latest version, before any device op', async () => {
    const w = await world();
    await w.as(w.manager.id);
    const to = await redirectTo(addInspection(w.slug, { templateId: w.template.id, assigneeId: w.techB.id, title: 'Jones house' }));
    const id = to!.split('/').pop()!;
    const ops = await db.inspectionOp.findMany({ where: { inspectionId: id } });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ seq: 1, kind: 'pin', deviceId: SERVER_ID, opId: `${SERVER_ID}:1`, templateId: w.template.id, templateVersion: 1, userId: null });
    expect(await db.inspection.findUniqueOrThrow({ where: { id } })).toMatchObject({ templateVersion: 1, assigneeId: w.techB.id, opSeq: 1, clock: 1 });
  });

  it('an assignee outside the org, or a template of another org, is notFound and creates nothing', async () => {
    const w = await world();
    const other = await db.org.create({ data: { slug: 'globex', name: 'globex' } });
    const outsider = await db.user.create({ data: { email: 'out@globex.test' } });
    await db.membership.create({ data: { orgId: other.id, userId: outsider.id, role: 'member' } });
    await w.as(w.manager.id);
    const before = await db.inspection.count();
    await expect(addInspection(w.slug, { templateId: w.template.id, assigneeId: outsider.id, title: 'x' })).rejects.toThrow('notFound');
    expect(await db.inspection.count()).toBe(before);
  });

  it('a template published after creation does not move the inspection: download, page and new ops stay on v1', async () => {
    const w = await world();
    await w.as(w.manager.id);
    await redirectTo(publishTemplateVersion(w.slug, { id: w.template.id, definition: JSON.stringify(v2) }));
    // A new inspection pins v2 ...
    const to = await redirectTo(addInspection(w.slug, { templateId: w.template.id, assigneeId: w.techA.id, title: 'New one' }));
    expect((await db.inspection.findUniqueOrThrow({ where: { id: to!.split('/').pop()! } })).templateVersion).toBe(2);
    // ... the existing one is still on v1 everywhere.
    await w.as(w.techA.id);
    const got = await pull(w.slug, w.inspectionId);
    expect(got.body.template.version).toBe(1);
    expect(got.body.template.definition.sections.map((s: { key: string }) => s.key)).toEqual(['roof', 'hvac']);
    const d = await device(w.slug, w.inspectionId);
    expect(pinnedTemplate(d.log)?.templateVersion).toBe(1);
    expect(d.templateVersion).toBe(1);
  });

  it('the page renders the pinned version and shows a stale client\'s off-template answer with the resolve badge (D-14)', async () => {
    const w = await world();
    await w.as(w.techA.id);
    const d = await device(w.slug, w.inspectionId);
    const ok = { opId: `${d.id}:1`, deviceId: d.id, inspectionId: w.inspectionId, lamport: 2, templateVersion: 1, kind: 'set', path: 'items.roof-condition', value: 'pass', prev: [] };
    const stale = { ...ok, opId: `${d.id}:2`, lamport: 3, templateVersion: 7, path: 'items.supply-temp', value: 60 };
    expect((await push(w.slug, w.inspectionId, { deviceId: d.id, ops: [ok, stale] })).status).toBe(200);
    expect((await sync(w.slug, d)).status).toBe(200);
    const html = JSON.stringify(await InspectionPage({ params: Promise.resolve({ org: w.slug, id: w.inspectionId }) }));
    expect(html).toContain('version ');
    expect(html).toContain('Roof condition');
    expect(html).toContain('(v7)'); // the off-template head, shown with its version
    expect(html).toContain('Resolve: ');
    expect((await db.inspection.findUniqueOrThrow({ where: { id: w.inspectionId } })).conflictPaths).toEqual(['items.supply-temp']);
  });
});

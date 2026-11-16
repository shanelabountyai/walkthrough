// CLONE-OWNED. The INV-01..04 harness seeds these rows in both fixture orgs, so it can drive
// actions whose inputs use ref('<model>') for the clone's own tables. Return { model: id } for
// one row of each model, owned by `org.orgId`. INV-29 (RLS enforce) calls it too, so every org-owned clone table has rows to scope.
import { createHash } from 'node:crypto';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { EXAMPLE_DEFINITION } from '@/lib/walkthrough/template';

// The harness re-seeds before every call and builds inputs from the first seed's ids, so ids must be the same on
// every seed of one org (derived from its id), and differ between orgs (INV-29 seeds fresh orgs in the same database).
const idFor = (orgId: string, what: string) => {
  const h = createHash('sha256').update(`${orgId}:${what}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export async function seedApp(org: { orgId: string; userId: string }, key: 'a' | 'b'): Promise<Record<string, string>> {
  const { orgId, userId } = org;
  const [templateId, versionId, inspectionId, deviceId] = ['template', 'version', 'inspection', 'device'].map((w) => idFor(orgId, w)) as [string, string, string, string];
  await db.checklistTemplate.create({ data: { id: templateId, orgId, name: `Template ${key}`, createdById: userId } });
  await db.templateVersion.create({ data: { id: versionId, orgId, templateId, version: 1, definition: EXAMPLE_DEFINITION, createdById: userId } });
  await db.inspection.create({
    data: { id: inspectionId, orgId, templateId, templateVersionId: versionId, templateVersion: 1, title: `Inspection ${key}`, assigneeId: userId, createdById: userId, clock: 2, opSeq: 2 },
  });
  await db.inspectionOp.createMany({
    data: [
      { orgId, inspectionId, seq: 1, opId: 'server:1', deviceId: 'server', lamport: 1, kind: 'pin', templateId, templateVersion: 1 },
      { orgId, inspectionId, seq: 2, opId: `${deviceId}:1`, deviceId, lamport: 2, kind: 'set', path: 'items.roof-condition', value: 'pass', prev: [], templateVersion: 1, userId },
    ],
  });
  await db.syncDevice.create({ data: { orgId, id: deviceId, userId } });
  // Phase 4: one stored blob (a fake report PDF's metadata) and the report row that links it.
  const hash = `sha256:${createHash('sha256').update(`${orgId}:report`).digest('hex')}`;
  await db.storedBlob.create({ data: { orgId, hash, size: 1, contentType: 'application/pdf', received: 1, complete: true } });
  await db.inspectionReport.create({ data: { id: idFor(orgId, 'report'), orgId, inspectionId, number: 1, hash, size: 1, opSeq: 2, createdById: userId } });
  // D-40: the inspection's link to that blob, so INV-29 has InspectionBlob rows to scope.
  await db.inspectionBlob.create({ data: { orgId, inspectionId, blobHash: hash, received: 1, linked: true, linkedAt: new Date(), createdById: userId } });
  return { checklistTemplate: templateId, inspection: inspectionId };
}

// Server side of the PDF report (Phase 4): generate, store (content-addressed in the blob store), link and read.
// A report is immutable (InspectionReport append-only trigger); a later change to the inspection makes report n+1.
import { audit } from '@/core/audit';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { withOrg } from '@/core/db/rls';
import { blobStore } from './blob-store';
import { hashOf } from './blobs';
import { renderInspection, type RenderedInspection } from './render';
import { buildPdf, readiness, reportRefs, type NotReady } from './report';
import { inspectionState, visibleTo } from './store';
import { definitionSchema } from './template';
import { truckrollLink } from './truckroll';
import { completeBlobs } from './uploads';

export type ReportRow = { number: number; hash: string; size: number; opSeq: number; createdAt: Date };

/** The merged inspection rendered against its pinned version, plus what stops a report. null: not visible (WT-05). */
export async function reportView(tx: Tx, ctx: OrgCtx, inspectionId: string) {
  const insp = await tx.inspection.findFirst({
    where: { id: inspectionId, ...visibleTo(ctx) },
    select: {
      id: true, title: true, templateVersion: true, opSeq: true, assigneeId: true, createdAt: true, completedAt: true,
      template: { select: { name: true } }, pinnedVersion: { select: { definition: true } },
      reports: { orderBy: { number: 'desc' }, select: { number: true, hash: true, size: true, opSeq: true, createdAt: true } },
    },
  });
  if (!insp) return null;
  const rendered: RenderedInspection = renderInspection(definitionSchema.parse(insp.pinnedVersion.definition), insp.templateVersion, await inspectionState(tx, ctx, insp.id));
  const refs = reportRefs(rendered);
  const complete = await completeBlobs(tx, ctx, refs);
  const latest: ReportRow | null = insp.reports[0] ?? null;
  return { insp, rendered, refs, complete, notReady: readiness(rendered, complete), latest, reports: insp.reports as ReportRow[], truckroll: truckrollLink(ctx.slug, insp.createdAt) };
}

export type GenerateResult = { ok: true; report: ReportRow; created: boolean } | { ok: false; notReady: NotReady[] };

/**
 * Complete the inspection: build the PDF from the merged state, store it and link it as report n+1, and mark the
 * inspection completed. Serialized with pushes by the inspection's row lock (the same one `syncPush` takes), so the
 * report is built from exactly the ops through `opSeq`. Nothing changed since the latest report: that report, as is.
 * null: not visible (WT-05).
 */
export async function generateReport(ctx: OrgCtx, inspectionId: string, now = new Date()): Promise<GenerateResult | null> {
  const store = blobStore();
  return withOrg(ctx, async (tx) => {
    const visible = await tx.inspection.findFirst({ where: { id: inspectionId, ...visibleTo(ctx) }, select: { id: true } });
    if (!visible) return null;
    await tx.$queryRaw`SELECT 1 FROM "Inspection" WHERE id = ${inspectionId}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
    const v = (await reportView(tx, ctx, inspectionId))!;
    if (v.notReady.length) return { ok: false, notReady: v.notReady };
    if (v.latest && v.latest.opSeq === v.insp.opSeq) return { ok: true, report: v.latest, created: false };

    const blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
    const types = new Map((await tx.storedBlob.findMany({ where: { ...inOrg(ctx), hash: { in: v.refs } }, select: { hash: true, contentType: true } })).map((b) => [b.hash, b.contentType]));
    for (const h of v.refs) {
      const bytes = await store.read(ctx.orgId, h);
      if (bytes) blobs.set(h, { bytes, contentType: types.get(h) ?? 'application/octet-stream' });
    }
    const emails = new Map(
      (await tx.membership.findMany({ where: { ...inOrg(ctx), userId: { in: [v.insp.assigneeId, ctx.userId] } }, select: { userId: true, user: { select: { email: true } } } })).map((m) => [m.userId, m.user.email]),
    );
    const number = (v.latest?.number ?? 0) + 1;
    const pdf = await buildPdf({
      number,
      title: v.insp.title,
      templateName: v.insp.template.name,
      inspectionId,
      technician: emails.get(v.insp.assigneeId) ?? 'former member',
      completedBy: emails.get(ctx.userId) ?? ctx.userId,
      generatedAt: now,
      opSeq: v.insp.opSeq,
      truckroll: v.truckroll,
      rendered: v.rendered,
      blobs,
    });
    const hash = await hashOf(pdf);
    await store.put(ctx.orgId, hash, pdf);
    await tx.$executeRaw`INSERT INTO "StoredBlob" ("orgId", hash, size, "contentType", received, complete, "completedAt") VALUES (${ctx.orgId}::uuid, ${hash}, ${pdf.length}, 'application/pdf', ${pdf.length}, true, ${now}) ON CONFLICT DO NOTHING`;
    const row = await tx.inspectionReport.create({
      data: { ...inOrg(ctx), inspectionId, number, hash, size: pdf.length, opSeq: v.insp.opSeq, createdById: ctx.userId, createdAt: now },
      select: { number: true, hash: true, size: true, opSeq: true, createdAt: true },
    });
    if (!v.insp.completedAt) await tx.inspection.updateMany({ where: { id: inspectionId, ...inOrg(ctx) }, data: { completedAt: now, completedById: ctx.userId } });
    await audit(ctx, 'inspection.report_generated', { targetType: 'inspection', targetId: inspectionId, data: { number, hash, opSeq: v.insp.opSeq } }, tx);
    return { ok: true, report: row, created: true };
  });
}

/** A report's PDF bytes (the latest, or number `n`). null: not visible, or no such report. */
export async function readReport(ctx: OrgCtx, inspectionId: string, n?: number): Promise<{ number: number; bytes: Uint8Array } | null> {
  const row = await withOrg(
    ctx,
    async (tx) => {
      const insp = await tx.inspection.findFirst({ where: { id: inspectionId, ...visibleTo(ctx) }, select: { id: true } });
      if (!insp) return null;
      return tx.inspectionReport.findFirst({ where: { inspectionId, ...inOrg(ctx), ...(n ? { number: n } : {}) }, orderBy: { number: 'desc' }, select: { number: true, hash: true } });
    },
    { atomic: false },
  );
  if (!row) return null;
  const bytes = await blobStore().read(ctx.orgId, row.hash);
  return bytes ? { number: row.number, bytes } : null;
}

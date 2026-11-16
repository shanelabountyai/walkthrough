import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { localSet } from '@/lib/sync';
import { diskStore, setBlobStore } from '@/lib/walkthrough/blob-store';
import { hashOf } from '@/lib/walkthrough/blobs';
import { uploadChunk } from '@/lib/walkthrough/uploads';
import { GET, POST } from '@/app/o/[org]/inspections/[id]/report/route';
import { BLUE_PNG, RED_JPEG } from './images';
import { APP, device, sync, world } from './helpers';

// C9 (docs/walkthrough/PHASE4_PLAN.md): completing an inspection stores and links its PDF report.
beforeAll(async () => setBlobStore(diskStore(await mkdtemp(path.join(tmpdir(), 'wt-report-int-')))));

const params = (org: string, id: string) => ({ params: Promise.resolve({ org, id }) });
async function complete(slug: string, id: string, headers: Record<string, string> = {}) {
  const res = await POST(new Request(`${APP}/o/${slug}/inspections/${id}/report`, { method: 'POST', headers: { host: 'localhost:8200', origin: APP, 'content-type': 'application/json', ...headers }, body: '{}' }), params(slug, id));
  return { status: res.status, body: await res.json() };
}
async function pdf(slug: string, id: string, n?: number) {
  const res = await GET(new Request(`${APP}/o/${slug}/inspections/${id}/report${n ? `?n=${n}` : ''}`, { headers: { host: 'localhost:8200' } }), params(slug, id));
  return { status: res.status, type: res.headers.get('content-type'), bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** Tech A answers every required item (photo and signature included) and syncs; the blobs upload unless `skipUpload`. */
async function filled(skipUpload = false) {
  const w = await world();
  const ctx = await w.as(w.techA.id);
  const d = await device(w.slug, w.inspectionId);
  const [photo, sig] = [await hashOf(RED_JPEG), await hashOf(BLUE_PNG)];
  localSet(d, 'items.roof-condition', 'pass');
  localSet(d, 'items.roof-photo', [photo]);
  localSet(d, 'items.supply-temp', 61);
  localSet(d, 'items.customer-signature', sig);
  expect((await sync(w.slug, d)).status).toBe(200);
  if (!skipUpload) {
    await uploadChunk(ctx, w.inspectionId, photo, { offset: 0, length: RED_JPEG.length, type: 'image/jpeg', bytes: RED_JPEG });
    await uploadChunk(ctx, w.inspectionId, sig, { offset: 0, length: BLUE_PNG.length, type: 'image/png', bytes: BLUE_PNG });
  }
  return { ...w, d, photo, sig };
}

describe('the report endpoint (C9)', () => {
  it('not ready → 409 naming each reason; nothing is stored and the inspection stays open', async () => {
    const w = await filled(true);
    const r = await complete(w.slug, w.inspectionId);
    expect(r.status).toBe(409);
    expect(r.body.notReady.map((x: { path: string; why: string }) => [x.path, x.why])).toEqual([['items.roof-photo', 'uploading'], ['items.customer-signature', 'uploading']]);
    expect(r.body.notReady[0].message).toBe('Photo of the roof has a photo or signature still uploading');
    expect(await db.inspectionReport.count({ where: { inspectionId: w.inspectionId } })).toBe(0);
    expect((await db.inspection.findUniqueOrThrow({ where: { id: w.inspectionId } })).completedAt).toBeNull();
    expect((await pdf(w.slug, w.inspectionId)).status).toBe(404);
  });

  it('ready → report 1 stored and linked, the inspection completed and audited; the PDF holds the photo and signature', async () => {
    const w = await filled();
    const r = await complete(w.slug, w.inspectionId);
    expect(r).toMatchObject({ status: 200, body: { number: 1, created: true, opSeq: 5, url: `/o/acme/inspections/${w.inspectionId}/report?n=1` } });
    const row = await db.inspectionReport.findFirstOrThrow({ where: { inspectionId: w.inspectionId } });
    expect(row).toMatchObject({ number: 1, opSeq: 5, createdById: w.techA.id });
    const insp = await db.inspection.findUniqueOrThrow({ where: { id: w.inspectionId } });
    expect(insp.completedAt).not.toBeNull();
    expect(insp.completedById).toBe(w.techA.id);
    expect(await db.auditEvent.count({ where: { action: 'inspection.report_generated', targetId: w.inspectionId } })).toBe(1);
    const got = await pdf(w.slug, w.inspectionId);
    expect(got).toMatchObject({ status: 200, type: 'application/pdf' });
    expect(await hashOf(got.bytes)).toBe(row.hash); // stored content-addressed
    expect((await PDFDocument.load(got.bytes)).getTitle()).toBe('Smith house — inspection report 1');
    expect(Buffer.from(got.bytes).toString('latin1').match(/\/Subtype \/Image/g)).toHaveLength(2);
  });

  it('nothing changed → the same report; a later answer → report 2, and report 1 is still there unchanged', async () => {
    const w = await filled();
    const first = await complete(w.slug, w.inspectionId);
    expect((await complete(w.slug, w.inspectionId)).body).toMatchObject({ number: 1, created: false });
    localSet(w.d, 'items.hvac-notes', 'filter replaced');
    await sync(w.slug, w.d);
    await w.as(w.manager.id); // a manager may complete it too
    expect((await complete(w.slug, w.inspectionId)).body).toMatchObject({ number: 2, created: true, opSeq: 6 });
    const one = await pdf(w.slug, w.inspectionId, 1);
    expect(await hashOf(one.bytes)).toBe((await db.inspectionReport.findFirstOrThrow({ where: { inspectionId: w.inspectionId, number: 1 } })).hash);
    expect((await pdf(w.slug, w.inspectionId)).bytes).not.toEqual(one.bytes);
    expect(first.body.number).toBe(1);
  });

  it('report rows are append-only in the database', async () => {
    const w = await filled();
    await complete(w.slug, w.inspectionId);
    await expect(db.inspectionReport.updateMany({ where: { inspectionId: w.inspectionId }, data: { number: 9 } })).rejects.toThrow(/immutable/);
  });

  it('WT-05: a technician not assigned gets the same 404 as a missing id; cross-site posts are refused', async () => {
    const w = await filled();
    expect((await complete(w.slug, w.inspectionId, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await complete(w.slug, w.inspectionId, { 'content-type': 'text/plain' })).status).toBe(415);
    await complete(w.slug, w.inspectionId);
    await w.as(w.techB.id);
    expect((await complete(w.slug, w.inspectionId)).status).toBe(404);
    expect((await pdf(w.slug, w.inspectionId)).status).toBe(404);
    expect((await pdf(w.slug, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('a conflict blocks the report until it is resolved (WT-03: no silent pick)', async () => {
    const w = await filled();
    const b = await device(w.slug, w.inspectionId);
    localSet(w.d, 'items.roof-condition', 'fail'); // two devices, concurrently
    localSet(b, 'items.roof-condition', 'na');
    await sync(w.slug, w.d);
    await sync(w.slug, b);
    expect((await complete(w.slug, w.inspectionId)).body.notReady.map((x: { why: string }) => x.why)).toEqual(['conflict']);
    await sync(w.slug, w.d);
    localSet(w.d, 'items.roof-condition', 'fail'); // seen both: supersedes them
    await sync(w.slug, w.d);
    expect((await complete(w.slug, w.inspectionId)).status).toBe(200);
  });
});

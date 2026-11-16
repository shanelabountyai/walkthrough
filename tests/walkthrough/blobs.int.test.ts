import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { localSet } from '@/lib/sync';
import { diskStore, setBlobStore, type BlobStore } from '@/lib/walkthrough/blob-store';
import { hashOf } from '@/lib/walkthrough/blobs';
import { createInspectionRecord } from '@/lib/walkthrough/store';
import { GET, POST } from '@/app/o/[org]/inspections/[id]/blobs/[hash]/route';
import { beforeOrgDelete } from '@/app/org-hooks';
import { BLUE_PNG, RED_JPEG } from './images';
import { APP, device, sync, world } from './helpers';

// C2–C4, C11 (docs/walkthrough/PHASE4_PLAN.md): chunked, resumable, content-hashed uploads through an inspection.
let store: BlobStore;
beforeAll(async () => {
  store = diskStore(await mkdtemp(path.join(tmpdir(), 'wt-blobs-int-')));
  setBlobStore(store);
});

const params = (org: string, id: string, hash: string) => ({ params: Promise.resolve({ org, id, hash }) });
const url = (slug: string, id: string, hash: string, q = '') => `${APP}/o/${slug}/inspections/${id}/blobs/${hash}${q}`;

async function status(slug: string, id: string, hash: string) {
  const res = await GET(new Request(url(slug, id, hash, '?status'), { headers: { host: 'localhost:8200' } }), params(slug, id, hash));
  return { status: res.status, body: await res.json() };
}
async function download(slug: string, id: string, hash: string) {
  const res = await GET(new Request(url(slug, id, hash), { headers: { host: 'localhost:8200' } }), params(slug, id, hash));
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}
async function chunk(slug: string, id: string, hash: string, bytes: Uint8Array, offset: number, length: number, type = 'image/jpeg', headers: Record<string, string> = {}) {
  const res = await POST(
    new Request(url(slug, id, hash), {
      method: 'POST',
      headers: { host: 'localhost:8200', origin: APP, 'content-type': 'application/octet-stream', 'x-upload-offset': String(offset), 'x-upload-length': String(length), 'x-blob-type': type, ...headers },
      body: bytes as BodyInit,
    }),
    params(slug, id, hash),
  );
  return { status: res.status, body: await res.json() };
}
/** Upload `bytes` in `size`-byte chunks from `from`. */
async function upload(slug: string, id: string, hash: string, bytes: Uint8Array, size = 256, from = 0, type = 'image/jpeg') {
  let last;
  for (let o = from; o < bytes.length; o += size) last = await chunk(slug, id, hash, bytes.slice(o, o + size), o, bytes.length, type);
  return last!;
}

/** A world where tech A answered the roof photo with `bytes`' hash and synced the op (ops go before blobs). */
async function answered(bytes = RED_JPEG, slug = 'acme') {
  const w = await world(slug);
  await w.as(w.techA.id);
  const d = await device(w.slug, w.inspectionId);
  const hash = await hashOf(bytes);
  localSet(d, 'items.roof-photo', [hash]);
  expect((await sync(w.slug, d)).status).toBe(200);
  return { ...w, d, hash };
}

describe('chunked, resumable upload (C2)', () => {
  it('uploads in chunks; an interrupted upload resumes from what the server holds; the blob reads back byte-identical', async () => {
    const w = await answered();
    expect((await status(w.slug, w.inspectionId, w.hash)).body).toEqual({ state: 'missing', received: 0, size: null });
    expect((await chunk(w.slug, w.inspectionId, w.hash, RED_JPEG.slice(0, 256), 0, RED_JPEG.length)).body).toEqual({ state: 'partial', received: 256, size: RED_JPEG.length });
    // the connection drops; the device asks where to resume
    expect((await status(w.slug, w.inspectionId, w.hash)).body).toEqual({ state: 'partial', received: 256, size: RED_JPEG.length });
    const wrong = await chunk(w.slug, w.inspectionId, w.hash, RED_JPEG.slice(512, 600), 512, RED_JPEG.length);
    expect(wrong).toMatchObject({ status: 409, body: { error: 'offset', received: 256 } });
    const done = await upload(w.slug, w.inspectionId, w.hash, RED_JPEG, 256, 256);
    expect(done.body).toEqual({ state: 'complete', received: RED_JPEG.length, size: RED_JPEG.length });
    const got = await download(w.slug, w.inspectionId, w.hash);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(got.bytes).equals(Buffer.from(RED_JPEG))).toBe(true);
  });

  it('a re-sent chunk after a lost response is refused with the offset to continue from (no duplicate bytes)', async () => {
    const w = await answered();
    await chunk(w.slug, w.inspectionId, w.hash, RED_JPEG.slice(0, 300), 0, RED_JPEG.length);
    expect(await chunk(w.slug, w.inspectionId, w.hash, RED_JPEG.slice(0, 300), 0, RED_JPEG.length)).toMatchObject({ status: 409, body: { received: 300 } });
    expect((await upload(w.slug, w.inspectionId, w.hash, RED_JPEG, 300, 300)).body.state).toBe('complete');
  });

  it('bytes that do not hash to the name are refused at the last chunk, and nothing is kept', async () => {
    const w = await answered();
    const forged = RED_JPEG.slice();
    forged[forged.length - 3] = forged[forged.length - 3]! ^ 0xff;
    const r = await upload(w.slug, w.inspectionId, w.hash, forged);
    expect(r).toMatchObject({ status: 422, body: { error: 'hash-mismatch', received: 0 } });
    expect((await status(w.slug, w.inspectionId, w.hash)).body).toMatchObject({ state: 'missing', received: 0 });
    expect(await store.partial(w.org.id, w.hash)).toHaveLength(0);
    expect((await download(w.slug, w.inspectionId, w.hash)).status).toBe(404);
    expect((await upload(w.slug, w.inspectionId, w.hash, RED_JPEG)).body.state).toBe('complete'); // the real bytes still go up
  });

  it('the declared type must be what the bytes are (no HTML served as an image)', async () => {
    const w = await answered(BLUE_PNG);
    expect(await upload(w.slug, w.inspectionId, w.hash, BLUE_PNG, 1024, 0, 'image/jpeg')).toMatchObject({ status: 422, body: { error: 'type-mismatch' } });
    expect((await upload(w.slug, w.inspectionId, w.hash, BLUE_PNG, 1024, 0, 'image/png')).body.state).toBe('complete');
    expect((await chunk(w.slug, w.inspectionId, w.hash, BLUE_PNG, 0, BLUE_PNG.length, 'text/html')).status).toBe(400);
  });

  it('refuses cross-site posts, form content types and oversized chunks', async () => {
    const w = await answered();
    expect((await chunk(w.slug, w.inspectionId, w.hash, RED_JPEG, 0, RED_JPEG.length, 'image/jpeg', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await chunk(w.slug, w.inspectionId, w.hash, RED_JPEG, 0, RED_JPEG.length, 'image/jpeg', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await chunk(w.slug, w.inspectionId, w.hash, new Uint8Array(1024 * 1024 + 1), 0, 2 * 1024 * 1024)).status).toBe(413);
    expect((await chunk(w.slug, w.inspectionId, w.hash, RED_JPEG, 0, 16 * 1024 * 1024)).status).toBe(413);
    expect((await chunk(w.slug, w.inspectionId, w.hash, RED_JPEG, 10, RED_JPEG.length)).status).toBe(400); // past the end
  });
});

describe('dedupe (C3)', () => {
  it('the same bytes on a second inspection are already complete: nothing is re-sent, and both read them', async () => {
    const w = await answered();
    await upload(w.slug, w.inspectionId, w.hash, RED_JPEG);
    const mctx = await w.as(w.manager.id);
    const { id: second } = await createInspectionRecord(mctx, { templateId: w.template.id, assigneeId: w.techA.id, title: 'Jones house' });
    await w.as(w.techA.id);
    const d2 = await device(w.slug, second);
    localSet(d2, 'items.roof-photo', [w.hash]);
    await sync(w.slug, d2);
    expect((await status(w.slug, second, w.hash)).body).toEqual({ state: 'complete', received: RED_JPEG.length, size: RED_JPEG.length });
    expect((await chunk(w.slug, second, w.hash, RED_JPEG.slice(0, 10), 0, RED_JPEG.length)).body.state).toBe('complete'); // takes nothing more
    expect((await download(w.slug, second, w.hash)).status).toBe(200);
    expect(await db.storedBlob.count({ where: { orgId: w.org.id } })).toBe(1);
  });
});

describe('who can reach a blob (C4, WT-05)', () => {
  it('a technician not assigned, a hash the log does not name, and another org all get the same 404, and nothing is stored', async () => {
    const w = await answered();
    await upload(w.slug, w.inspectionId, w.hash, RED_JPEG);
    await w.as(w.techB.id); // not assigned
    expect((await status(w.slug, w.inspectionId, w.hash)).status).toBe(404);
    expect((await download(w.slug, w.inspectionId, w.hash)).status).toBe(404);
    expect((await chunk(w.slug, w.inspectionId, w.hash, RED_JPEG, 0, RED_JPEG.length)).status).toBe(404);
    await w.as(w.manager.id); // a manager sees every inspection in the org
    expect((await download(w.slug, w.inspectionId, w.hash)).status).toBe(200);
    await w.as(w.techA.id);
    const unnamed = await hashOf(BLUE_PNG);
    expect((await chunk(w.slug, w.inspectionId, unnamed, BLUE_PNG, 0, BLUE_PNG.length, 'image/png')).status).toBe(404);
    expect(await db.storedBlob.count({ where: { hash: unnamed } })).toBe(0);
    expect((await status(w.slug, w.inspectionId, 'sha256:nothex')).status).toBe(404);
  });
});

describe('org deletion (C11)', () => {
  it('beforeOrgDelete removes the org’s blob bytes', async () => {
    const w = await answered();
    await upload(w.slug, w.inspectionId, w.hash, RED_JPEG);
    expect(await store.read(w.org.id, w.hash)).not.toBeNull();
    await beforeOrgDelete(w.org.id);
    expect(await store.read(w.org.id, w.hash)).toBeNull();
  });
});

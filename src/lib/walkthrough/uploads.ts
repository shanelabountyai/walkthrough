// Server side of photo and signature uploads (Phase 4, docs/walkthrough/PHASE4_PLAN.md). A blob is content-addressed
// per org (StoredBlob, `orgId + hash`), uploaded in chunks at an offset, resumable from the row's `received`, and
// checked when the last byte arrives: the sha256 must be the name, and the bytes must be the declared image type.
// Every call goes through an inspection the user can see (WT-05) whose op log names the hash, so a blob is only ever
// reachable through an answer, and nothing unreferenced is stored. Ops sync before blobs (the device does that).
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { withOrg } from '@/core/db/rls';
import { blobStore } from './blob-store';
import { hashOf, isHash, isUploadType, MAX_BLOB_BYTES, MAX_CHUNK_BYTES, sniff } from './blobs';
import { visibleTo } from './store';

export type BlobStatus = { state: 'missing' | 'partial' | 'complete'; received: number; size: number | null };

export class UploadRefused extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 422,
    readonly code: string,
    message: string,
    readonly received?: number,
  ) {
    super(message);
  }
}

/** Whether a `set` op in this inspection's log names `hash` (a signature value, or one entry of a photo list). */
export async function referenced(tx: Tx, ctx: OrgCtx, inspectionId: string, hash: string): Promise<boolean> {
  const hit = await tx.inspectionOp.findFirst({
    where: { inspectionId, ...inOrg(ctx), kind: 'set', OR: [{ value: { equals: hash } }, { value: { array_contains: [hash] } }] },
    select: { id: true },
  });
  return !!hit;
}

/** The inspection is visible to this user (WT-05) and its log names the hash. False reads exactly like a missing id. */
async function reachable(tx: Tx, ctx: OrgCtx, inspectionId: string, hash: string) {
  if (!isHash(hash)) return false;
  const insp = await tx.inspection.findFirst({ where: { id: inspectionId, ...visibleTo(ctx) }, select: { id: true } });
  return !!insp && (await referenced(tx, ctx, inspectionId, hash));
}

const statusOf = (row: { size: number; received: number; complete: boolean } | null): BlobStatus =>
  !row ? { state: 'missing', received: 0, size: null } : { state: row.complete ? 'complete' : row.received ? 'partial' : 'missing', received: row.complete ? row.size : row.received, size: row.size };

/** How much of a blob the server holds. null: not reachable for this user (404). */
export async function blobStatus(ctx: OrgCtx, inspectionId: string, hash: string): Promise<BlobStatus | null> {
  return withOrg(
    ctx,
    async (tx) => {
      if (!(await reachable(tx, ctx, inspectionId, hash))) return null;
      return statusOf(await tx.storedBlob.findUnique({ where: { orgId_hash: { orgId: ctx.orgId, hash } }, select: { size: true, received: true, complete: true } }));
    },
    { atomic: false },
  );
}

export type Chunk = { offset: number; length: number; type: string; bytes: Uint8Array };

/**
 * Append one chunk. Serialized per blob by a row lock. A complete blob takes nothing more (dedupe: the answer is
 * "complete" whatever was sent). A chunk at the wrong offset is refused with the offset the server wants (409), so a
 * device resumes from there. The last chunk triggers the checks; a failed check drops the partial bytes and resets the
 * row (the device starts over), and is reported as `{ refused }` so that reset commits. null: not reachable (404).
 */
export async function uploadChunk(ctx: OrgCtx, inspectionId: string, hash: string, c: Chunk): Promise<BlobStatus | { refused: UploadRefused } | null> {
  if (!isUploadType(c.type)) throw new UploadRefused(400, 'bad-type', 'only JPEG, PNG and WebP images upload');
  if (!Number.isInteger(c.length) || c.length < 1 || c.length > MAX_BLOB_BYTES) throw new UploadRefused(413, 'too-large', `a blob is 1 byte to ${MAX_BLOB_BYTES} bytes`);
  if (c.bytes.length < 1 || c.bytes.length > MAX_CHUNK_BYTES) throw new UploadRefused(413, 'bad-chunk', `a chunk is 1 byte to ${MAX_CHUNK_BYTES} bytes`);
  if (!Number.isInteger(c.offset) || c.offset < 0 || c.offset + c.bytes.length > c.length) throw new UploadRefused(400, 'bad-offset', 'the chunk does not fit the declared length');
  const store = blobStore();
  return withOrg(ctx, async (tx) => {
    if (!(await reachable(tx, ctx, inspectionId, hash))) return null;
    await tx.$executeRaw`INSERT INTO "StoredBlob" ("orgId", hash, size, "contentType", "createdById") VALUES (${ctx.orgId}::uuid, ${hash}, ${c.length}, ${c.type}, ${ctx.userId}::uuid) ON CONFLICT DO NOTHING`;
    const [row] = await tx.$queryRaw<{ size: number; contentType: string; received: number; complete: boolean }[]>`
      SELECT size, "contentType", received, complete FROM "StoredBlob" WHERE "orgId" = ${ctx.orgId}::uuid AND hash = ${hash} FOR UPDATE`;
    if (!row) throw new Error('StoredBlob row vanished');
    if (row.complete) return statusOf(row);
    const where = { orgId_hash: { orgId: ctx.orgId, hash } };
    if (row.size !== c.length || row.contentType !== c.type) {
      // An unfinished upload declared another length or type: the hash fixes the content, so one of them is wrong.
      // Start over with this one; the final hash check decides.
      await store.discard(ctx.orgId, hash);
      await tx.storedBlob.update({ where, data: { size: c.length, contentType: c.type, received: 0 } });
      row.received = 0;
    }
    if (c.offset !== row.received) throw new UploadRefused(409, 'offset', `the server has ${row.received} bytes; send from there`, row.received);
    await store.writeAt(ctx.orgId, hash, c.offset, c.bytes);
    const received = c.offset + c.bytes.length;
    if (received < c.length) {
      await tx.storedBlob.update({ where, data: { received } });
      return { state: 'partial' as const, received, size: c.length };
    }
    const bytes = await store.partial(ctx.orgId, hash);
    const fail = (code: string, message: string) => ({ refused: new UploadRefused(422, code, message, 0) });
    let problem: ReturnType<typeof fail> | null = null;
    if (bytes.length !== c.length || (await hashOf(bytes)) !== hash) problem = fail('hash-mismatch', 'the bytes do not match the hash they were uploaded under');
    else if (sniff(bytes) !== c.type) problem = fail('type-mismatch', `the bytes are not ${c.type}`);
    if (problem) {
      await store.discard(ctx.orgId, hash);
      await tx.storedBlob.update({ where, data: { received: 0 } });
      return problem;
    }
    await store.commit(ctx.orgId, hash);
    await tx.storedBlob.update({ where, data: { received, complete: true, completedAt: new Date() } });
    return { state: 'complete' as const, received, size: c.length };
  });
}

/** A complete blob's bytes, through an inspection the user can see that names it. null: 404. */
export async function readBlob(ctx: OrgCtx, inspectionId: string, hash: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const row = await withOrg(
    ctx,
    async (tx) => {
      if (!(await reachable(tx, ctx, inspectionId, hash))) return null;
      return tx.storedBlob.findFirst({ where: { orgId: ctx.orgId, hash, complete: true }, select: { contentType: true } });
    },
    { atomic: false },
  );
  if (!row) return null;
  const bytes = await blobStore().read(ctx.orgId, hash);
  return bytes ? { bytes, contentType: row.contentType } : null;
}

/** The complete blobs among `hashes` (report readiness). */
export async function completeBlobs(tx: Tx, ctx: OrgCtx, hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  const rows = await tx.storedBlob.findMany({ where: { ...inOrg(ctx), hash: { in: hashes }, complete: true }, select: { hash: true } });
  return new Set(rows.map((r) => r.hash));
}

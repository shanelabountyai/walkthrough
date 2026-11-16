// Server side of photo and signature uploads (Phase 4, docs/walkthrough/PHASE4_PLAN.md). A blob is content-addressed
// per org (StoredBlob, `orgId + hash`), uploaded in chunks at an offset, resumable from the row's `received`, and
// checked when the last byte arrives: the sha256 must be the name, and the bytes must be the declared image type.
// Every call goes through an inspection the user can see (WT-05) whose op log names the hash, so nothing unreferenced
// is stored. Ops sync before blobs (the device does that).
// D-40 (review fix 2026-11-16): naming a hash is not access. An inspection reads or attaches a blob only through its
// own InspectionBlob link, written when bytes uploaded through that inspection complete the blob or — when the org
// already holds it (dedupe) — match the stored bytes chunk by chunk. A `set` naming a hash the inspection has no link
// for is stored (WT-01) but stays inert: the bytes 404 and the report waits ("uploading") until the device sends them.
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

/** Whether a `set` op in this inspection's log names `hash` (a signature value or its `image`, or one entry of a photo list). */
export async function referenced(tx: Tx, ctx: OrgCtx, inspectionId: string, hash: string): Promise<boolean> {
  const hit = await tx.inspectionOp.findFirst({
    where: {
      inspectionId,
      ...inOrg(ctx),
      kind: 'set',
      OR: [{ value: { equals: hash } }, { value: { array_contains: [hash] } }, { value: { path: ['image'], equals: hash } }],
    },
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

type BlobRow = { size: number; contentType: string; received: number; complete: boolean };
type LinkRow = { received: number; linked: boolean };

/**
 * What this inspection holds of a blob (D-40). Linked and complete: complete. The org holds it but this inspection has
 * not proved it: this inspection's own progress. Partial: the shared partial counts only if this inspection sent every
 * byte of it (otherwise its upload starts over at 0 and takes the partial over).
 */
function statusFor(blob: BlobRow | null, link: LinkRow | null): BlobStatus {
  const missing: BlobStatus = { state: 'missing', received: 0, size: null };
  if (!blob) return missing;
  if (blob.complete) {
    if (link?.linked) return { state: 'complete', received: blob.size, size: blob.size };
    return link?.received ? { state: 'partial', received: link.received, size: blob.size } : missing;
  }
  return link && blob.received > 0 && link.received === blob.received ? { state: 'partial', received: blob.received, size: blob.size } : missing;
}

const findLink = (tx: Tx, ctx: OrgCtx, inspectionId: string, hash: string) =>
  tx.inspectionBlob.findFirst({ where: { inspectionId, blobHash: hash, ...inOrg(ctx) }, select: { received: true, linked: true } });

/** How much of a blob this inspection holds. null: not reachable for this user (404). */
export async function blobStatus(ctx: OrgCtx, inspectionId: string, hash: string): Promise<BlobStatus | null> {
  return withOrg(
    ctx,
    async (tx) => {
      if (!(await reachable(tx, ctx, inspectionId, hash))) return null;
      const blob = await tx.storedBlob.findUnique({ where: { orgId_hash: { orgId: ctx.orgId, hash } }, select: { size: true, contentType: true, received: true, complete: true } });
      return statusFor(blob, await findLink(tx, ctx, inspectionId, hash));
    },
    { atomic: false },
  );
}

export type Chunk = { offset: number; length: number; type: string; bytes: Uint8Array };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Append one chunk. Serialized per blob by row locks (StoredBlob, then this inspection's link). A chunk at the wrong
 * offset is refused with the offset the server wants (409), so a device resumes from there. The last chunk triggers
 * the checks; a failed check drops this upload's progress (the device starts over), reported as `{ refused }` so that
 * reset commits. null: not reachable (404).
 *  - The org does not hold the blob yet: the bytes go to the shared partial, and completing it links this inspection.
 *  - The org holds it, this inspection is linked: nothing more is taken.
 *  - The org holds it, this inspection is not linked (D-40): each chunk must equal the stored bytes at its offset; the
 *    last one links the inspection. The device sends exactly what it would have for a fresh upload.
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
    const [row] = await tx.$queryRaw<BlobRow[]>`
      SELECT size, "contentType", received, complete FROM "StoredBlob" WHERE "orgId" = ${ctx.orgId}::uuid AND hash = ${hash} FOR UPDATE`;
    if (!row) throw new Error('StoredBlob row vanished');
    await tx.$executeRaw`INSERT INTO "InspectionBlob" ("orgId", "inspectionId", "blobHash", "createdById") VALUES (${ctx.orgId}::uuid, ${inspectionId}::uuid, ${hash}, ${ctx.userId}::uuid) ON CONFLICT DO NOTHING`;
    const [link] = await tx.$queryRaw<LinkRow[]>`
      SELECT received, linked FROM "InspectionBlob" WHERE "inspectionId" = ${inspectionId}::uuid AND "blobHash" = ${hash} FOR UPDATE`;
    if (!link) throw new Error('InspectionBlob row vanished');
    const where = { orgId_hash: { orgId: ctx.orgId, hash } };
    const linkWhere = { inspectionId_blobHash: { inspectionId, blobHash: hash } };
    const fail = (code: string, message: string) => ({ refused: new UploadRefused(422, code, message, 0) });

    if (row.complete) {
      if (link.linked) return statusFor(row, link);
      // D-40: the org holds these bytes; this inspection gets them only by sending the same bytes.
      if (c.length !== row.size || c.type !== row.contentType || (c.offset === link.received && !sameBytes(await storedSlice(store, ctx.orgId, hash, c.offset, c.bytes.length), c.bytes))) {
        await tx.inspectionBlob.update({ where: linkWhere, data: { received: 0 } });
        return c.type !== row.contentType && c.length === row.size ? fail('type-mismatch', `the bytes are not ${c.type}`) : fail('hash-mismatch', 'the bytes do not match the hash they were uploaded under');
      }
      if (c.offset !== link.received) throw new UploadRefused(409, 'offset', `the server has ${link.received} bytes; send from there`, link.received);
      const received = c.offset + c.bytes.length;
      const linked = received === row.size;
      await tx.inspectionBlob.update({ where: linkWhere, data: { received, ...(linked ? { linked: true, linkedAt: new Date() } : {}) } });
      return statusFor(row, { received, linked });
    }

    if (link.received !== row.received) {
      // The shared partial holds bytes this inspection did not send: it may only start over, and then takes it over.
      if (c.offset !== 0) throw new UploadRefused(409, 'offset', 'the server has 0 bytes from this inspection; send from there', 0);
      await store.discard(ctx.orgId, hash);
      await tx.storedBlob.update({ where, data: { size: c.length, contentType: c.type, received: 0 } });
      Object.assign(row, { size: c.length, contentType: c.type, received: 0 });
    }
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
      await tx.inspectionBlob.update({ where: linkWhere, data: { received } });
      return { state: 'partial' as const, received, size: c.length };
    }
    const bytes = await store.partial(ctx.orgId, hash);
    let problem: ReturnType<typeof fail> | null = null;
    if (bytes.length !== c.length || (await hashOf(bytes)) !== hash) problem = fail('hash-mismatch', 'the bytes do not match the hash they were uploaded under');
    else if (sniff(bytes) !== c.type) problem = fail('type-mismatch', `the bytes are not ${c.type}`);
    if (problem) {
      await store.discard(ctx.orgId, hash);
      await tx.storedBlob.update({ where, data: { received: 0 } });
      await tx.inspectionBlob.update({ where: linkWhere, data: { received: 0 } });
      return problem;
    }
    await store.commit(ctx.orgId, hash);
    const now = new Date();
    await tx.storedBlob.update({ where, data: { received, complete: true, completedAt: now } });
    await tx.inspectionBlob.update({ where: linkWhere, data: { received, linked: true, linkedAt: now } });
    return { state: 'complete' as const, received, size: c.length };
  });
}

/** `length` stored bytes of a complete blob from `offset` (the D-40 proof compares a chunk with them). */
async function storedSlice(store: ReturnType<typeof blobStore>, orgId: string, hash: string, offset: number, length: number): Promise<Uint8Array> {
  const all = await store.read(orgId, hash);
  if (!all) throw new BlobBytesMissing([hash]);
  return all.subarray(offset, offset + length);
}

/** A blob the database marks complete has no bytes in the blob store (lost or deleted storage): a server fault. */
export class BlobBytesMissing extends Error {
  constructor(readonly hashes: string[]) {
    super(`the blob store has no bytes for ${hashes.length === 1 ? 'a blob' : `${hashes.length} blobs`} the database marks complete: ${hashes.join(', ')}`);
  }
}

/** A complete blob's bytes, through an inspection the user can see that is linked to it (D-40). null: 404. */
export async function readBlob(ctx: OrgCtx, inspectionId: string, hash: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const row = await withOrg(
    ctx,
    async (tx) => {
      if (!isHash(hash)) return null;
      const insp = await tx.inspection.findFirst({ where: { id: inspectionId, ...visibleTo(ctx) }, select: { id: true } });
      if (!insp) return null;
      if (!(await findLink(tx, ctx, inspectionId, hash))?.linked) return null;
      return tx.storedBlob.findFirst({ where: { orgId: ctx.orgId, hash, complete: true }, select: { contentType: true } });
    },
    { atomic: false },
  );
  if (!row) return null;
  const bytes = await blobStore().read(ctx.orgId, hash);
  return bytes ? { bytes, contentType: row.contentType } : null;
}

/** The blobs among `hashes` that are complete and linked to this inspection (report readiness, D-40). */
export async function completeBlobs(tx: Tx, ctx: OrgCtx, inspectionId: string, hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  const links = await tx.inspectionBlob.findMany({ where: { ...inOrg(ctx), inspectionId, blobHash: { in: hashes }, linked: true }, select: { blobHash: true } });
  if (!links.length) return new Set();
  const rows = await tx.storedBlob.findMany({ where: { ...inOrg(ctx), hash: { in: links.map((l) => l.blobHash) }, complete: true }, select: { hash: true } });
  return new Set(rows.map((r) => r.hash));
}

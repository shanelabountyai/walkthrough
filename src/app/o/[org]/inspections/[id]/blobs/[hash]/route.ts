import { z } from 'zod';
import { requireOrg } from '@/core/authz/guards';
import { isSameOrigin } from '@/core/http';
import { isHash, MAX_CHUNK_BYTES } from '@/lib/walkthrough/blobs';
import { BlobStoreUnavailable } from '@/lib/walkthrough/blob-store';
import { blobStatus, readBlob, uploadChunk, UploadRefused } from '@/lib/walkthrough/uploads';

export const dynamic = 'force-dynamic';

// Photo and signature blobs of one inspection (Phase 4, docs/walkthrough/PHASE4_PLAN.md). Session cookie and
// requireOrg first, like the sync endpoint. GET ?status → how much the server holds; GET → the bytes; POST → one chunk.
// An inspection the user may not see (WT-05), another org's id, a missing id and a hash its log does not name all get
// the same 404.
type Params = { params: Promise<{ org: string; id: string; hash: string }> };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const NOT_FOUND = () => json({ error: 'not_found' }, 404);
const int = (v: string | null) => (v !== null && /^\d{1,10}$/.test(v) ? Number(v) : NaN);

async function target(p: Params['params']) {
  const { id, hash } = await p;
  const uuid = z.uuid().safeParse(id);
  const h = decodeURIComponent(hash);
  return { id: uuid.success ? uuid.data : null, hash: isHash(h) ? h : null };
}

export async function GET(req: Request, { params }: Params) {
  const ctx = await requireOrg((await params).org);
  const { id, hash } = await target(params);
  if (!id || !hash) return NOT_FOUND();
  try {
    if (new URL(req.url).searchParams.has('status')) {
      const s = await blobStatus(ctx, id, hash);
      return s ? json(s) : NOT_FOUND();
    }
    const b = await readBlob(ctx, id, hash);
    if (!b) return NOT_FOUND();
    return new Response(b.bytes as BodyInit, {
      headers: {
        'Content-Type': b.contentType,
        'Content-Length': String(b.bytes.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'inline',
      },
    });
  } catch (e) {
    if (e instanceof BlobStoreUnavailable) return json({ error: 'storage_unavailable' }, 503);
    throw e;
  }
}

export async function POST(req: Request, { params }: Params) {
  const ctx = await requireOrg((await params).org);
  const { id, hash } = await target(params);
  if (!id || !hash) return NOT_FOUND();
  // A cookie-authenticated write: same origin only, and a non-form content type (a cross-site form can't send it).
  if (!isSameOrigin(req.headers)) return json({ error: 'cross_origin' }, 403);
  if (!/^application\/octet-stream\b/i.test(req.headers.get('content-type') ?? '')) return json({ error: 'octet_stream_required' }, 415);
  const declared = int(req.headers.get('content-length'));
  if (declared > MAX_CHUNK_BYTES) return json({ error: 'bad-chunk' }, 413);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_CHUNK_BYTES) return json({ error: 'bad-chunk' }, 413);
  try {
    const r = await uploadChunk(ctx, id, hash, {
      offset: int(req.headers.get('x-upload-offset')),
      length: int(req.headers.get('x-upload-length')),
      type: (req.headers.get('x-blob-type') ?? '').toLowerCase(),
      bytes,
    });
    if (!r) return NOT_FOUND();
    if ('refused' in r) return json({ error: r.refused.code, detail: r.refused.message, received: r.refused.received ?? 0 }, r.refused.status);
    return json(r);
  } catch (e) {
    if (e instanceof UploadRefused) return json({ error: e.code, detail: e.message, ...(e.received !== undefined ? { received: e.received } : {}) }, e.status);
    if (e instanceof BlobStoreUnavailable) return json({ error: 'storage_unavailable' }, 503);
    throw e;
  }
}

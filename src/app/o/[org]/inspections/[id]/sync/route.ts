import { z } from 'zod';
import { requireOrg } from '@/core/authz/guards';
import { isSameOrigin } from '@/core/http';
import { pushSchema, syncPull, syncPush, SyncRefused } from '@/lib/walkthrough/store';

export const dynamic = 'force-dynamic';

// The server sync endpoint (Phase 2, docs/walkthrough/PHASE2_PLAN.md). Session cookie, like every org page: the PWA
// (Phase 3) runs on this origin. GET downloads, POST pushes then pulls. An inspection the user may not see (WT-05),
// another org's id and an id that does not exist all get the same 404.
type Params = { params: Promise<{ org: string; id: string }> };

const MAX_BODY = 1_000_000;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const NOT_FOUND = () => json({ error: 'not_found' }, 404);
const since = z.coerce.number().int().min(0).max(2 ** 31 - 1).catch(0);

export async function GET(req: Request, { params }: Params) {
  const ctx = await requireOrg((await params).org);
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NOT_FOUND();
  const r = await syncPull(ctx, id.data, since.parse(new URL(req.url).searchParams.get('since') ?? 0));
  return r ? json(r) : NOT_FOUND();
}

export async function POST(req: Request, { params }: Params) {
  const ctx = await requireOrg((await params).org);
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NOT_FOUND();
  // A cookie-authenticated write: refuse cross-site posts, and anything that is not JSON (no plain-form CSRF).
  if (!isSameOrigin(req.headers)) return json({ error: 'cross_origin' }, 403);
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) return json({ error: 'json_required' }, 415);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: 'too_large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  const input = pushSchema.safeParse(body);
  if (!input.success) return json({ error: 'bad_request', detail: input.error.issues[0]?.message }, 400);
  try {
    const r = await syncPush(ctx, id.data, input.data);
    return r ? json(r) : NOT_FOUND();
  } catch (e) {
    if (e instanceof SyncRefused) return json({ error: e.code, detail: e.message }, e.status);
    if ((e as { code?: string })?.code === 'P2002') return json({ error: 'retry', detail: 'a concurrent push won; retry' }, 409);
    throw e;
  }
}

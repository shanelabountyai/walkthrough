import { z } from 'zod';
import { requireOrg } from '@/core/authz/guards';
import { isSameOrigin } from '@/core/http';
import { BlobStoreUnavailable } from '@/lib/walkthrough/blob-store';
import { WHY } from '@/lib/walkthrough/report';
import { generateReport, readReport } from '@/lib/walkthrough/reports';

export const dynamic = 'force-dynamic';

// The inspection's PDF report (Phase 4, docs/walkthrough/PHASE4_PLAN.md). POST completes the inspection and generates
// the report (the assignee or a manager); GET [?n=] downloads one. Not visible (WT-05), another org's id and a missing
// id all get the same 404.
type Params = { params: Promise<{ org: string; id: string }> };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const NOT_FOUND = () => json({ error: 'not_found' }, 404);

export async function GET(req: Request, { params }: Params) {
  const ctx = await requireOrg((await params).org);
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NOT_FOUND();
  const n = z.coerce.number().int().min(1).max(1_000_000).optional().catch(undefined).parse(new URL(req.url).searchParams.get('n') ?? undefined);
  try {
    const r = await readReport(ctx, id.data, n);
    if (!r) return NOT_FOUND();
    return new Response(r.bytes as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(r.bytes.length),
        'Content-Disposition': `inline; filename="inspection-report-${r.number}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    if (e instanceof BlobStoreUnavailable) return json({ error: 'storage_unavailable' }, 503);
    throw e;
  }
}

export async function POST(req: Request, { params }: Params) {
  const ctx = await requireOrg((await params).org);
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NOT_FOUND();
  if (!isSameOrigin(req.headers)) return json({ error: 'cross_origin' }, 403);
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) return json({ error: 'json_required' }, 415);
  try {
    const r = await generateReport(ctx, id.data);
    if (!r) return NOT_FOUND();
    if (!r.ok) return json({ error: 'not_ready', notReady: r.notReady.map((x) => ({ ...x, message: `${x.label} ${WHY[x.why]}` })) }, 409);
    return json({ number: r.report.number, created: r.created, opSeq: r.report.opSeq, url: `/o/${ctx.slug}/inspections/${id.data}/report?n=${r.report.number}` });
  } catch (e) {
    if (e instanceof BlobStoreUnavailable) return json({ error: 'storage_unavailable' }, 503);
    throw e;
  }
}

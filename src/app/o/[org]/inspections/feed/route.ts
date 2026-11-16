import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { visibleTo } from '@/lib/walkthrough/store';

export const dynamic = 'force-dynamic';

// The field app's list (Phase 3): the inspections this user may see (WT-05 — assigned ones, or all for a manager),
// and who they are, so the device can key its device id by user (D-20).
export async function GET(_req: Request, { params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const rows = await withOrg(
    ctx,
    (tx) => tx.inspection.findMany({ where: visibleTo(ctx), orderBy: { createdAt: 'desc' }, select: { id: true, title: true, templateVersion: true, conflictPaths: true } }),
    { atomic: false },
  );
  return Response.json(
    { userId: ctx.userId, inspections: rows.map((r) => ({ id: r.id, title: r.title, templateVersion: r.templateVersion, conflicts: r.conflictPaths.length })) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

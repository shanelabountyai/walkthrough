import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { isManager, visibleTo } from '@/lib/walkthrough/store';

export const metadata = { title: 'Home' };

// The org home (design pass 2026-11-18, D-50): once there is anything to inspect it is the inspections list; a new org
// gets an empty state that says what to do first, in the field app's look.
export default async function OrgHome({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const any = await withOrg(ctx, (tx) => tx.inspection.findFirst({ where: visibleTo(ctx), select: { id: true } }), { atomic: false });
  if (any) redirect(`/o/${ctx.slug}/inspections`);
  const manager = isManager(ctx.role);
  return (
    <main className="wt-page">
      <div className="wt-narrow-col" style={{ maxWidth: 640 }}>
        <h1 className="wt-h1">Nothing here yet</h1>
        <section className="wt-card wt-card-pad" aria-label="Get started">
          {manager ? (
            <>
              <p className="wt-note-14">This org is ready. Three steps to a first inspection:</p>
              <ol className="wt-list">
                <li><Link href={`/o/${ctx.slug}/templates`}>Create a checklist template</Link></li>
                <li><Link href={`/o/${ctx.slug}/settings/members`}>Invite your team</Link> (technicians are members)</li>
                <li><Link href={`/o/${ctx.slug}/inspections`}>Create an inspection</Link> and assign it</li>
              </ol>
            </>
          ) : (
            <p className="wt-note-14">No inspections are assigned to you yet. When the office assigns one, it shows up here and in the field app.</p>
          )}
          <a className="wt-btn wt-btn-2 wt-self-start" href={`/field?org=${encodeURIComponent(ctx.slug)}`}>Open the field app</a>
        </section>
      </div>
    </main>
  );
}

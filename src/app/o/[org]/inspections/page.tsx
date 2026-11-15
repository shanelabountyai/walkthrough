import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { isManager, visibleTo } from '@/lib/walkthrough/store';
import { addInspection } from './actions';

export const metadata = { title: 'Inspections' };

// WT-05: a technician sees only the inspections assigned to them; managers see the org's and create new ones.
export default async function Inspections({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const manager = isManager(ctx.role);
  const [inspections, templates, members] = await withOrg(
    ctx,
    (tx) =>
      Promise.all([
        tx.inspection.findMany({
          where: visibleTo(ctx),
          orderBy: { createdAt: 'desc' },
          select: { id: true, title: true, templateVersion: true, conflictPaths: true, assigneeId: true, template: { select: { name: true } } },
        }),
        manager ? tx.checklistTemplate.findMany({ where: inOrg(ctx), orderBy: { name: 'asc' }, select: { id: true, name: true } }) : [],
        manager ? tx.membership.findMany({ where: inOrg(ctx), select: { userId: true, user: { select: { email: true } } } }) : [],
      ]),
    { atomic: false },
  );
  const email = new Map(members.map((m) => [m.userId, m.user.email]));
  return (
    <main>
      <h1>{manager ? 'Inspections' : 'My inspections'}</h1>
      {!inspections.length && <p>No inspections yet.</p>}
      <ul>
        {inspections.map((i) => (
          <li key={i.id}>
            <Link href={`/o/${ctx.slug}/inspections/${i.id}`}>{i.title}</Link> · {i.template.name} v{i.templateVersion}
            {manager && <> · {email.get(i.assigneeId) ?? 'former member'}</>}
            {i.conflictPaths.length > 0 && <strong> · resolve ({i.conflictPaths.length})</strong>}
          </li>
        ))}
      </ul>
      {manager && (
        <>
          <h2>New inspection</h2>
          {templates.length ? (
            <ActionForm action={addInspection.bind(null, ctx.slug)}>
              <label>Title <input name="title" required maxLength={200} /></label>
              <label>
                Template{' '}
                <select name="templateId">
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label>
                Technician{' '}
                <select name="assigneeId">
                  {members.map((m) => <option key={m.userId} value={m.userId}>{m.user.email}</option>)}
                </select>
              </label>
              <button type="submit">Create inspection</button>
            </ActionForm>
          ) : (
            <p><Link href={`/o/${ctx.slug}/templates`}>Create a template</Link> first.</p>
          )}
        </>
      )}
    </main>
  );
}

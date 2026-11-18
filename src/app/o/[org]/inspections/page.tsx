import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { isManager, visibleTo } from '@/lib/walkthrough/store';
import { addInspection } from './actions';

export const metadata = { title: 'Inspections' };

const day = (d: Date) => d.toISOString().slice(0, 10);

// WT-05: a technician sees only the inspections assigned to them; managers see the org's and create new ones.
// Design pass 2026-11-18: docs/design/InspectionsList.dc.html.
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
          select: {
            id: true,
            title: true,
            templateVersion: true,
            conflictPaths: true,
            assigneeId: true,
            createdAt: true,
            completedAt: true,
            template: { select: { name: true } },
            reports: { select: { number: true }, orderBy: { number: 'desc' }, take: 1 },
          },
        }),
        manager ? tx.checklistTemplate.findMany({ where: inOrg(ctx), orderBy: { name: 'asc' }, select: { id: true, name: true } }) : [],
        manager ? tx.membership.findMany({ where: inOrg(ctx), select: { userId: true, user: { select: { email: true } } } }) : [],
      ]),
    { atomic: false },
  );
  const email = new Map(members.map((m) => [m.userId, m.user.email]));
  const heading = manager ? 'Inspections' : 'My inspections';
  return (
    <main className="wt-page">
      <div className="wt-main-col">
        <div className="wt-titlebar">
          <h1>{heading}</h1>
          <a className="wt-btn wt-btn-2" href={`/field?org=${encodeURIComponent(ctx.slug)}`}>
            Open the field app
          </a>
        </div>
        <section className="wt-card" aria-labelledby="ins-count" style={{ overflow: 'hidden' }}>
          <h2 id="ins-count" className="wt-card-h">
            {inspections.length} inspection{inspections.length === 1 ? '' : 's'}
          </h2>
          {!inspections.length ? (
            <p className="wt-empty">{manager ? 'No inspections yet. Create one with the form on this page.' : 'No inspections yet. When the office assigns you one, it shows up here.'}</p>
          ) : (
            <table className="wt-table">
              <thead>
                <tr>
                  <th scope="col">Inspection</th>
                  <th scope="col">Template</th>
                  {manager && <th scope="col">Technician</th>}
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {inspections.map((i) => {
                  const conflicts = i.conflictPaths.length;
                  const report = i.reports[0]?.number;
                  return (
                    <tr key={i.id} className={conflicts ? 'wt-tr-warn' : undefined}>
                      <td data-label="Inspection">
                        <Link href={`/o/${ctx.slug}/inspections/${i.id}`}>{i.title}</Link>
                        <div className="wt-note">created {day(i.createdAt)}</div>
                      </td>
                      <td data-label="Template">
                        {i.template.name} v{i.templateVersion}
                      </td>
                      {manager && <td data-label="Technician">{email.get(i.assigneeId) ?? 'former member'}</td>}
                      <td data-label="Status">
                        {conflicts > 0 ? (
                          <span className="wt-s wt-s-warn">
                            <span aria-hidden="true">◆ </span>
                            {conflicts} to resolve
                          </span>
                        ) : report ? (
                          <span className="wt-s wt-s-ok">
                            <span aria-hidden="true">✓ </span>Report {report}
                          </span>
                        ) : (
                          <span className="wt-s wt-s-open">
                            <span aria-hidden="true">○ </span>Open
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
        {!manager && <p className="wt-note">You see the inspections assigned to you. Answer them in the field app; it works without signal.</p>}
      </div>
      {manager && (
        <aside className="wt-side-col" aria-label="New inspection">
          <section className="wt-card wt-card-pad" aria-labelledby="new-ins">
            <h2 id="new-ins">New inspection</h2>
            {templates.length ? (
              <ActionForm action={addInspection.bind(null, ctx.slug)}>
                <div className="wt-form">
                  <label className="wt-field">
                    Title <input className="wt-input" name="title" required maxLength={200} />
                  </label>
                  <label className="wt-field">
                    Template
                    <select className="wt-input" name="templateId">
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="wt-field">
                    Technician
                    <select className="wt-input" name="assigneeId">
                      {members.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.user.email}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="wt-note">The inspection keeps the template&rsquo;s latest version for good. Publishing a new version later never changes it.</p>
                  <button className="wt-btn" type="submit">
                    Create inspection
                  </button>
                </div>
              </ActionForm>
            ) : (
              <p className="wt-note-14">
                <Link href={`/o/${ctx.slug}/templates`}>Create a template</Link> first.
              </p>
            )}
          </section>
        </aside>
      )}
    </main>
  );
}

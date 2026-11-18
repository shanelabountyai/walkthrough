import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { can } from '@/core/authz/permissions';
import { ActionForm } from '@/core/ui/action-form';
import { EXAMPLE_DEFINITION } from '@/lib/walkthrough/template';
import { KeptInput, KeptTextarea } from './definition-field';
import { ManagersOnly } from './managers-only';
import { DefinitionHelp } from './definition-help';
import { addTemplate } from './actions';

export const metadata = { title: 'Templates' };

// Checklist templates. Managers only (D-16); a technician reaches a template only through an assigned inspection.
// Design pass 2026-11-18: docs/design/Templates.dc.html.
export default async function Templates({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  // Managers only (D-16). A technician who follows an old link gets a plain refusal, not the error page (PRD DX-06).
  if (!can(ctx.role, 'org.update')) return <ManagersOnly slug={ctx.slug} />;
  const templates = await withOrg(
    ctx,
    (tx) => tx.checklistTemplate.findMany({ where: inOrg(ctx), orderBy: { createdAt: 'asc' }, select: { id: true, name: true, versions: { select: { version: true }, orderBy: { version: 'desc' }, take: 1 }, _count: { select: { inspections: true } } } }),
    { atomic: false },
  );
  return (
    <main className="wt-page">
      <div className="wt-narrow-col">
        <h1 className="wt-h1">Checklist templates</h1>
        <section className="wt-card" aria-labelledby="tpl-count" style={{ overflow: 'hidden' }}>
          <h2 id="tpl-count" className="wt-card-h">
            {templates.length} template{templates.length === 1 ? '' : 's'}
          </h2>
          {!templates.length ? (
            <p className="wt-empty">No templates yet. Create one to start inspections.</p>
          ) : (
            <table className="wt-table">
              <thead>
                <tr>
                  <th scope="col">Template</th>
                  <th scope="col">Latest version</th>
                  <th scope="col">Inspections</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td data-label="Template">
                      <Link href={`/o/${ctx.slug}/templates/${t.id}`}>{t.name}</Link>
                    </td>
                    <td data-label="Latest version">
                      <span className="wt-chip">version {t.versions[0]?.version ?? 0}</span>
                    </td>
                    <td data-label="Inspections">{t._count.inspections}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      <section className="wt-card wt-card-pad" aria-labelledby="new-tpl" style={{ flex: '999 1 560px', minWidth: 0 }}>
        <h2 id="new-tpl">New template</h2>
        <ActionForm action={addTemplate.bind(null, ctx.slug)}>
          <div className="wt-form">
            <label className="wt-field">
              Name <KeptInput className="wt-input" name="name" required maxLength={120} />
            </label>
            <div className="wt-field">
                <label htmlFor="definition">Definition (JSON)</label>
                <KeptTextarea id="definition" className="wt-input wt-code" name="definition" rows={18} spellCheck={false} aria-describedby="def-help" defaultValue={JSON.stringify(EXAMPLE_DEFINITION, null, 2)} />
              </div>
            <DefinitionHelp />
            <p className="wt-note">Starts from an example you can edit. Saving publishes version 1; published versions never change.</p>
            <button className="wt-btn wt-self-start" type="submit">
              Create template
            </button>
          </div>
        </ActionForm>
      </section>
    </main>
  );
}

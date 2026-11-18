import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { definitionSchema } from '@/lib/walkthrough/template';
import { DefinitionHelp } from '../definition-help';
import { publishTemplateVersion } from '../actions';

export const metadata = { title: 'Template' };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "2 sections · 7 items · 5 required", or a plain note when a stored definition does not parse (never thrown). */
function shapeOf(definition: unknown): string {
  const d = definitionSchema.safeParse(definition);
  if (!d.success) return 'definition could not be read';
  const items = d.data.sections.flatMap((s) => s.items);
  return `${plural(d.data.sections.length, 'section')} · ${plural(items.length, 'item')} · ${items.filter((i) => i.required).length} required`;
}

// One template's versions. Published versions never change (WT-04); saving publishes version n+1 (D-17).
// Design pass 2026-11-18: docs/design/TemplateEditor.dc.html.
export default async function TemplatePage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org, 'org.update');
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const t = await withOrg(
    ctx,
    (tx) =>
      tx.checklistTemplate.findFirst({
        where: { id: id.data, ...inOrg(ctx) },
        select: {
          id: true,
          name: true,
          versions: { orderBy: { version: 'desc' }, select: { version: true, definition: true, createdAt: true, _count: { select: { inspections: true } } } },
          _count: { select: { inspections: true } },
        },
      }),
    { atomic: false },
  );
  if (!t) notFound();
  const latest = t.versions[0];
  const next = (latest?.version ?? 0) + 1;
  return (
    <main className="wt-page">
      <div className="wt-main-col">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Link href={`/o/${ctx.slug}/templates`} style={{ fontSize: 14, minHeight: 24, display: 'inline-flex', alignItems: 'center' }}>
            ← All checklists
          </Link>
          <h1 className="wt-h1">{t.name}</h1>
          <p className="wt-note-14">
            {plural(t.versions.length, 'version')} · {plural(t._count.inspections, 'inspection')}. Each inspection keeps the version it was created on.
          </p>
        </div>
        <section className="wt-card wt-card-pad" aria-labelledby="publish">
          <h2 id="publish">Publish version {next}</h2>
          <p className="wt-note-14">
            {latest ? `Starts from version ${latest.version}. Publishing makes version ${next}; version ${latest.version} and every inspection pinned to it stay as they are.` : 'Publishing makes version 1.'}
          </p>
          <ActionForm action={publishTemplateVersion.bind(null, ctx.slug)}>
            <div className="wt-form">
              <input type="hidden" name="id" value={t.id} />
              <div className="wt-field">
                  <label htmlFor="definition">Definition (JSON)</label>
                  <textarea id="definition" className="wt-input wt-code" name="definition" rows={22} spellCheck={false} aria-describedby="def-help" defaultValue={JSON.stringify(latest?.definition ?? {}, null, 2)} />
                </div>
              <DefinitionHelp />
              <button className="wt-btn wt-self-start" type="submit">
                Publish new version
              </button>
            </div>
          </ActionForm>
        </section>
      </div>
      <aside className="wt-side-col" aria-label="Versions">
        <section className="wt-card wt-card-pad" aria-labelledby="versions">
          <h2 id="versions">Versions</h2>
          <ol className="wt-versions" reversed>
            {t.versions.map((v, n) => (
              <li key={v.version}>
                <strong>
                  Version {v.version}
                  {n === 0 ? ' · latest' : ''}
                </strong>
                <span>
                  Version {v.version} · published {v.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
                </span>
                <span>
                  {plural(v._count.inspections, 'inspection')} · {shapeOf(v.definition)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </main>
  );
}

import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { EXAMPLE_DEFINITION } from '@/lib/walkthrough/template';
import { addTemplate } from './actions';

export const metadata = { title: 'Templates' };

// Checklist templates. Managers only (D-16); a technician reaches a template only through an assigned inspection.
export default async function Templates({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org, 'org.update');
  const templates = await withOrg(
    ctx,
    (tx) => tx.checklistTemplate.findMany({ where: inOrg(ctx), orderBy: { createdAt: 'asc' }, select: { id: true, name: true, versions: { select: { version: true }, orderBy: { version: 'desc' }, take: 1 } } }),
    { atomic: false },
  );
  return (
    <main>
      <h1>Checklist templates</h1>
      <ul>
        {templates.map((t) => (
          <li key={t.id}>
            <Link href={`/o/${ctx.slug}/templates/${t.id}`}>{t.name}</Link> · version {t.versions[0]?.version ?? 0}
          </li>
        ))}
      </ul>
      <h2>New template</h2>
      <p>
        Sections hold items. Item types: <code>pass_fail_na</code>, <code>number</code> (<code>min</code>, <code>max</code>, <code>unit</code>), <code>text</code> (
        <code>maxLength</code>), <code>photo</code>, <code>signature</code>; each takes <code>required</code>. Item keys are unique across the template.
      </p>
      <ActionForm action={addTemplate.bind(null, ctx.slug)}>
        <label>Name <input name="name" required maxLength={120} /></label>
        <label>
          Definition (JSON)
          <textarea name="definition" rows={24} cols={80} defaultValue={JSON.stringify(EXAMPLE_DEFINITION, null, 2)} />
        </label>
        <button type="submit">Create template</button>
      </ActionForm>
    </main>
  );
}

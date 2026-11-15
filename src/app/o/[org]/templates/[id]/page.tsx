import { notFound } from 'next/navigation';
import { z } from 'zod';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { publishTemplateVersion } from '../actions';

export const metadata = { title: 'Template' };

// One template's versions. Published versions never change (WT-04); saving publishes version n+1 (D-17).
export default async function TemplatePage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org, 'org.update');
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const t = await withOrg(
    ctx,
    (tx) =>
      tx.checklistTemplate.findFirst({
        where: { id: id.data, ...inOrg(ctx) },
        select: { id: true, name: true, versions: { orderBy: { version: 'desc' }, select: { version: true, definition: true, createdAt: true } }, _count: { select: { inspections: true } } },
      }),
    { atomic: false },
  );
  if (!t) notFound();
  const latest = t.versions[0];
  return (
    <main>
      <h1>{t.name}</h1>
      <p>
        {t.versions.length} version{t.versions.length === 1 ? '' : 's'} · {t._count.inspections} inspection{t._count.inspections === 1 ? '' : 's'}. Each inspection keeps the version it
        was created on.
      </p>
      <ul>
        {t.versions.map((v) => (
          <li key={v.version}>
            Version {v.version} · published {v.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
          </li>
        ))}
      </ul>
      <h2>Publish version {(latest?.version ?? 0) + 1}</h2>
      <ActionForm action={publishTemplateVersion.bind(null, ctx.slug)}>
        <input type="hidden" name="id" value={t.id} />
        <textarea name="definition" rows={24} cols={80} aria-label="Definition (JSON)" defaultValue={JSON.stringify(latest?.definition ?? {}, null, 2)} />
        <button type="submit">Publish new version</button>
      </ActionForm>
    </main>
  );
}

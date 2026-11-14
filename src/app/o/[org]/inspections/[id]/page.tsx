import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { renderInspection } from '@/lib/walkthrough/render';
import { inspectionState, visibleTo } from '@/lib/walkthrough/store';
import { definitionSchema } from '@/lib/walkthrough/template';

export const metadata = { title: 'Inspection' };

const show = (v: unknown) => (v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

// Read-only view of the server's merged state, rendered against the pinned template version (WT-04). Answering
// happens on the device (Phase 3); conflicts and off-template answers are shown with every value kept (WT-03, D-14).
export default async function InspectionPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const found = await withOrg(
    ctx,
    async (tx) => {
      const insp = await tx.inspection.findFirst({
        where: { id: id.data, ...visibleTo(ctx) },
        select: { id: true, title: true, templateVersion: true, template: { select: { name: true } }, pinnedVersion: { select: { definition: true } } },
      });
      return insp && { insp, state: await inspectionState(tx, ctx, insp.id) };
    },
    { atomic: false },
  );
  if (!found) notFound();
  const { insp, state } = found;
  const view = renderInspection(definitionSchema.parse(insp.pinnedVersion.definition), insp.templateVersion, state);
  return (
    <main>
      <h1>{insp.title}</h1>
      <p>
        {insp.template.name}, version {view.templateVersion} (pinned when the inspection was created).
        {view.conflicts.length > 0 && <strong> Resolve: {view.conflicts.length} field{view.conflicts.length === 1 ? '' : 's'} have conflicting answers.</strong>}
      </p>
      {view.sections.map((s) => (
        <section key={s.key}>
          <h2>{s.title}</h2>
          <dl>
            {s.items.map((i) => (
              <div key={i.path}>
                <dt>
                  {i.item.label}
                  {i.item.required && ' *'}
                </dt>
                <dd>
                  {show(i.value)}
                  {!i.valid && <em> (does not fit this item)</em>}
                  {i.conflict && (
                    <strong>
                      {' '}
                      resolve: {i.heads.map((h) => `${show(h.value)}${h.offTemplate ? ` (v${h.templateVersion})` : ''}`).join(' / ')}
                    </strong>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {view.unknownFields.length > 0 && (
        <section>
          <h2>Answers to items not in version {view.templateVersion}</h2>
          <ul>
            {view.unknownFields.map((u) => (
              <li key={u.path}>
                {u.path}: {u.field.heads.map((h) => `${show(h.value)} (v${h.templateVersion})`).join(' / ')}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

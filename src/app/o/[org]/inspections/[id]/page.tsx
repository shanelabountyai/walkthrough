import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { refsIn } from '@/lib/walkthrough/blobs';
import { WHY } from '@/lib/walkthrough/readiness';
import { reportView } from '@/lib/walkthrough/reports';
import { CompleteButton } from './complete-button';

export const metadata = { title: 'Inspection' };

const show = (v: unknown) => (v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

// Read-only view of the server's merged state, rendered against the pinned template version (WT-04). Answering
// happens on the device (Phase 3); conflicts and off-template answers are shown with every value kept (WT-03, D-14).
// Phase 4: photos and the signature, completing the inspection (its PDF report) and the Truckroll link-out.
export default async function InspectionPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const found = await withOrg(ctx, (tx) => reportView(tx, ctx, id.data), { atomic: false });
  if (!found) notFound();
  const { insp, rendered: view, complete, notReady, latest, reports, truckroll } = found;
  const base = `/o/${ctx.slug}/inspections/${insp.id}`;
  const changed = latest && latest.opSeq !== insp.opSeq;
  return (
    <main>
      <h1>{insp.title}</h1>
      <p>
        {insp.template.name}, version {view.templateVersion} (pinned when the inspection was created).
        {view.conflicts.length > 0 && <strong> Resolve: {view.conflicts.length} field{view.conflicts.length === 1 ? '' : 's'} have conflicting answers.</strong>}
      </p>
      <p>
        <a href={truckroll} target="_blank" rel="noopener noreferrer">
          Open this day in Truckroll
        </a>
        {insp.completedAt && <> · Completed {insp.completedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</>}
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
                  {(i.item.type === 'photo' || i.item.type === 'signature') && refsIn(i.value).length > 0 ? (
                    refsIn(i.value).map((h, n) =>
                      complete.has(h) ? (
                        // eslint-disable-next-line @next/next/no-img-element -- a guarded, private blob, not an optimizable asset
                        <img key={h} src={`${base}/blobs/${h}`} alt={i.item.type === 'signature' ? `Signature: ${i.item.label}` : `${i.item.label}, photo ${n + 1}`} height={i.item.type === 'signature' ? 80 : 120} style={{ marginRight: 8 }} />
                      ) : (
                        <em key={h}>{i.item.type === 'signature' ? 'signature' : `photo ${n + 1}`} still uploading </em>
                      ),
                    )
                  ) : (
                    show(i.value)
                  )}
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
      <section>
        <h2>Report</h2>
        {reports.length > 0 && (
          <ul>
            {reports.map((r) => (
              <li key={r.number}>
                <a href={`${base}/report?n=${r.number}`}>Report {r.number} (PDF)</a> · {r.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
              </li>
            ))}
          </ul>
        )}
        {notReady.length > 0 ? (
          <>
            <p>Before this inspection can be completed:</p>
            <ul>
              {notReady.map((n) => (
                <li key={`${n.path}:${n.why}`}>
                  {n.label} {WHY[n.why]}
                </li>
              ))}
            </ul>
          </>
        ) : !latest ? (
          <CompleteButton org={ctx.slug} id={insp.id} label="Complete and generate report" />
        ) : changed ? (
          <CompleteButton org={ctx.slug} id={insp.id} label={`Answers changed since report ${latest.number}: generate report ${latest.number + 1}`} />
        ) : null}
      </section>
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

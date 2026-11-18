import { notFound } from 'next/navigation';
import { z } from 'zod';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { refsIn } from '@/lib/walkthrough/blobs';
import { WHY } from '@/lib/walkthrough/readiness';
import { reportView } from '@/lib/walkthrough/reports';
import { shown, valueText } from '@/app/ui/answers';
import { CompleteButton } from './complete-button';

export const metadata = { title: 'Inspection' };

const show = (v: unknown) => (v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
const utc = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');
const hm = (d: Date) => d.toISOString().slice(11, 16);

// Read-only view of the server's merged state, rendered against the pinned template version (WT-04). Answering
// happens on the device (Phase 3); conflicts and off-template answers are shown with every value kept (WT-03, D-14).
// Phase 4: photos and the signature, completing the inspection (its PDF report) and the Truckroll link-out.
// Design pass 2026-11-18: docs/design/Admin.dc.html. Who and when come from the stored op rows (userId, receivedAt):
// the server records when it received an answer, not when the phone took it, so times say "received" (D-47).
export default async function InspectionPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const found = await withOrg(
    ctx,
    async (tx) => {
      const v = await reportView(tx, ctx, id.data);
      if (!v) return null;
      const [ops, links, members] = await Promise.all([
        tx.inspectionOp.findMany({ where: { inspectionId: v.insp.id, ...inOrg(ctx) }, orderBy: { seq: 'asc' }, select: { seq: true, opId: true, kind: true, userId: true, receivedAt: true, templateVersion: true } }),
        tx.inspectionBlob.findMany({ where: { inspectionId: v.insp.id, ...inOrg(ctx), linked: true }, select: { linkedAt: true, createdById: true } }),
        tx.membership.findMany({ where: inOrg(ctx), select: { userId: true, user: { select: { email: true } } } }),
      ]);
      return { ...v, ops, links, members };
    },
    { atomic: false },
  );
  if (!found) notFound();
  const { insp, rendered: view, complete, notReady, latest, reports, truckroll, ops, links, members } = found;
  const base = `/o/${ctx.slug}/inspections/${insp.id}`;
  const field = `/field?org=${encodeURIComponent(ctx.slug)}&open=${insp.id}`;
  const changed = latest && latest.opSeq !== insp.opSeq;
  const email = new Map(members.map((m) => [m.userId, m.user.email]));
  const who = (userId: string | null) => (userId ? (email.get(userId) ?? 'former member') : 'server');
  const byOp = new Map(ops.map((o) => [o.opId, o]));
  const metaOf = (opId: string) => {
    const o = byOp.get(opId);
    return o ? `${who(o.userId)} · received ${hm(o.receivedAt)} UTC` : '';
  };

  // Sync history: the server pin, then each push (one transaction stamps one receivedAt), uploads and reports.
  type Ev = { at: Date; text: string };
  const events: Ev[] = [];
  const pushes = new Map<string, { at: Date; userId: string | null; n: number }>();
  for (const o of ops) {
    if (o.kind === 'pin') {
      events.push({ at: o.receivedAt, text: `Created; template version ${o.templateVersion} pinned by the server` });
      continue;
    }
    const k = `${o.receivedAt.toISOString()}|${o.userId}`;
    const p = pushes.get(k) ?? { at: o.receivedAt, userId: o.userId, n: 0 };
    p.n++;
    pushes.set(k, p);
  }
  for (const p of pushes.values()) events.push({ at: p.at, text: `${who(p.userId)} synced ${p.n} change${p.n === 1 ? '' : 's'}` });
  for (const l of links) if (l.linkedAt) events.push({ at: l.linkedAt, text: `${who(l.createdById)}: a photo or signature finished uploading` });
  for (const r of reports) events.push({ at: r.createdAt, text: `Report ${r.number} generated` });
  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  const SHOW = 30;
  const recent = events.slice(-SHOW);

  const conflictCount = view.conflicts.length;
  return (
    <main className="wt-page">
      <div className="wt-main-col">
        <div className="wt-titlebar">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="wt-kicker">
              Assigned to {who(insp.assigneeId)} · created {utc(insp.createdAt)} UTC
              {insp.completedAt && <> · completed {utc(insp.completedAt)} UTC</>}
            </span>
            <h1>{insp.title}</h1>
          </div>
          <div className="wt-chips">
            <span className="wt-chip">
              {insp.template.name}, version {view.templateVersion} (pinned when the inspection was created)
            </span>
            {conflictCount > 0 ? (
              <span className="wt-chip wt-chip-warn">
                <span aria-hidden="true">◆</span> {conflictCount} to resolve
              </span>
            ) : latest ? (
              <span className="wt-chip wt-chip-ok">
                <span aria-hidden="true">✓</span> Report {latest.number}
              </span>
            ) : null}
          </div>
        </div>
        {conflictCount > 0 && (
          <section className="wt-banner" aria-labelledby="needs">
            <strong id="needs">
              <span aria-hidden="true">◆ </span>
              {conflictCount} answer{conflictCount === 1 ? '' : 's'} need{conflictCount === 1 ? 's' : ''} resolving
            </strong>
            <p>
              Two devices changed the same answer. Both values are kept; nothing was overwritten. Resolve: pick one value in the field app. Whoever
              picks first wins, and the other value stays in the history.
            </p>
            <a href={field}>Resolve in the field app</a>
          </section>
        )}
        {view.sections.map((s) => (
          <section key={s.key} className="wt-card" aria-labelledby={`sec-${s.key}`} style={{ overflow: 'hidden' }}>
            <h2 id={`sec-${s.key}`} className="wt-card-h">
              {s.title}
            </h2>
            <dl className="wt-answers">
              {s.items.map((i) => {
                const st = shown(i);
                const refs = refsIn(i.value);
                const media = (i.item.type === 'photo' || i.item.type === 'signature') && refs.length > 0 && !i.conflict;
                return (
                  <div key={i.path} className={`wt-arow${i.conflict ? ' wt-arow-warn' : ''}`}>
                    <dt>
                      {i.item.label}
                      {i.item.required && (
                        <>
                          {' *'}
                          <span className="wt-sr"> (required)</span>
                        </>
                      )}
                    </dt>
                    <dd>
                      <span className={`wt-s wt-s-${st.tone}`}>
                        <span aria-hidden="true">{st.glyph}</span> {st.word}
                      </span>
                      {media && (
                        <div className="wt-thumbs">
                          {refs.map((h, n) =>
                            complete.has(h) ? (
                              // eslint-disable-next-line @next/next/no-img-element -- a guarded, private blob, not an optimizable asset
                              <img key={h} src={`${base}/blobs/${h}`} alt={i.item.type === 'signature' ? `Signature: ${i.item.label}` : `${i.item.label}, photo ${n + 1}`} height={i.item.type === 'signature' ? 80 : 120} />
                            ) : (
                              <span key={h} className="wt-s wt-s-wait">
                                <span aria-hidden="true">◐ </span>
                                {i.item.type === 'signature' ? 'Signature' : `Photo ${n + 1}`} still uploading
                              </span>
                            ),
                          )}
                        </div>
                      )}
                      {i.conflict && (
                        <>
                          <span className="wt-note" style={{ color: 'var(--wt-warn-ink-2)' }}>
                            {i.heads.length} values kept, neither chosen yet:
                          </span>
                          <ul className="wt-values" aria-label={`Kept values: ${i.item.label}`}>
                            {i.heads.map((h) => (
                              <li key={h.opId} className="wt-value">
                                {valueText(i.item, h.value)}
                                {h.offTemplate ? ` (v${h.templateVersion})` : ''}
                                {h.offTemplate && <small>written on another template version</small>}
                                <small>{metaOf(h.opId)}</small>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </dd>
                    <dd className="wt-meta">{i.conflict ? 'Edited on two devices' : i.answered && i.heads[0] ? metaOf(i.heads[i.heads.length - 1]!.opId) : ''}</dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
        {view.unknownFields.length > 0 && (
          <section className="wt-card wt-card-pad" aria-labelledby="offtpl">
            <h2 id="offtpl">Answers to items not in version {view.templateVersion}</h2>
            <p className="wt-note">Kept, never dropped: a device wrote these against another version of the template.</p>
            <ul className="wt-list">
              {view.unknownFields.map((u) => (
                <li key={u.path}>
                  {u.path}: {u.field.heads.map((h) => `${show(h.value)} (v${h.templateVersion})`).join(' / ')}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <aside className="wt-side-col" aria-label="Report and history">
        <section className="wt-card wt-card-pad" aria-labelledby="report">
          <h2 id="report">Report</h2>
          {reports.length > 0 && (
            <ul className="wt-list">
              {reports.map((r) => (
                <li key={r.number}>
                  <a href={`${base}/report?n=${r.number}`}>Report {r.number} (PDF)</a> · {utc(r.createdAt)} UTC
                </li>
              ))}
            </ul>
          )}
          {notReady.length > 0 ? (
            <>
              <p className="wt-note-14">The PDF unlocks once every conflict is resolved, every required item is answered and every photo has uploaded. Still to do:</p>
              <ul className="wt-list">
                {notReady.map((n) => (
                  <li key={`${n.path}:${n.why}`}>
                    {n.label} {WHY[n.why]}
                  </li>
                ))}
              </ul>
              <button type="button" className="wt-btn" disabled>
                Generate report (locked)
              </button>
            </>
          ) : !latest ? (
            <CompleteButton org={ctx.slug} id={insp.id} label="Complete and generate report" />
          ) : changed ? (
            <CompleteButton org={ctx.slug} id={insp.id} label={`Answers changed since report ${latest.number}: generate report ${latest.number + 1}`} />
          ) : (
            <p className="wt-note">Nothing has changed since report {latest.number}.</p>
          )}
        </section>
        <section className="wt-card wt-card-pad" aria-labelledby="hist">
          <h2 id="hist">Sync history</h2>
          {events.length > SHOW && <p className="wt-note">Showing the latest {SHOW} of {events.length}.</p>}
          <ol className="wt-history">
            {recent.map((e, n) => (
              <li key={n}>
                <time dateTime={e.at.toISOString()}>{hm(e.at)}</time> {e.text}
              </li>
            ))}
          </ol>
          <p className="wt-note">Times are UTC, when the server received each change.</p>
        </section>
        <section className="wt-card wt-card-pad" aria-labelledby="links">
          <h2 id="links">Links</h2>
          <a href={field}>Open in the field app</a>
          <a href={truckroll} target="_blank" rel="noopener noreferrer">
            Open this day in Truckroll<span className="wt-sr"> (opens in a new tab)</span>
          </a>
        </section>
      </aside>
    </main>
  );
}

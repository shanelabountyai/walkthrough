'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { materialize, type Json } from '@/lib/sync';
import { answer, attachPhoto, fetchTransport, finish, loadReplica, removePhoto, sign, syncAll, syncInspection, uploadBlobs } from '@/lib/field/client';
import { countOutbox, countUploads, getBlob, getMeta, listInspections, openDb, setMeta, uploadsFor, type StoredInspection } from '@/lib/field/db';
import { refsIn } from '@/lib/walkthrough/blobs';
import { readiness, reportRefs, WHY, type NotReady } from '@/lib/walkthrough/readiness';
import { renderInspection, type RenderedInspection, type RenderedItem } from '@/lib/walkthrough/render';
import { progress, rangeProblem, rangeText, valueText } from '@/app/ui/answers';
import { Logo } from '@/app/ui/logo';

// The field app (Phase 3). Everything on screen comes from IndexedDB; the network is used only to sync, and not at
// all while "Go offline" is on (the PRD's demo toggle). docs/walkthrough/PHASE3_PLAN.md.
// Design pass 2026-11-18: docs/design/FieldList.dc.html, Main.dc.html and Conflict.dc.html (render layer only; the
// sync, answer and finish logic below is unchanged).

const show = (v: Json) => (v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
const PFN: [string, string, string][] = [['pass', 'Pass', '✓'], ['fail', 'Fail', '✕'], ['na', 'N/A', '–']];

export function FieldApp() {
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [org, setOrg] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [forcedOffline, setForcedOffline] = useState(false);
  const [list, setList] = useState<(StoredInspection & { pending: number; conflicts: number })[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<{ meta: StoredInspection; rendered: RenderedInspection; pending: number; uploads: number; notReady: NotReady[]; pendingPaths: Set<string>; queued: Set<string> } | null>(null);
  const [pending, setPending] = useState(0);
  const [uploads, setUploads] = useState(0);
  const [report, setReport] = useState<{ id: string; url: string; number: number } | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [status, setStatus] = useState('Starting…');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const syncing = useRef(false);
  const wantOpen = useRef<string | null>(null); // ?open=<id>: the office's "Resolve in the field app" link
  const heading = useRef<HTMLHeadingElement | null>(null);
  const canNet = online && !forcedOffline;

  const refresh = useCallback(async (d: IDBDatabase, id: string | null) => {
    const all = await listInspections(d);
    const rows = await Promise.all(
      all.map(async (i) => {
        const got = await loadReplica(d, i.id);
        const state = got ? materialize(got.replica.log) : null;
        return { ...i, pending: got?.replica.outbox.size ?? 0, conflicts: state?.conflicts.length ?? 0 };
      }),
    );
    setList(rows.filter((r) => !r.gone || r.pending > 0));
    setPending(await countOutbox(d));
    setUploads(await countUploads(d));
    if (id) {
      const got = await loadReplica(d, id);
      if (got) {
        const state = materialize(got.replica.log);
        const rendered = renderInspection(got.meta.definition, got.meta.templateVersion, state);
        // On the device, a blob counts as uploaded once it has left this device's upload queue; the server re-checks.
        const queued = new Set((await uploadsFor(d, id)).map((u) => u.hash));
        const notReady = readiness(rendered, new Set(reportRefs(rendered).filter((h) => !queued.has(h))));
        // Which answers are still only on this phone (their op is in the outbox), for the per-item "saved" line.
        const pendingPaths = new Set([...got.replica.outbox].map((opId) => got.replica.log.get(opId)).flatMap((op) => (op?.kind === 'set' ? [op.path] : [])));
        setView({ meta: got.meta, rendered, pending: got.replica.outbox.size, uploads: queued.size, notReady, pendingPaths, queued });
      } else setView(null);
    } else setView(null);
  }, []);

  // Open the database, pick the org, register the service worker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const d = await openDb();
      if (cancelled) return;
      const q = new URLSearchParams(location.search);
      const fromUrl = q.get('org');
      wantOpen.current = q.get('open');
      const o = fromUrl ?? (await getMeta<string>(d, 'lastOrg')) ?? null;
      if (o) await setMeta(d, 'lastOrg', o);
      setForcedOffline((await getMeta<boolean>(d, 'forcedOffline')) ?? false);
      setOnline(navigator.onLine);
      setOrg(o);
      setLastSync(o ? ((await getMeta<string>(d, `lastSync:${o}`)) ?? null) : null);
      setDb(d);
      await refresh(d, null);
      setStatus(o ? 'Ready' : 'Open the field app from your org’s Inspections page once while online.');
    })();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then(() => navigator.serviceWorker.ready)
        .then((reg) => {
          const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.includes('/_next/static/'));
          reg.active?.postMessage({ type: 'cache-assets', urls });
        })
        .catch(() => {});
    }
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    addEventListener('online', up);
    addEventListener('offline', down);
    return () => {
      cancelled = true;
      removeEventListener('online', up);
      removeEventListener('offline', down);
    };
  }, [refresh]);

  const runSync = useCallback(async () => {
    if (!db || !org || !canNet || syncing.current) return;
    syncing.current = true;
    setStatus('Syncing…');
    try {
      const r = await syncAll(db, fetchTransport, org);
      if (r.ok) {
        const at = new Date().toISOString();
        setLastSync(at);
        setStatus('Synced');
      } else setStatus(r.error === 'signed-out' ? 'Signed out: sign in to sync. Your answers stay on this device.' : `Sync failed (${r.error}). Your answers stay on this device.`);
    } finally {
      syncing.current = false;
      await refresh(db, openId);
    }
  }, [db, org, canNet, refresh, openId]);

  // Sync when the app opens, whenever it comes back online, and every 30 s while online.
  useEffect(() => {
    if (!canNet || !db || !org) return;
    void runSync();
    const t = setInterval(() => void runSync(), 30_000);
    return () => clearInterval(t);
  }, [canNet, db, org]); // eslint-disable-line react-hooks/exhaustive-deps -- runSync changes with openId; a new interval per open is not wanted

  /** Push this inspection's ops, then its photos and signatures (ops first: the server only takes named blobs). */
  const pushNow = async (id: string) => {
    if (!db || !org || !canNet) return;
    const r = await syncInspection(db, fetchTransport, id);
    if (r.ok) {
      setStatus('Synced');
      const u = await uploadBlobs(db, fetchTransport, org, id);
      if (!u.ok) setStatus(`Upload paused (${u.error}). Photos stay on this device and upload on the next sync.`);
    }
    await refresh(db, id);
  };

  const write = async (path: string, value: Json) => {
    if (!db || !openId) return;
    await answer(db, openId, path, value);
    await refresh(db, openId);
    await pushNow(openId);
  };

  const withBlob = async (fn: (d: IDBDatabase, id: string) => Promise<unknown>) => {
    if (!db || !openId) return;
    try {
      await fn(db, openId);
    } catch (e) {
      setStatus(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await refresh(db, openId);
    await pushNow(openId);
  };
  const onPhotos = (path: string, files: File[]) =>
    withBlob(async (d, id) => {
      for (const f of files) {
        const img = await prepareImage(f);
        await attachPhoto(d, id, path, img.bytes, img.type);
      }
    });
  const onRemovePhoto = (path: string, hash: string) => withBlob((d, id) => removePhoto(d, id, path, hash));
  const onSign = (path: string, png: Uint8Array) => withBlob((d, id) => sign(d, id, path, png, 'image/png'));

  const onFinish = async () => {
    if (!db || !openId || !canNet) return;
    setStatus('Finishing…');
    setReasons([]);
    const r = await finish(db, fetchTransport, openId);
    if (r.ok) {
      setReport({ id: openId, url: r.url, number: r.number });
      setStatus(`Report ${r.number} is ready`);
    } else {
      setReasons(r.reasons ?? []);
      setStatus(r.error === 'not_ready' ? 'Not ready to finish yet' : `Could not finish (${r.error}). Your answers stay on this device.`);
    }
    await refresh(db, openId);
  };

  const toggleOffline = async () => {
    if (!db) return;
    const next = !forcedOffline;
    await setMeta(db, 'forcedOffline', next);
    setForcedOffline(next);
  };

  const open = async (id: string | null) => {
    setOpenId(id);
    if (db) await refresh(db, id);
    requestAnimationFrame(() => heading.current?.focus()); // a screen reader hears where it landed
  };

  // Open the inspection the office linked to, once it is on this device (it may arrive with the first sync).
  useEffect(() => {
    const want = wantOpen.current;
    if (want && !openId && list.some((i) => i.id === want)) {
      wantOpen.current = null;
      void open(want);
    }
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps -- runs when the list changes; open is stable enough here

  const mode = !online ? 'Offline (no network)' : forcedOffline ? 'Offline (demo toggle)' : 'Online';
  const busy = pending > 0 || uploads > 0;
  const glyph = !canNet ? '○' : busy ? '◐' : '✓';
  const prog = view ? progress(view.rendered.sections) : null;
  const items = view ? view.rendered.sections.flatMap((s) => s.items) : [];
  const conflicted = items.filter((i) => i.conflict);
  return (
    <div className="wt-field-app">
      <header className="wt-fhead">
        <div className="wt-fhead-in">
          <div className="wt-fhead-row">
            {view ? (
              <h1 ref={heading} tabIndex={-1}>
                {view.meta.title}
              </h1>
            ) : (
              <span className="wt-brand">
                <Logo size={24} />
                Walkthrough
              </span>
            )}
            {view ? (
              <span className="wt-pin">Template v{view.rendered.templateVersion} (pinned)</span>
            ) : (
              org && <a href={`/o/${encodeURIComponent(org)}/inspections`}>Back to {org}</a>
            )}
          </div>
          <div className={`wt-bar ${canNet ? 'wt-bar-on' : 'wt-bar-off'}`}>
            <span className="wt-bar-word">
              <span aria-hidden="true">{glyph}</span>
              <strong data-testid="mode">{mode}</strong>
            </span>
            <span className="wt-bar-note">
              <span data-testid="pending">
                {pending} change{pending === 1 ? '' : 's'} waiting to sync
              </span>
              <span data-testid="uploads">
                {uploads} photo{uploads === 1 ? '' : 's'} waiting to upload
              </span>
            </span>
          </div>
          <div className="wt-controls">
            <button type="button" aria-pressed={forcedOffline} onClick={toggleOffline}>
              {forcedOffline ? 'Go online' : 'Go offline'}
            </button>
            <button type="button" onClick={() => void runSync()} disabled={!canNet || !org}>
              Sync now
            </button>
          </div>
          <p className="wt-statusline">
            <span role="status">{status}</span>
            {lastSync && <span> · last synced {lastSync.slice(11, 16)} UTC</span>}
          </p>
        </div>
      </header>

      <main className="wt-fmain">
        {!view && (
          <section aria-labelledby="mine" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h1 id="mine" ref={heading} tabIndex={-1} style={{ margin: 0, fontSize: 20 }}>
              My inspections
            </h1>
            <p className="wt-note-14">
              Assigned to you and saved on this phone. They open without signal. &ldquo;Go offline&rdquo; is a demo toggle: it stops every network call, like a basement with no signal.
            </p>
            {!list.length && <p className="wt-note-14">{org ? 'None yet. They download the first time you open this page online.' : 'Open the field app from your org’s Inspections page once while online.'}</p>}
            <ul className="wt-cards">
              {list.map((i) => (
                <li key={i.id}>
                  <button type="button" className="wt-icard" onClick={() => void open(i.id)}>
                    <span className="wt-icard-title">{i.title}</span>
                    <span className="wt-icard-meta">Template version {i.templateVersion} (pinned)</span>
                    {i.conflicts > 0 ? (
                      <span className="wt-s wt-s-warn">
                        <span aria-hidden="true">◆ </span>
                        {i.conflicts} to resolve
                      </span>
                    ) : i.pending > 0 ? (
                      <span className="wt-s wt-s-wait">
                        <span aria-hidden="true">○ </span>
                        {i.pending} waiting to sync
                      </span>
                    ) : (
                      <span className="wt-s wt-s-ok">
                        <span aria-hidden="true">✓ </span>
                        Nothing waiting
                      </span>
                    )}
                    {i.gone && <span className="wt-s wt-s-na">No longer assigned to you</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {view && prog && (
          <>
            <button type="button" className="wt-back" onClick={() => void open(null)}>
              ← All inspections
            </button>
            <div className="wt-progress">
              <span>
                {prog.answered} of {prog.total} answered · {view.pending} waiting
                {view.uploads > 0 && (
                  <>
                    {' '}
                    · {view.uploads} photo{view.uploads === 1 ? '' : 's'} to upload
                  </>
                )}
              </span>
              {view.meta.truckroll && (
                <a href={view.meta.truckroll} target="_blank" rel="noopener noreferrer">
                  Open this day in Truckroll<span className="wt-sr"> (opens in a new tab)</span>
                </a>
              )}
            </div>
            {conflicted.length > 0 && (
              <section className="wt-banner" aria-labelledby="to-resolve">
                <strong id="to-resolve">
                  <span aria-hidden="true">◆ </span>
                  {conflicted.length} answer{conflicted.length === 1 ? '' : 's'} need{conflicted.length === 1 ? 's' : ''} resolving
                </strong>
                <p>Two devices changed the same answer while one was offline. Both are kept. Nothing was overwritten.</p>
                <ul>
                  {conflicted.map((i) => (
                    <li key={i.path}>
                      <a href={`#${anchor(i.path)}`}>Go to {i.item.label}</a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {view.rendered.sections.map((s) => (
              <section key={s.key} aria-labelledby={`s-${s.key}`} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <h2 id={`s-${s.key}`} className="wt-section">
                  {s.title}
                </h2>
                {s.items.map((i) => (
                  <Item
                    key={i.path}
                    item={i}
                    blobs={{ db, org, id: view.meta.id }}
                    myDevice={view.meta.deviceId}
                    waiting={view.pendingPaths.has(i.path)}
                    queued={view.queued}
                    onAnswer={(v) => void write(i.path, v)}
                    onPhotos={(files) => void onPhotos(i.path, files)}
                    onRemovePhoto={(h) => void onRemovePhoto(i.path, h)}
                    onSign={(png) => void onSign(i.path, png)}
                  />
                ))}
              </section>
            ))}
            {view.rendered.unknownFields.length > 0 && (
              <section className="wt-q wt-q-warn wt-offtpl" aria-labelledby="offtpl">
                <h2 id="offtpl" className="wt-q-label">
                  Answers to items not in version {view.rendered.templateVersion}
                </h2>
                <p className="wt-note">Kept, never dropped: another device wrote these against a different template version.</p>
                <ul className="wt-list">
                  {view.rendered.unknownFields.map((u) => (
                    <li key={u.path}>
                      {u.path}: {u.field.heads.map((h) => show(h.value)).join(' / ')}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="wt-q wt-finish" aria-labelledby="finish">
              <h2 id="finish">Finish</h2>
              {view.notReady.length > 0 ? (
                <ul className="wt-todo" aria-label="Before you can finish">
                  {view.notReady.map((n) => (
                    <li key={`${n.path}:${n.why}`}>
                      {n.label} {n.why === 'uploading' ? 'has a photo or signature waiting to upload' : WHY[n.why]}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="wt-s wt-s-ok" style={{ margin: 0 }}>
                  <span aria-hidden="true">✓ </span>Everything required is answered.
                </p>
              )}
              {reasons.length > 0 && (
                <ul className="wt-todo wt-alert" aria-label="The server says">
                  {reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <button type="button" className="wt-primary" onClick={() => void onFinish()} disabled={!canNet} aria-describedby={!canNet ? 'needs-net' : undefined}>
                Finish and make report
              </button>
              {!canNet && (
                <p id="needs-net" className="wt-note">
                  Finishing needs a connection: the server checks everything and builds the PDF.
                </p>
              )}
              {report && report.id === view.meta.id && (
                <a className="wt-fbtn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }} href={report.url} target="_blank" rel="noopener">
                  Open report {report.number} (PDF)
                </a>
              )}
            </section>
            <p className="wt-note">Everything you enter is saved on this phone first. It uploads on its own when you have signal.</p>
          </>
        )}
      </main>
    </div>
  );
}

/** An element id for an item path (paths are `items.<key>`, keys are lowercase letters, digits and dashes). */
const anchor = (path: string) => `q-${path.replace(/[^a-z0-9-]/g, '-')}`;

type BlobCtx = { db: IDBDatabase | null; org: string | null; id: string };

function Item({
  item: i,
  blobs,
  myDevice,
  waiting,
  queued,
  onAnswer,
  onPhotos,
  onRemovePhoto,
  onSign,
}: {
  item: RenderedItem;
  blobs: BlobCtx;
  myDevice: string;
  waiting: boolean;
  queued: ReadonlySet<string>;
  onAnswer: (v: Json) => void;
  onPhotos: (files: File[]) => void;
  onRemovePhoto: (hash: string) => void;
  onSign: (png: Uint8Array) => void;
}) {
  const it = i.item;
  const id = anchor(i.path);
  const req = it.required ? (
    <span className="wt-req">
      {' *'} required
    </span>
  ) : null;
  // Remount uncontrolled inputs when the merged value changes (a sync brought someone else's answer).
  const k = `${i.path}:${JSON.stringify(i.value)}`;
  const problem = rangeProblem(it, i.value);
  const saved = i.answered ? (
    <span className="wt-saved">
      {waiting ? (
        <>
          <span aria-hidden="true">◐ </span>Saved on this phone · waiting to sync
        </>
      ) : (
        <>
          <span aria-hidden="true">✓ </span>Saved and synced
        </>
      )}
    </span>
  ) : null;
  const unfit = !i.valid && !problem ? <p className="wt-err">✕ This answer does not fit this item.</p> : null;
  const resolve = i.conflict ? <Resolve item={i} myDevice={myDevice} blobs={blobs} onKeep={onAnswer} /> : null;
  const cls = `wt-q${i.conflict ? ' wt-q-warn' : ''}`;

  if (it.type === 'pass_fail_na') {
    return (
      <fieldset key={k} id={id} className={cls} data-path={i.path}>
        <legend className="wt-q-label">
          {it.label}
          {req}
        </legend>
        <div className="wt-seg">
          {PFN.map(([v, l, g]) => (
            <label key={v}>
              <input type="radio" name={i.path} value={v} defaultChecked={i.value === v} onChange={() => onAnswer(v)} />
              <span aria-hidden="true">{g}</span> {l}
            </label>
          ))}
        </div>
        {unfit}
        {saved}
        {resolve}
      </fieldset>
    );
  }
  if (it.type === 'number' || it.type === 'text') {
    const commit = (raw: string) => {
      const v: Json = raw === '' ? null : it.type === 'number' ? Number(raw) : raw;
      if (JSON.stringify(v) !== JSON.stringify(i.value) && !(typeof v === 'number' && Number.isNaN(v))) onAnswer(v);
    };
    const inputId = `${id}-in`;
    const hint = rangeText(it);
    const described = [hint && `${id}-hint`, problem && `${id}-err`].filter(Boolean).join(' ') || undefined;
    const common = {
      id: inputId,
      'aria-describedby': described,
      defaultValue: i.value === null ? '' : String(i.value),
      onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => commit(e.currentTarget.value),
    };
    return (
      <div id={id} className={cls} data-path={i.path}>
        <div>
          <label htmlFor={inputId} className="wt-q-label">
            {it.label}
            {req}
          </label>{' '}
          {hint && (
            <span id={`${id}-hint`} className="wt-hint">
              {hint}
            </span>
          )}
        </div>
        {it.type === 'number' ? (
          <input
            key={k}
            className="wt-num"
            type="number"
            step="any"
            inputMode="decimal"
            min={it.min}
            max={it.max}
            aria-invalid={problem ? true : undefined}
            {...common}
            onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
          />
        ) : (
          <textarea key={k} className="wt-text" maxLength={it.maxLength} {...common} />
        )}
        {problem && (
          <p id={`${id}-err`} className="wt-err">
            <span aria-hidden="true">✕ </span>
            {problem}
          </p>
        )}
        {unfit}
        {saved}
        {resolve}
      </div>
    );
  }
  if (it.type === 'photo') {
    const photos = refsIn(i.value);
    return (
      <fieldset id={id} className={cls} data-path={i.path}>
        <legend className="wt-q-label">
          {it.label}
          {req}
        </legend>
        {photos.length > 0 && (
          <ul aria-label={`Photos: ${it.label}`} className="wt-photos">
            {photos.map((h, n) => (
              <li key={h}>
                <BlobImage ctx={blobs} hash={h} alt={`${it.label}, photo ${n + 1}`} height={99} />
                <span className={`wt-photo-state wt-s-${queued.has(h) ? 'wait' : 'ok'}`}>
                  <span aria-hidden="true">{queued.has(h) ? '◐ ' : '✓ '}</span>
                  {queued.has(h) ? 'Waiting to upload' : 'Uploaded'}
                </span>
                <button type="button" className="wt-link-btn" onClick={() => onRemovePhoto(h)}>
                  Remove photo {n + 1}
                </button>
              </li>
            ))}
          </ul>
        )}
        {!photos.length && <span className="wt-note">No photo yet.</span>}
        <label className="wt-addphoto">
          {photos.length ? 'Add another photo' : 'Take or add a photo'}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            aria-label={`Add photo: ${it.label}`}
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = '';
              if (files.length) onPhotos(files);
            }}
          />
        </label>
        {photos.length > 0 && <span className="wt-note">Photos upload in pieces when you have signal. They stay on this phone either way.</span>}
        {unfit}
        {resolve}
      </fieldset>
    );
  }
  const sig = refsIn(i.value);
  return (
    <fieldset id={id} className={cls} data-path={i.path}>
      <legend className="wt-q-label">
        {it.label}
        {req}
      </legend>
      {sig.length > 0 && (
        <>
          <BlobImage ctx={blobs} hash={sig[0]!} alt={`Signature: ${it.label}`} height={80} className="wt-sigimg" />
          <span className={`wt-photo-state wt-s-${queued.has(sig[0]!) ? 'wait' : 'ok'}`}>
            <span aria-hidden="true">{queued.has(sig[0]!) ? '◐ ' : '✓ '}</span>
            {queued.has(sig[0]!) ? 'Signed · waiting to upload' : 'Signed · uploaded'}
          </span>
        </>
      )}
      <SignaturePad label={it.label} signed={i.value !== null} onSave={onSign} />
      {unfit}
      {resolve}
    </fieldset>
  );
}

/**
 * Pick one of the kept values, then confirm (Conflict artboard). Neither is chosen until the technician picks; the
 * keep writes that value as one op that supersedes every competing head (the same write the old "Keep" button made).
 */
function Resolve({ item: i, myDevice, blobs, onKeep }: { item: RenderedItem; myDevice: string; blobs: BlobCtx; onKeep: (v: Json) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = i.heads.find((h) => h.opId === picked) ?? null;
  return (
    <div role="group" aria-label={`Resolve ${i.item.label}`} className="wt-resolve">
      <strong>
        <span aria-hidden="true">◆ </span>
        {i.heads.length} values kept. Pick the one to keep.
      </strong>
      <span className="wt-note">Neither is chosen until you pick. The other value stays in the history.</span>
      {i.heads.map((h, n) => (
        <button key={h.opId} type="button" className="wt-pick" aria-pressed={picked === h.opId} onClick={() => setPicked(h.opId)}>
          <span className="wt-pick-v">{valueText(i.item, h.value)}</span>{' '}
          {(i.item.type === 'photo' || i.item.type === 'signature') && refsIn(h.value).length > 0 && (
            <span className="wt-thumbs" aria-hidden="true">
              {refsIn(h.value).map((r) => (
                <BlobImage key={r} ctx={blobs} hash={r} alt="" height={48} />
              ))}
            </span>
          )}
          <span className="wt-pick-who">
            Value {n + 1} · {h.deviceId === myDevice ? 'this device' : 'another device'}
            {h.offTemplate ? ` · written on template v${h.templateVersion}` : ''}
          </span>
        </button>
      ))}
      <button type="button" className="wt-primary" disabled={!chosen} onClick={() => chosen && onKeep(chosen.value)}>
        {chosen ? `Keep ${valueText(i.item, chosen.value)}` : 'Pick a value first'}
      </button>
    </div>
  );
}

/** Downscale a camera photo to at most 1600 px on its long side as a JPEG, on the device (D-31). */
async function prepareImage(file: File): Promise<{ bytes: Uint8Array; type: string }> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    if (blob) return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg' };
  } catch {
    /* not decodable here: keep the original bytes and type (the store refuses non-images) */
  }
  return { bytes: new Uint8Array(await file.arrayBuffer()), type: file.type };
}

/** A photo or signature from IndexedDB when this device has it (offline too), else from the server. */
function BlobImage({ ctx, hash, alt, height, className }: { ctx: BlobCtx; hash: string; alt: string; height: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    (async () => {
      const b = ctx.db ? await getBlob(ctx.db, hash) : undefined;
      if (!live) return;
      if (b) {
        url = URL.createObjectURL(new Blob([b.data as BlobPart], { type: b.type }));
        setSrc(url);
      } else if (ctx.org) setSrc(`/o/${encodeURIComponent(ctx.org)}/inspections/${ctx.id}/blobs/${hash}`);
    })();
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [ctx.db, ctx.org, ctx.id, hash]);
  if (!src) return alt ? <span className="wt-photo-missing">{alt} (not on this device yet)</span> : null;
  // eslint-disable-next-line @next/next/no-img-element -- a blob: URL from IndexedDB, not an optimizable asset
  return <img src={src} alt={alt} height={height} data-hash={hash} className={className} />;
}

const PAD_W = 480;
const PAD_H = 180;

/** A typed name drawn as a signature image: the same PNG answer a drawn one makes (owner reading: draw or type). */
export function typedSignaturePng(name: string): Promise<Uint8Array | null> {
  const c = document.createElement('canvas');
  c.width = PAD_W;
  c.height = PAD_H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, PAD_W, PAD_H);
  g.fillStyle = '#111';
  g.textBaseline = 'middle';
  let size = 56;
  const font = (n: number) => `italic ${n}px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive`;
  g.font = font(size);
  while (size > 18 && g.measureText(name).width > PAD_W - 40) g.font = font(--size);
  g.fillText(name, 20, PAD_H / 2);
  g.fillStyle = '#555';
  g.font = '14px system-ui, sans-serif';
  g.fillText('Typed by the signer', 20, PAD_H - 18);
  return new Promise((r) => c.toBlob(async (b) => r(b ? new Uint8Array(await b.arrayBuffer()) : null), 'image/png'));
}

/** Draw with a finger, stylus or mouse, or type a name; Save stores a PNG (white background) as the signature answer. */
function SignaturePad({ label, signed, onSave }: { label: string; signed: boolean; onSave: (png: Uint8Array) => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [open, setOpen] = useState(!signed);
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState('');
  const [inked, setInked] = useState(false);
  const clear = () => {
    const c = canvas.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    setInked(false);
  };
  useEffect(() => {
    if (open && !typing) clear();
  }, [open, typing]);
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height] as const;
  };
  if (!open)
    return (
      <button type="button" className="wt-fbtn wt-self-start" onClick={() => setOpen(true)}>
        Sign again
      </button>
    );
  if (typing)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label className="wt-field" style={{ fontWeight: 600 }}>
          Signer&rsquo;s full name
          <input className="wt-num" style={{ fontSize: 18, fontWeight: 400 }} value={name} onChange={(e) => setName(e.currentTarget.value)} autoComplete="name" maxLength={80} />
        </label>
        <span className="wt-note">The typed name is saved as the signature image, the same way a drawn one is.</span>
        <div className="wt-row-btns">
          <button
            type="button"
            className="wt-fbtn wt-fbtn-1"
            disabled={!name.trim()}
            onClick={async () => {
              const png = await typedSignaturePng(name.trim());
              if (png) {
                onSave(png);
                setOpen(false);
              }
            }}
          >
            Save signature
          </button>
          <button type="button" className="wt-link-btn" onClick={() => setTyping(false)}>
            Draw instead
          </button>
        </div>
      </div>
    );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="wt-sigwrap">
        <canvas
          ref={canvas}
          width={PAD_W}
          height={PAD_H}
          aria-label={`Signature pad: ${label}`}
          className="wt-sigpad"
          onPointerDown={(e) => {
            drawing.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            const g = e.currentTarget.getContext('2d')!;
            const [x, y] = at(e);
            g.lineWidth = 3;
            g.lineCap = 'round';
            g.strokeStyle = '#111';
            g.beginPath();
            g.moveTo(x, y);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const g = e.currentTarget.getContext('2d')!;
            const [x, y] = at(e);
            g.lineTo(x, y);
            g.stroke();
            setInked(true);
          }}
          onPointerUp={() => {
            drawing.current = false;
          }}
        />
        {!inked && <span aria-hidden="true">Sign here with a finger</span>}
      </div>
      <div className="wt-row-btns">
        <button
          type="button"
          className="wt-fbtn wt-fbtn-1"
          disabled={!inked}
          onClick={() =>
            canvas.current?.toBlob(async (b) => {
              if (!b) return;
              onSave(new Uint8Array(await b.arrayBuffer()));
              setOpen(false);
            }, 'image/png')
          }
        >
          Save signature
        </button>
        <button type="button" className="wt-fbtn" onClick={clear}>
          Clear
        </button>
        <button type="button" className="wt-link-btn" onClick={() => setTyping(true)}>
          Type name instead
        </button>
      </div>
    </div>
  );
}

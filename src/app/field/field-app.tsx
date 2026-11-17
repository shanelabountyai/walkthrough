'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { materialize, type Json } from '@/lib/sync';
import { answer, attachPhoto, fetchTransport, finish, loadReplica, removePhoto, sign, syncAll, syncInspection, uploadBlobs } from '@/lib/field/client';
import { countOutbox, countUploads, getBlob, getMeta, listInspections, openDb, setMeta, uploadsFor, type StoredInspection } from '@/lib/field/db';
import { refsIn } from '@/lib/walkthrough/blobs';
import { readiness, reportRefs, WHY, type NotReady } from '@/lib/walkthrough/readiness';
import { renderInspection, type RenderedInspection, type RenderedItem } from '@/lib/walkthrough/render';

// The field app (Phase 3). Everything on screen comes from IndexedDB; the network is used only to sync, and not at
// all while "Go offline" is on (the PRD's demo toggle). docs/walkthrough/PHASE3_PLAN.md.

const show = (v: Json) => (v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
const PFN: [string, string][] = [['pass', 'Pass'], ['fail', 'Fail'], ['na', 'N/A']];

export function FieldApp() {
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [org, setOrg] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [forcedOffline, setForcedOffline] = useState(false);
  const [list, setList] = useState<(StoredInspection & { pending: number; conflicts: number })[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<{ meta: StoredInspection; rendered: RenderedInspection; pending: number; uploads: number; notReady: NotReady[] } | null>(null);
  const [pending, setPending] = useState(0);
  const [uploads, setUploads] = useState(0);
  const [report, setReport] = useState<{ id: string; url: string; number: number } | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [status, setStatus] = useState('Starting…');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const syncing = useRef(false);
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
        setView({ meta: got.meta, rendered, pending: got.replica.outbox.size, uploads: queued.size, notReady });
      } else setView(null);
    } else setView(null);
  }, []);

  // Open the database, pick the org, register the service worker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const d = await openDb();
      if (cancelled) return;
      const fromUrl = new URLSearchParams(location.search).get('org');
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
  };

  const mode = !online ? 'Offline (no network)' : forcedOffline ? 'Offline (demo toggle)' : 'Online';
  return (
    <main>
      <header>
        <h1>Walkthrough</h1>
        <p>
          <strong data-testid="mode">{mode}</strong> · <span data-testid="pending">{pending} change{pending === 1 ? '' : 's'} waiting to sync</span> ·{' '}
          <span data-testid="uploads">{uploads} photo{uploads === 1 ? '' : 's'} waiting to upload</span>
          {lastSync && <> · last synced {lastSync.slice(11, 16)} UTC</>}
        </p>
        <p role="status">{status}</p>
        <button type="button" aria-pressed={forcedOffline} onClick={toggleOffline}>
          {forcedOffline ? 'Go online' : 'Go offline'}
        </button>{' '}
        <button type="button" onClick={() => void runSync()} disabled={!canNet || !org}>
          Sync now
        </button>
        {org && (
          <> · <a href={`/o/${encodeURIComponent(org)}/inspections`}>Back to {org}</a></>
        )}
      </header>

      {!view && (
        <section>
          <h2>Inspections on this device</h2>
          {!list.length && <p>None yet. They download the first time you open this page online.</p>}
          <ul>
            {list.map((i) => (
              <li key={i.id}>
                <button type="button" onClick={() => void open(i.id)}>
                  {i.title}
                </button>{' '}
                v{i.templateVersion}
                {i.pending > 0 && <> · {i.pending} waiting</>}
                {i.conflicts > 0 && <strong> · resolve ({i.conflicts})</strong>}
                {i.gone && <em> · no longer assigned to you</em>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view && (
        <section aria-label={view.meta.title}>
          <button type="button" onClick={() => void open(null)}>
            ← All inspections
          </button>
          <h2>{view.meta.title}</h2>
          <p>
            Template version {view.rendered.templateVersion} · {view.pending} waiting
            {view.uploads > 0 && <> · {view.uploads} photo{view.uploads === 1 ? '' : 's'} to upload</>}
            {view.rendered.conflicts.length > 0 && <strong> · Resolve: {view.rendered.conflicts.length}</strong>}
            {view.meta.truckroll && (
              <>
                {' '}· <a href={view.meta.truckroll} target="_blank" rel="noopener noreferrer">Open this day in Truckroll</a>
              </>
            )}
          </p>
          {view.rendered.sections.map((s) => (
            <section key={s.key}>
              <h3>{s.title}</h3>
              {s.items.map((i) => (
                <Item
                  key={i.path}
                  item={i}
                  blobs={{ db, org, id: view.meta.id }}
                  onAnswer={(v) => void write(i.path, v)}
                  onPhotos={(files) => void onPhotos(i.path, files)}
                  onRemovePhoto={(h) => void onRemovePhoto(i.path, h)}
                  onSign={(png) => void onSign(i.path, png)}
                />
              ))}
            </section>
          ))}
          <section aria-label="Finish">
            <h3>Finish</h3>
            {view.notReady.length > 0 ? (
              <ul aria-label="Before you can finish">
                {view.notReady.map((n) => (
                  <li key={`${n.path}:${n.why}`}>
                    {n.label} {n.why === 'uploading' ? 'has a photo or signature waiting to upload' : WHY[n.why]}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Everything required is answered.</p>
            )}
            {reasons.length > 0 && (
              <ul aria-label="The server says">
                {reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            <button type="button" onClick={() => void onFinish()} disabled={!canNet}>
              Finish and make report
            </button>
            {!canNet && <em> (needs a connection)</em>}
            {report && report.id === view.meta.id && (
              <>
                {' '}
                <a href={report.url} target="_blank" rel="noopener">
                  Open report {report.number} (PDF)
                </a>
              </>
            )}
          </section>
          {view.rendered.unknownFields.length > 0 && (
            <section>
              <h3>Answers to items not in version {view.rendered.templateVersion}</h3>
              <ul>
                {view.rendered.unknownFields.map((u) => (
                  <li key={u.path}>
                    {u.path}: {u.field.heads.map((h) => show(h.value)).join(' / ')}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </section>
      )}
    </main>
  );
}

type BlobCtx = { db: IDBDatabase | null; org: string | null; id: string };

function Item({
  item: i,
  blobs,
  onAnswer,
  onPhotos,
  onRemovePhoto,
  onSign,
}: {
  item: RenderedItem;
  blobs: BlobCtx;
  onAnswer: (v: Json) => void;
  onPhotos: (files: File[]) => void;
  onRemovePhoto: (hash: string) => void;
  onSign: (png: Uint8Array) => void;
}) {
  const it = i.item;
  const label = `${it.label}${it.required ? ' *' : ''}`;
  // Remount uncontrolled inputs when the merged value changes (a sync brought someone else's answer).
  const k = `${i.path}:${JSON.stringify(i.value)}`;
  let input: React.ReactNode;
  if (it.type === 'pass_fail_na') {
    input = (
      <fieldset key={k}>
        <legend>{label}</legend>
        {PFN.map(([v, l]) => (
          <label key={v}>
            <input type="radio" name={i.path} value={v} defaultChecked={i.value === v} onChange={() => onAnswer(v)} /> {l}
          </label>
        ))}
      </fieldset>
    );
  } else if (it.type === 'number' || it.type === 'text') {
    const commit = (raw: string) => {
      const v: Json = raw === '' ? null : it.type === 'number' ? Number(raw) : raw;
      if (JSON.stringify(v) !== JSON.stringify(i.value) && !(typeof v === 'number' && Number.isNaN(v))) onAnswer(v);
    };
    const common = {
      'aria-label': it.label,
      defaultValue: i.value === null ? '' : String(i.value),
      onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => commit(e.currentTarget.value),
    };
    input = (
      <label>
        {label}{' '}
        {it.type === 'number' ? (
          <input key={k} type="number" step="any" min={it.min} max={it.max} {...common} onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget.value)} />
        ) : (
          <textarea key={k} maxLength={it.maxLength} {...common} />
        )}
        {it.type === 'number' && it.unit && <> {it.unit}</>}
      </label>
    );
  } else if (it.type === 'photo') {
    const photos = refsIn(i.value);
    input = (
      <fieldset>
        <legend>{label}</legend>
        <ul aria-label={`Photos: ${it.label}`} style={{ listStyle: 'none', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {photos.map((h, n) => (
            <li key={h}>
              <BlobImage ctx={blobs} hash={h} alt={`${it.label}, photo ${n + 1}`} height={96} />
              <br />
              <button type="button" onClick={() => onRemovePhoto(h)}>
                Remove photo {n + 1}
              </button>
            </li>
          ))}
        </ul>
        <label>
          Add photo{' '}
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
      </fieldset>
    );
  } else {
    input = (
      <fieldset>
        <legend>{label}</legend>
        {refsIn(i.value).length > 0 && <BlobImage ctx={blobs} hash={refsIn(i.value)[0]!} alt={`Signature: ${it.label}`} height={80} />}
        <SignaturePad label={it.label} signed={i.value !== null} onSave={onSign} />
      </fieldset>
    );
  }
  return (
    <div data-path={i.path}>
      {input}
      {!i.valid && <em> does not fit this item</em>}
      {i.conflict && (
        <div role="group" aria-label={`Resolve ${it.label}`}>
          <strong>Conflicting answers:</strong>{' '}
          {i.heads.map((h) => (
            <button key={h.opId} type="button" onClick={() => onAnswer(h.value)}>
              Keep {show(h.value)}
              {h.offTemplate ? ` (v${h.templateVersion})` : ''}
            </button>
          ))}
        </div>
      )}
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
function BlobImage({ ctx, hash, alt, height }: { ctx: BlobCtx; hash: string; alt: string; height: number }) {
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
  // eslint-disable-next-line @next/next/no-img-element -- a blob: URL from IndexedDB, not an optimizable asset
  return src ? <img src={src} alt={alt} height={height} data-hash={hash} style={{ border: '1px solid #ccc', background: '#fff' }} /> : <span>{alt} (not on this device yet)</span>;
}

/** Draw with a finger, stylus or mouse; Save stores a PNG (white background) as the signature answer. */
function SignaturePad({ label, signed, onSave }: { label: string; signed: boolean; onSave: (png: Uint8Array) => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [open, setOpen] = useState(!signed);
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
    if (open) clear();
  }, [open]);
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height] as const;
  };
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Sign again
      </button>
    );
  return (
    <div>
      <canvas
        ref={canvas}
        width={480}
        height={180}
        aria-label={`Signature pad: ${label}`}
        style={{ width: '100%', maxWidth: 480, height: 'auto', border: '1px solid #888', touchAction: 'none', background: '#fff' }}
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
      <br />
      <button
        type="button"
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
      </button>{' '}
      <button type="button" onClick={clear}>
        Clear
      </button>
    </div>
  );
}

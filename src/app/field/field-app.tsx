'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { materialize, type Json } from '@/lib/sync';
import { answer, fetchTransport, loadReplica, syncAll, syncInspection } from '@/lib/field/client';
import { countOutbox, getMeta, listInspections, openDb, setMeta, type StoredInspection } from '@/lib/field/db';
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
  const [view, setView] = useState<{ meta: StoredInspection; rendered: RenderedInspection; pending: number } | null>(null);
  const [pending, setPending] = useState(0);
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
    if (id) {
      const got = await loadReplica(d, id);
      if (got) {
        const state = materialize(got.replica.log);
        setView({ meta: got.meta, rendered: renderInspection(got.meta.definition, got.meta.templateVersion, state), pending: got.replica.outbox.size });
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

  const write = async (path: string, value: Json) => {
    if (!db || !openId) return;
    await answer(db, openId, path, value);
    await refresh(db, openId);
    if (canNet) {
      const r = await syncInspection(db, fetchTransport, openId);
      if (r.ok) setStatus('Synced');
      await refresh(db, openId);
    }
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
          <strong data-testid="mode">{mode}</strong> · <span data-testid="pending">{pending} change{pending === 1 ? '' : 's'} waiting to sync</span>
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
            {view.rendered.conflicts.length > 0 && <strong> · Resolve: {view.rendered.conflicts.length}</strong>}
          </p>
          {view.rendered.sections.map((s) => (
            <section key={s.key}>
              <h3>{s.title}</h3>
              {s.items.map((i) => (
                <Item key={i.path} item={i} onAnswer={(v) => void write(i.path, v)} />
              ))}
            </section>
          ))}
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

function Item({ item: i, onAnswer }: { item: RenderedItem; onAnswer: (v: Json) => void }) {
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
  } else {
    input = (
      <p>
        {label}: {i.value === null ? 'not captured' : 'captured'} <em>(photo and signature capture arrive in Phase 4)</em>
      </p>
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

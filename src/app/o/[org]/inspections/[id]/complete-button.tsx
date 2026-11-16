'use client';
import { useState } from 'react';

// Completes the inspection through the report endpoint (same-origin JSON POST), then reloads the page to list the new
// report. The endpoint decides readiness; its reasons are shown as they come back.
export function CompleteButton({ org, id, label }: { org: string; id: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string[]>([]);
  const run = async () => {
    setBusy(true);
    setMsg([]);
    try {
      const res = await fetch(`/o/${encodeURIComponent(org)}/inspections/${id}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = (await res.json().catch(() => ({}))) as { notReady?: { message: string }[]; error?: string };
      if (res.ok) location.reload();
      else setMsg(body.notReady?.map((n) => n.message) ?? [`Could not generate the report (${body.error ?? res.status}).`]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button type="button" onClick={() => void run()} disabled={busy}>
        {label}
      </button>
      {msg.length > 0 && (
        <ul role="alert">
          {msg.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

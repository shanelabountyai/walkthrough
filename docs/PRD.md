# #29 Walkthrough — offline-first field inspection PWA

Status: **kickoff** (2026-11-13). Repo: `shanelabountyai/walkthrough` (public). Port 8200.
Base: saas-foundation v1.6.2 clone for the server side; the client is a PWA inside the same Next.js app.

**Why:** technicians work in basements, attics and rural Oklahoma with no signal. Walkthrough lets them run an
inspection checklist, take photos and capture a customer signature fully offline, then sync without losing or
silently overwriting anyone's work. It is the tech-side companion to Truckroll (#24).

**Scope v1:**
- **Templates:** admin builds checklist templates (sections, items: pass/fail/NA, number with range, text, photo
  required, signature). Templates are versioned; an inspection pins the version it started on.
- **Offline client:** installable PWA; service worker caches the app shell; IndexedDB stores inspections,
  answers and photo blobs; works from first open after one online sync.
- **Sync engine:** an append-only operation log per inspection (op id, device id, Lamport clock, field path,
  value). Server merges logs; per-field last-writer-wins by (Lamport, device id) with **conflicts surfaced**, not
  hidden: if two devices edit the same field, both values are kept and the inspection shows a "resolve" badge.
  Photos upload in chunks, resumable, content-hashed (dedupe).
- **Report:** completed inspection → PDF with photos and signature, stored and linked.
- **Demo:** a "go offline" toggle in the UI plus Playwright tests that drive the browser offline.

**Out of scope:** native apps, CRDT library adoption (hand-built op log is the learning point — D-02), real-time
co-editing, video.

**Invariants:** WT-01 no acknowledged op is ever lost across any order of sync; WT-02 the same set of ops merges
to the same state on any device in any order (convergence, property-tested); WT-03 a concurrent edit to one field
produces a visible conflict, never a silent overwrite; WT-04 an inspection always renders against its pinned
template version; WT-05 a technician reads only inspections assigned to them.

**Phases:** 1 pure sync engine (op log, merge, conflict detection) with property tests → 2 schema, templates,
server sync endpoint → 3 PWA client (service worker, IndexedDB, offline Playwright tests) → 4 photos, signature,
PDF report, Truckroll link-out.

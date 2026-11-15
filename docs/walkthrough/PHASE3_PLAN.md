# Walkthrough — Phase 3 plan: the PWA client

Branch `phase-3`, one PR to `main` (never merged by Claude). Scope is the PRD's Phase 3 line: **PWA client
(service worker, IndexedDB, offline Playwright tests)**, plus the PRD's "go offline" demo toggle that those tests
drive. Owner choice (2026-11-15): **hand-written** service worker and raw IndexedDB, no new runtime dependencies.
Not in scope (Phase 4): photo and signature capture, photo blobs in IndexedDB, chunked upload, PDF report,
Truckroll link-out. Photo and signature items render read-only with "Phase 4" in the field app.

The Phase 1 engine (`src/lib/sync/`) runs in the browser unchanged: the device is a `Replica` whose log, outbox,
clock and seq live in IndexedDB. The Phase 2 endpoint (`/o/[org]/inspections/[id]/sync`) is the only server it talks to.

## Pieces

| piece | where | what |
|---|---|---|
| App shell | `src/app/field/page.tsx` | A static page (`// public:` — it holds no data; every byte of data comes from the guarded endpoints). Client component `FieldApp` does everything from IndexedDB. Linked from the org nav as "Field app" (`/field?org=<slug>`) |
| Service worker | `public/sw.js` | Hand-written. Install: cache `/field`, the manifest, the icon, and every `/_next/static/` URL in the shell's HTML. Fetch: `/field` network-first (3 s) falling back to the cache; `/_next/static/` cache-first (hashed names); **everything else goes to the network untouched** — no org page, API or sync response is ever cached. The page also posts the URLs of the assets it actually loaded, so lazily loaded chunks are cached too |
| Manifest | `public/manifest.webmanifest`, `public/icon-*.png` | `start_url: /field`, standalone, so the app is installable |
| Feed endpoint | `src/app/o/[org]/inspections/feed/route.ts` | `GET`: the inspections this user may see (WT-05, Phase 2's `visibleTo`) plus `userId`, for the list |
| IndexedDB store | `src/lib/field/db.ts` | Raw IndexedDB, database `walkthrough`, stores `inspections`, `ops`, `outbox`, `meta`. One promise helper over `IDBRequest`; no library |
| Client sync | `src/lib/field/client.ts` | `answer` (engine `localSet`, then op + outbox entry + clock + seq written in **one** IndexedDB transaction), `download`, `syncInspection` (push the outbox with the cursor, drop only acked ops, receive the pulled ops), `refreshList`, `syncAll` |
| Field UI | `src/app/field/field-app.tsx` | Online/offline status, **"Go offline" toggle** (the app makes no network call while it is on), pending count, inspection list, the inspection form rendered with Phase 2's `renderInspection` against the pinned version, a resolve control on conflicting fields |

## Invariants carried to the device

- **WT-01 on the device:** an op exists in IndexedDB before it is shown as answered, and its outbox entry is removed
  only when the server's response lists it in `acked`. A device's `seq` is persisted in the same transaction as the
  op it numbered, so a reload can never mint a second op under an existing opId.
- **WT-02/03:** the device renders `materialize` of its own log; two devices that synced the same ops show the same
  state, and a conflict shows every head with a resolve control. Resolving writes one `set` that supersedes all heads.
- **WT-04:** the form renders the pinned version's definition that came with the download; answers to unknown items
  stay listed.
- **WT-05:** the feed and the sync endpoint are guarded server-side (Phase 2); the client holds only what they returned.

## Acceptance items → tests

| # | Acceptance item | Proved by |
|---|---|---|
| B1 | The client store keeps ops, outbox, clock and seq across a reopen; a reload never reuses an opId | `tests/field/client.unit.test.ts` (fake-indexeddb, dev only) |
| B2 | Sync drops only acked ops; a refused or failed push keeps the outbox; a lost response is retried idempotently | `client.unit.test.ts` against an in-memory server replica |
| B3 | The service worker caches only the shell and static assets, never org pages, APIs or sync responses | `tests/field/sw.unit.test.ts` (runs `public/sw.js` against a fake `self`/`caches`) |
| B4 | Installable: manifest served with `start_url /field`, SW registered and controlling | `e2e/field-offline.spec.ts` |
| B5 | Works from first open after one online sync: offline reload shows the shell and the downloaded inspection | `e2e/field-offline.spec.ts` with `context.setOffline(true)` |
| B6 | Answers made offline survive an offline reload and sync on reconnect; the server then holds them | `e2e/field-offline.spec.ts` |
| B7 | Two devices answering one field offline → both show the conflict after syncing; resolving on one clears it on both | `e2e/field-offline.spec.ts` (two browser contexts) |
| B8 | The "Go offline" toggle stops all network calls from the app; turning it off syncs | `e2e/field-offline.spec.ts` (request log) |

## Gate

`npm run lint`, `npm run typecheck`, full `vitest` (both RLS modes locally), Playwright including the offline specs,
`foundation:drift`, `foundation:check-modules`; GitHub CI green. Then stop; Phase 4 is not started.

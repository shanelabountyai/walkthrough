# #29 Walkthrough — offline-first field inspection PWA — decisions

Made by Claude on 2026-11-13 while Shane was away. Each is a default he can change.

| ID | Problem | Options | Decision | Change it |
|---|---|---|---|---|
| D-01 | Base | foundation clone, standalone | **foundation** — auth, orgs, roles, audit log | — |
| D-02 | Merge model | hand-built op log + LWW with visible conflicts, Yjs/Automerge CRDT | **hand-built** — it's the capability being shown; documented swap path to a CRDT | adopt a CRDT in Phase 5 |
| D-03 | Photo storage | Postgres bytea, object storage (Vercel Blob / S3) | **object storage behind an interface**, local disk adapter in dev | — |
| D-04 | Name / number | Walkthrough, #29 | as stated | rename before repo creation |
| D-0B | Foundation billing module | keep, remove via `check-modules` | **remove** — nothing here is sold as a subscription; other modules kept (Holdout needs `apikeys` for ingest) | merge the module back |

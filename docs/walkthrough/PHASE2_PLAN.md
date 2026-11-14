# Walkthrough — Phase 2 plan: schema, templates, server sync endpoint

Branch `phase-2`, one PR to `main` (never merged by Claude). Scope is exactly the PRD's Phase 2 line:
**schema, templates, server sync endpoint**. Not in scope (Phase 3+): service worker, IndexedDB, the installable
PWA, offline Playwright tests, an answer-editing UI, photo/signature upload, PDF report, Truckroll link-out.

The Phase 1 engine (`src/lib/sync/`) is reused unchanged: the server endpoint is a Postgres-backed server replica
that calls `serverAccept`, `createInspection`, `materialize` and `pinnedTemplate`. Owner decision **D-15** is
binding: the server writes the one `pin` op when it creates the inspection; a device pin is rejected.

## Model (Prisma, `prisma/schema/walkthrough.prisma`, clone-owned)

| model | purpose |
|---|---|
| `ChecklistTemplate` | a named template in an org |
| `TemplateVersion` | one published, **immutable** definition (`version` 1, 2, …; `@@unique([templateId, version])`). A DB trigger refuses `UPDATE` (WT-04) |
| `Inspection` | an inspection: template + pinned version (copied from the server pin op), title, `assigneeId` (the technician), server Lamport `clock`, receive counter `opSeq`, cached `conflictPaths` for list badges |
| `InspectionOp` | one row per op, append-only (`UPDATE` refused by trigger), `@@unique([inspectionId, opId])`, `seq` = server receive order (the pull cursor), `userId` = who pushed it |
| `SyncDevice` | a device id (client-minted uuid) bound to the first user who pushed from it in this org |

Every table has `orgId`, so RLS policies are regenerated with `npm run rls:policies` (INV-30), rows are seeded for
INV-29 and the action harness in `tests/fixtures/app.ts`, and every table is in `src/app/export-hooks.ts` (INV-34).

## Templates

Definition (zod, `src/lib/walkthrough/template.ts`): `sections[] → items[]`; item types `pass_fail_na`,
`number` (optional `min`/`max`/`unit`), `text` (`maxLength`), `photo`, `signature`, each with `required`. Item keys
are unique across the template; an item's answer lives at op path `items.<key>`. Admins (owner/admin) create a
template and publish new versions from a JSON definition; every publish is a new immutable version (D-17).

## Server sync endpoint

`/o/[org]/inspections/[id]/sync` (route handler, session cookie, `requireOrg` first):

- `GET ?since=n` — download: inspection header, the pinned template version's definition, ops with `seq > n`, cursor.
- `POST {deviceId, ops, since}` — push then pull, in one transaction holding a row lock on the inspection:
  validate shape → device binding → every op is this device's own `set` op for this inspection → the engine's
  `serverAccept` (D-15 pin rejection, `LogIntegrityError`) → insert new ops with the next `seq` → update clock,
  `opSeq`, `conflictPaths`. Response `{acked, ops (seq > since), cursor, conflicts}`. Any refusal refuses the whole
  batch and stores nothing (no partial ack). Same-origin and `application/json` required.
- Access (WT-05): assignee or manager (owner/admin); anyone else gets the same 404 as a nonexistent id.

Rendering (WT-04, `src/lib/walkthrough/render.ts`, pure): the inspection page and the GET payload use the
**pinned** version's definition only. Fields for paths not in that version, and off-template answers, stay visible
and badged (D-14), never dropped.

## Acceptance items → tests

| # | Acceptance item | Proved by |
|---|---|---|
| A1 | Schema migrates; every org table has RLS, fixtures and an export decision | CI `prisma migrate deploy`; INV-29/30 (enforce leg run locally), INV-34, action harness INV-01..04/22 over the new actions |
| A2 | Template definitions validate (types, ranges, unique keys) | `tests/walkthrough/template.unit.test.ts` |
| A3 | Publishing creates version n+1; published versions can't change | `templates.int.test.ts` (versioning, trigger refuses UPDATE) |
| A4 | Creating an inspection writes the server pin (D-15) as op seq 1; the inspection keeps that version when the template moves on (WT-04) | `inspections.int.test.ts` |
| A5 | Sync endpoint: push acks exactly what is durable; retry is idempotent; pull returns ops after the cursor | `sync.int.test.ts` |
| A6 | Device pin, forged/foreign ops, opId reuse with different content, unbound device → whole batch refused, nothing stored | `sync.int.test.ts` |
| A7 | WT-01/02/03 hold through the real endpoint and Postgres: random multi-device scenarios with lost acks, duplicates and reordering | `sync.db.property.test.ts` (fast-check, seed 29, `FC_DB_RUNS` default 40) |
| A8 | WT-04 render uses the pinned version; stale-client answers stay visible and badged | `render.unit.test.ts`, `inspections.int.test.ts` |
| A9 | WT-05: a technician reads/syncs only inspections assigned to them; others get the nonexistent-id 404 | `access.int.test.ts` |
| A10 | Op log is append-only in the database | `sync.int.test.ts` (trigger refuses UPDATE) |

## Gate

`npm run lint`, `npm run typecheck`, full `vitest` (unit, property at the fixed seed and 3 random seeds for the
DB property, invariants), `foundation:drift`; GitHub CI green (lint, typecheck, migrate, vitest, Playwright,
`modules-removed`). Then stop; Phase 3 is not started.

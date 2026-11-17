# Walkthrough — Phase 4 plan: photos, signature, PDF report, Truckroll link-out

Branch `phase-4`, one PR to `main` (never merged by Claude). Scope is the PRD's Phase 4 line: **photos, signature,
PDF report, Truckroll link-out**, plus the PRD sentences those name:

- *Offline client:* "IndexedDB stores inspections, answers **and photo blobs**".
- *Sync engine:* "Photos upload **in chunks, resumable, content-hashed (dedupe)**".
- *Report:* "completed inspection → **PDF with photos and signature, stored and linked**".
- *Why:* "take photos and capture a customer signature **fully offline**, then sync without losing … anyone's work".
- Truckroll (#24) is the dispatch side; the link-out is a link built from data Walkthrough already holds. Truckroll is
  read only to match its URLs (`/o/[org]/dispatch?date=YYYY-MM-DD`, which sends a technician on to
  `/dispatch/my-day?date=…`; days are America/Chicago, Truckroll D-27). Nothing in Truckroll changes.

Binding: D-15 (server pin), D-18 (photo/signature answers are `sha256:<hex>` references), D-23 (hand-written client,
no new client runtime dependencies), D-24..D-29 (field app shell, cache policy, sync triggers). D-03: photo storage is
object storage behind an interface with a local disk adapter in dev.

Not in scope: video, image editing/annotation, a production object-storage adapter that needs credentials (owner hand
step), pruning photo blobs from the device, a re-pin/re-key UI, live LLM calls (none are needed in this phase).

Decisions made while building: D-30..D-38 in `DECISIONS.md`.

## Pieces

| piece | where | what |
|---|---|---|
| Answer refs | `src/lib/walkthrough/blobs.ts` (pure) | `refsIn(value)`: the `sha256:` hashes an answer names; `sniff(bytes)`: jpeg/png/webp/pdf by magic bytes; limits (15 MB blob, 256 KB chunk) |
| Blob store | `src/lib/walkthrough/blob-store.ts` | Interface `BlobStore { append, read, remove, removeOrg }`, disk adapter under `uploads/blobs/<orgId>/` (gitignored). Refuses on a deployed environment until an object-storage adapter exists (D-30) |
| Server blobs | `StoredBlob` model; `src/lib/walkthrough/uploads.ts` | Per-org content-addressed rows (`orgId, hash` unique): size, type, bytes received, complete. Upload = chunk at `offset`; completion verifies sha256 and magic bytes; dedupe = a complete row is never re-uploaded |
| Blob endpoint | `src/app/o/[org]/inspections/[id]/blobs/[hash]/route.ts` | `GET ?status` → `{state, received}`; `GET` → bytes (complete only, `nosniff`); `POST` (same-origin, `application/octet-stream`, `x-upload-offset`, `x-upload-length`, `x-blob-type`) → append one chunk. Only for an inspection the user can see (WT-05) and a hash a `set` op in **that** inspection's log names (so ops sync first and nothing unreferenced is stored) |
| Device blobs | `src/lib/field/db.ts` v2, `src/lib/field/client.ts` | New stores `blobs` (hash → bytes, type) and `uploads` ([inspectionId, hash] → pending). `attachPhoto` / `removePhoto` / `sign`: blob + upload entry + op + outbox + clock/seq in **one** transaction. `syncInspection` pushes ops, then uploads each pending blob in 256 KB chunks from the server's `received` (resumable), dropping the upload entry only when the server says complete |
| Field UI | `src/app/field/field-app.tsx` | Photo items: camera/file input, downscale to ≤1600 px JPEG on the device, thumbnails from IndexedDB, remove. Signature items: a pointer-drawn canvas, Save/Clear, the saved image. "N photos waiting to upload". Finish: local readiness + "Finish and make report" (online), then "Open report" |
| Report | `InspectionReport` model, `src/lib/walkthrough/readiness.ts`, `report.ts` | `readiness(rendered, blobStates)` (pure, dependency-free, also used by the field app): no conflicts, required items answered, answers valid, every referenced blob uploaded. `buildPdf(…)` with `pdf-lib`: header, every section and answer, photos and signature embedded, footer with report number and op cursor. Stored in the blob store (content-hashed) with an append-only `InspectionReport` row; the inspection is marked completed |
| Report endpoint | `src/app/o/[org]/inspections/[id]/report/route.ts` | `POST` (same-origin JSON) → generate (409 with reasons when not ready; returns the latest report unchanged when nothing changed since it); `GET [?n=]` → the PDF. Assignee or manager (WT-05) |
| Truckroll link | `src/lib/walkthrough/truckroll.ts` (pure) | `truckrollLink(slug, at)` → `${TRUCKROLL_URL}/o/<slug>/dispatch?date=<Chicago day of the inspection>`. On the inspection page, in the field app (sent in the download header) and in the PDF |
| Org page | `src/app/o/[org]/inspections/[id]/page.tsx` | Photos and signature shown, readiness, "Complete and generate report", the reports list, the Truckroll link |

Invariants carried: **WT-01** a photo or signature answer is an op like any other (never lost; the blob is on the
device before the op exists, and leaves the upload queue only when the server holds all of it); **WT-02/03** a
photo list is one field value, so two devices adding photos concurrently is a visible conflict, never a silent drop;
**WT-04** the report renders the pinned version; **WT-05** blobs and reports are reachable only through an inspection
the user can see.

## Acceptance items → tests

| # | Acceptance item | Proved by |
|---|---|---|
| C1 | Answer refs, magic-byte sniffing, chunk limits | `tests/walkthrough/blobs.unit.test.ts` |
| C2 | Chunked upload: resumable after an interruption (status reports `received`, a wrong offset is refused with the right one), sha256 verified at the end (mismatch → refused, nothing kept), declared type must match the bytes | `tests/walkthrough/blobs.int.test.ts` |
| C3 | Dedupe: the same bytes for a second inspection are already complete, no bytes re-sent | `blobs.int.test.ts` |
| C4 | WT-05 for blobs: an unassigned technician, another org and an unreferenced hash all get 404; nothing stored | `blobs.int.test.ts` |
| C5 | Device: photo/signature capture writes blob + op + outbox atomically, survives a reopen; sync pushes ops then uploads; an interrupted upload resumes from the server's count; a v1 database upgrades with its data | `tests/field/client.unit.test.ts` |
| C6 | **Offline photo + signature capture syncing after reconnect** in a real browser: captured offline, survive an offline reload, then the ops and the blobs (byte-identical, by hash) reach the server | `e2e/field-photos.spec.ts` (`context.setOffline`) |
| C7 | Report readiness (conflict, missing required, invalid, blob not uploaded) | `tests/walkthrough/report.unit.test.ts` |
| C8 | The PDF holds every section, answer, photo and the signature; it is a valid PDF (re-parsed with pdf-lib) | `report.unit.test.ts` |
| C9 | Report endpoint: not ready → 409 with reasons; ready → stored and linked, inspection completed; unchanged → same report; changed → report n+1; report rows are append-only; WT-05 404 | `tests/walkthrough/report.int.test.ts` |
| C10 | Truckroll link: URL shape matches Truckroll's routes; the day is the Chicago calendar day | `tests/walkthrough/truckroll.unit.test.ts`; href checked in `e2e/field-photos.spec.ts` |
| C11 | New tables: RLS (INV-29/30), fixtures, export decision (INV-34), org delete removes the org's blobs | existing invariant suites over the new models; `blobs.int.test.ts` |
| C12 | Finish in the browser: the report link serves `application/pdf` | `e2e/field-photos.spec.ts` |

## Gate

`npm run lint`, `npm run typecheck`, full `vitest` (unit, property, invariants, integration), Playwright including
every offline spec (`field-offline.spec.ts`, `field-photos.spec.ts`), `foundation:drift`; GitHub CI green (`ci` and
`modules-removed`). The PRD names no extra Phase 4 gate. Then stop.

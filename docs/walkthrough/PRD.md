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

## Design, UX and accessibility requirements

Added 2026-11-18 by the design pass (docs/design/RUN.md; Claude, owner away). The look is the Claude Design canvas
exported to `docs/design/*.dc.html` (owner calls in `docs/design/HANDOFF.md`). Each requirement is testable; the
finding that produced it is in brackets (D = design review, U = UX review, A = accessibility review, 2026-11-18).

- **DX-01** Every status on screen is a word first; a glyph and a colour only repeat it (pass ✓, fail ✕, N/A –, needs
  resolving ◆, waiting ○/◐). An out-of-range number says why in words ("140 is above the allowed range (0–100 ppm)").
  Test: `tests/walkthrough/answers.unit.test.ts`.
- **DX-02** While an answer is in conflict, no value is shown as chosen: no pass/fail/N/A tile is checked and the number
  or text box is empty, until the technician picks a kept value and confirms "Keep <value>". [D must-fix 1, U 4, A 4]
  Test: `e2e/field-offline.spec.ts` B7 (both choices unpressed, "Pick a value first" disabled, then pick and keep).
- **DX-03** Answering, keeping a conflict value, switching the signature between draw and type, and saving a signature
  never move keyboard focus to the top of the page. [A must-fix 1–3] Test: `e2e/design-pass.spec.ts`.
- **DX-04** The customer signature can be drawn or typed; a typed name becomes the same signature image and goes through
  the same binding, upload and report path (owner reading, D-49). Test: `e2e/design-pass.spec.ts`.
- **DX-05** A refused template form keeps what the admin typed (name and definition). [U must-fix 1]
  Test: `e2e/design-pass.spec.ts`.
- **DX-06** A technician who opens a template page is told in plain words that templates are for managers, with a way
  back; never the error page. [U must-fix 2] Test: `tests/walkthrough/design-pass.int.test.ts`.
- **DX-07** Every page passes axe (WCAG 2.0/2.1 A and AA rules) at 390 px and 1280 px, works at 390 px without
  horizontal scrolling, and field-app controls are at least 44 px tall. Test: run by the accessibility review with
  `@axe-core/playwright` on every page (results in the design-pass PR); not yet in CI, because adding the dev
  dependency needs the owner (D-57).
- **DX-08** The finish checklist is not repeated: the server's reasons are shown only where they add to the device's own
  list. [U 5]

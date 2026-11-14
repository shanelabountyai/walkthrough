# Walkthrough — Phase 1 plan: the pure sync engine

Branch `kickoff`, PR #1 (never merged by Claude). Scope is the engine only: no Prisma, no routes, no UI.
Everything under `src/lib/sync/` is pure TypeScript with no I/O, so Phase 2 (server endpoint) and Phase 3
(IndexedDB client) both call the same functions.

## Model

**Op** (append-only, immutable once created):

| field | meaning |
|---|---|
| `opId` | `${deviceId}:${seq}` — unique, minted by the device |
| `deviceId` | the device that wrote it |
| `inspectionId` | the log it belongs to (one log per inspection) |
| `lamport` | Lamport clock at write time |
| `kind` | `set` (write a field), `pin` (pin the template version) |
| `path` | field path, e.g. `items.roof-01.answer` (`set` only) |
| `value` | JSON value (`set` only) |
| `prev` | opIds of the values for `path` this device could see when it wrote — what the write supersedes |
| `templateVersion` | the template version the device was rendering when it wrote |

**Lamport clock.** `tick(c) = c + 1` on every local write; `observe(c, remote) = max(c, remote)` on
receive, so the next local write is strictly greater than anything seen. Total order for LWW is
`(lamport, deviceId, opId)`.

**Log merge.** A log is a set of ops keyed by `opId`. `mergeLogs` is set union, so it is commutative,
associative and idempotent by construction. The same `opId` with different content is an integrity error
(thrown), never silently replaced — that is how WT-01 holds even against a buggy client.

**Materialize** (log → state), per path:
- *heads* = `set` ops for the path that no other op's `prev` names (nobody wrote over them having seen them).
- *winner* = the head with the greatest `(lamport, deviceId, opId)` — the displayed value (LWW).
- *conflict* = more than one distinct head value. All head values are kept on the field, sorted by the same
  order, and the inspection carries a `conflicts` list (the "resolve" badge). A resolution is just a new `set`
  whose `prev` covers all heads — it supersedes them and the conflict clears everywhere it syncs.

`prev` is what separates "B saw A's answer and changed it" (no conflict, a deliberate overwrite) from
"A and B both answered offline" (conflict). Lamport order alone cannot tell those apart; it only picks
the displayed winner.

**Template-version pinning.** The first `pin` op by total order fixes the inspection's template version,
regardless of arrival order. `set` ops written against another version stay in the log (never lost) but
are excluded from the state and listed as `offTemplate`, so the inspection always renders against the
pinned version (WT-04, enforced in Phase 2/3 rendering; the engine provides the data).

**Device / server simulation** (`device.ts`): `localSet`, `push` (returns ops the server acknowledged),
`pull`. Ack = the server's log contains the op; a device may drop its outbox entry only after the ack.

## Files

- `src/lib/sync/types.ts` — `Op`, `Log`, `State`, `Conflict`
- `src/lib/sync/clock.ts` — Lamport tick/observe, total order comparator
- `src/lib/sync/log.ts` — `appendOp`, `mergeLogs`, integrity check
- `src/lib/sync/merge.ts` — `materialize` (heads, LWW winner, conflicts, pin, off-template ops)
- `src/lib/sync/device.ts` — device + server replicas for the engine and the tests
- `src/lib/sync/index.ts` — public surface
- `tests/sync/*.test.ts` — unit tests and fast-check property tests (picked up by the existing vitest config)

## Property tests (fast-check, seeded)

A generator builds random *scenarios*: 2–4 devices, 1–6 field paths, 1–40 steps drawn from local edits,
pushes, pulls, dropped/duplicated/reordered deliveries and template pins.

- **WT-01** — after any scenario, every op the server ever acknowledged is in the server log and, after one
  final full sync, in every device's log; `mergeLogs(a, b) ⊇ a ∪ b` for any logs.
- **WT-02** — the op set from a scenario, delivered to fresh replicas in many random permutations and batch
  splits, materializes to identical state; `mergeLogs` is commutative, associative, idempotent.
- **WT-03** — for every path, every head value appears in the state (no value nobody has seen is ever
  hidden); two devices editing the same field offline with different values always yields a conflict
  holding both; an edit made after seeing the other value is a clean overwrite.

Seeds: `FC_SEED` (default fixed seed `29`) and `FC_RUNS` (default 2000 runs per property). Gate: all green
at the fixed seed and at 3 random seeds, run counts reported in the PR body. Then stop — Phase 2 is not started.

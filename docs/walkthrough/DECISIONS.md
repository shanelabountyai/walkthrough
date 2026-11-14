# #29 Walkthrough — offline-first field inspection PWA — decisions

Made by Claude on 2026-11-13 while Shane was away. Each is a default he can change.

| ID | Problem | Options | Decision | Change it |
|---|---|---|---|---|
| D-01 | Base | foundation clone, standalone | **foundation** — auth, orgs, roles, audit log | — |
| D-02 | Merge model | hand-built op log + LWW with visible conflicts, Yjs/Automerge CRDT | **hand-built** — it's the capability being shown; documented swap path to a CRDT | adopt a CRDT in Phase 5 |
| D-03 | Photo storage | Postgres bytea, object storage (Vercel Blob / S3) | **object storage behind an interface**, local disk adapter in dev | — |
| D-04 | Name / number | Walkthrough, #29 | as stated | rename before repo creation |
| D-0B | Foundation billing module | keep, remove via `check-modules` | **remove** — nothing here is sold as a subscription; other modules kept (Holdout needs `apikeys` for ingest) | merge the module back |
| D-05 | Local Postgres 17 in the build sandbox (apt.postgresql.org blocked by the egress proxy) | use the image's Postgres 16; Postgres 17 binaries from npm (`@embedded-postgres/linux-x64`); stop | **npm-packaged Postgres 17.11**, sandbox only — nothing in the repo depends on it; CI uses the `postgres:17` service as before | run `npm run db:setup` against Homebrew `postgresql@17` locally |
| D-06 | `prisma generate` / `migrate deploy` can't fetch engines in the sandbox (binaries.prisma.sh 403), so `db:setup` stopped after creating the databases | hand-apply migration SQL with psql; stop Phase 0; let GitHub Actions be the Phase 0 gate | **GitHub Actions CI on `main` is the Phase 0 gate** (it runs lint, typecheck, migrate, vitest, Playwright and check-modules with real network); Phase 1's sync tests are pure and run locally without Prisma | run `npm run db:setup && npm run seed:demo` on your machine |
| D-07 | Make `main` the default branch: the session has no allowed tool for repo settings (`gh` is search-only here) | change it via the API anyway; leave it | **leave it for Shane** — listed under "For Shane" in PR #1 | Settings → Branches → default branch = `main` |
| D-08 | Billing removal leaves `beforeOrgDelete` with an unused `orgId` (lint warning, not error) | edit `org-hooks.ts` now; leave the template's own removal output | **leave as the manifest produces it** — `org-hooks.ts` is clone-owned, so Phase 2 can add Walkthrough's own hook there | edit `src/app/org-hooks.ts` |
| D-13 | Phase 0 CI run 1 failed: template test `tests/unit/foundation-tools.test.ts` (rls:policies F-09) expects every manifest module's tables, so it breaks in any clone that removes a module | restore billing; skip the test; make it compare against modules still present | **compare against present modules** — `tests/unit` is not template-owned, so drift stays clean; the guard check itself is unchanged. Upstream bug to report in saas-foundation | revert the edit once the template ships a removal-aware version |
